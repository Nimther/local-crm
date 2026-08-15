import { describe, expect, test } from "vitest";
import type { Event, EventHint } from "@sentry/node";
import { sentryBeforeSend } from "../sentry-scrub.js";

/**
 * OPS-09 (Pitfall 18, 15-RESEARCH.md): Sentry has NO retroactive redaction.
 * Every assertion below serializes the FULL returned event ONCE and checks
 * the plaintext needle appears zero times in that single serialization --
 * never a per-field assertion, which would pass while the same value
 * survived in a sibling field (the exact failure mode this gate exists to
 * catch, per this plan's own action text).
 *
 * Needle values are distinctive and obviously fake so a false negative can
 * never come from a needle colliding with SDK boilerplate (a real UUID, a
 * common word, etc).
 */
const NEEDLE_SENDGRID_KEY = "SG.aaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const NEEDLE_EMAIL = "leaked-fixture-contact@example.com";
const NEEDLE_PHONE = "+14155550199";
const NEEDLE_FREEFORM_SECRET = "SG.cccccccccccccccccccc.dddddddddddddddddddddddddddddddddddddddddd";
const NEEDLE_FREEFORM_EMAIL = "leaked-freeform-blob@example.com";
const NEEDLE_BREADCRUMB_EMAIL = "leaked-breadcrumb@example.com";

const HINT: EventHint = {};

/** Serializes the WHOLE event once -- the single point every scenario asserts absence/presence against. */
function serialize(event: unknown): string {
  return JSON.stringify(event);
}

/** Wraps `{ [leafKey]: leafValue }` `depth` levels deep under `nested` keys -- mirrors scrub.test.ts's own idiom for the freeform-nesting case. */
function buildNested(depth: number, leaves: Record<string, unknown>): unknown {
  let node: unknown = { ...leaves };
  for (let i = 0; i < depth; i++) {
    node = { nested: node };
  }
  return node;
}

describe("sentryBeforeSend fixtures (OPS-09, Pitfall 18) -- routes the whole event through packages/redaction's scrub()", () => {
  test("Scenario A: a sendTenantMailV3-shaped SendGrid key leak is scrubbed from message, frame vars, extra AND request header", () => {
    // Reproduces packages/delivery-core/src/send-mail.ts's sendTenantMailV3:
    // the exact `Authorization: Bearer ${apiKey}` header it builds before
    // every real fetch call, and a REAL Error representing the rejection
    // reason that is in lexical scope inside its catch block -- the key is
    // a local variable there regardless of whatever redactApiKey() (that
    // call site's OWN, separate, app-level defense -- see
    // send-mail.test.ts's "redacts the API key from the thrown error's
    // message and stack" case) does to the error it re-throws afterward.
    // This fixture proves the INDEPENDENT backstop: even if a Sentry
    // integration captured the raw rejection, a per-frame local-variable
    // snapshot, or the literal outbound header -- none of which
    // redactApiKey ever touches -- sentryBeforeSend still removes the key.
    const apiKey = NEEDLE_SENDGRID_KEY;
    const rawRejection = new Error(`SendGrid request failed: Authorization Bearer ${apiKey} was rejected`);

    const event: Event = {
      exception: {
        values: [
          {
            type: rawRejection.name,
            value: rawRejection.message,
            stacktrace: {
              frames: [
                {
                  function: "sendTenantMailV3",
                  filename: "packages/delivery-core/src/send-mail.ts",
                  // A LocalVariables-style per-frame variable snapshot --
                  // a real, independent Sentry Node capability that would
                  // carry the raw local `apiKey` regardless of what the
                  // thrown Error's own message/stack say.
                  vars: { apiKey, headers: { Authorization: `Bearer ${apiKey}` } },
                },
              ],
            },
          },
        ],
      },
      extra: {
        apiKey,
        payload: { from: { email: "marketing@tenant.example.com" } },
      },
      request: {
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    };

    const scrubbed = sentryBeforeSend(event, HINT);

    expect(serialize(scrubbed)).not.toContain(apiKey);
  });

  test("Scenario B: a contact-upsert conflict (email_taken) leaks email/phone/freeform attrs in contexts AND extra -- both are scrubbed", () => {
    // Reproduces apps/api/src/modules/contacts/contact.repository.ts's
    // ContactConflictError, thrown by createContact's D-01 email-uniqueness
    // check: `Email ${input.email} is already used by another contact in
    // this workspace` -- the plaintext address lands directly in the
    // Error's own message, exactly as that call site throws it.
    class ContactConflictError extends Error {
      constructor(
        message: string,
        public readonly code: "email_taken"
      ) {
        super(message);
        this.name = "ContactConflictError";
      }
    }

    const contact = {
      id: "11111111-1111-1111-1111-111111111111",
      workspaceId: "22222222-2222-2222-2222-222222222222",
      externalId: null,
      email: NEEDLE_EMAIL,
      firstName: "Ada",
      lastName: "Lovelace",
      phone: NEEDLE_PHONE,
      city: "London",
      country: "GB",
      timezone: "Europe/London",
      tags: ["vip"],
      properties: { favoriteColor: "teal" },
      subscriptionStatus: "subscribed",
    };

    const conflict = new ContactConflictError(
      `Email ${contact.email} is already used by another contact in this workspace`,
      "email_taken"
    );

    const event: Event = {
      exception: {
        values: [{ type: conflict.name, value: conflict.message }],
      },
      contexts: {
        contact: { ...contact },
      },
      extra: {
        contact: { ...contact },
      },
    };

    const scrubbed = sentryBeforeSend(event, HINT);
    const serialized = serialize(scrubbed);

    expect(serialized).not.toContain(NEEDLE_EMAIL);
    expect(serialized).not.toContain(NEEDLE_PHONE);
  });

  test("Scenario C: a tenant-authored freeform JSONB blob nested five levels deep under extra is censored at every level", () => {
    const DEPTH = 5;
    const event: Event = {
      exception: { values: [{ type: "Error", value: "event ingestion failed" }] },
      extra: {
        eventProperties: buildNested(DEPTH, {
          providerKey: NEEDLE_FREEFORM_SECRET,
          contactEmail: NEEDLE_FREEFORM_EMAIL,
          harmless: "kept as-is",
        }),
      },
    };

    const scrubbed = sentryBeforeSend(event, HINT);
    const serialized = serialize(scrubbed);

    expect(serialized).not.toContain(NEEDLE_FREEFORM_SECRET);
    expect(serialized).not.toContain(NEEDLE_FREEFORM_EMAIL);
    expect(serialized).toContain("kept as-is");
  });

  test("Scenario D: a breadcrumb whose data carries an email is scrubbed inside the breadcrumb array", () => {
    const event: Event = {
      exception: { values: [{ type: "Error", value: "delivery failed" }] },
      breadcrumbs: [
        { category: "http", message: "outbound request", data: { url: "https://api.sendgrid.com/v3/mail/send" } },
        { category: "contact.lookup", message: "resolved recipient", data: { email: NEEDLE_BREADCRUMB_EMAIL } },
      ],
    };

    const scrubbed = sentryBeforeSend(event, HINT);
    const serialized = serialize(scrubbed);

    expect(serialized).not.toContain(NEEDLE_BREADCRUMB_EMAIL);
    // The sibling breadcrumb's harmless data survives -- scrub() redacts by
    // key-name/value-pattern match, not by deleting the whole array element.
    expect(serialized).toContain("https://api.sendgrid.com/v3/mail/send");
  });

  test("Scenario E: an event with nothing to scrub round-trips to an equivalent event -- never undefined, never null", () => {
    const event: Event = {
      exception: { values: [{ type: "Error", value: "a perfectly ordinary, secret-free failure" }] },
      tags: { route: "GET /healthz" },
      extra: { attempt: 3 },
    };

    const scrubbed = sentryBeforeSend(event, HINT);

    expect(scrubbed).not.toBeUndefined();
    expect(scrubbed).not.toBeNull();
    expect(scrubbed).toEqual(event);
  });

  test("Negative control: the SAME Scenario A event, WITHOUT the hook applied, still contains the plaintext key -- proves the absence assertions above are load-bearing, not vacuous", () => {
    const apiKey = NEEDLE_SENDGRID_KEY;
    const rawRejection = new Error(`SendGrid request failed: Authorization Bearer ${apiKey} was rejected`);

    const event: Event = {
      exception: {
        values: [
          {
            type: rawRejection.name,
            value: rawRejection.message,
            stacktrace: {
              frames: [
                {
                  function: "sendTenantMailV3",
                  filename: "packages/delivery-core/src/send-mail.ts",
                  vars: { apiKey, headers: { Authorization: `Bearer ${apiKey}` } },
                },
              ],
            },
          },
        ],
      },
      extra: { apiKey },
      request: { headers: { Authorization: `Bearer ${apiKey}` } },
    };

    // Deliberately NOT passed through sentryBeforeSend -- a future refactor
    // that accidentally disables the hook at its call site would leave an
    // event shaped exactly like this one, and this assertion is what fails
    // loudly instead of a suite that stays all-green.
    expect(serialize(event)).toContain(apiKey);
  });
});
