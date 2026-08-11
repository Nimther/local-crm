import { randomUUID } from "node:crypto";

import { describe, expect, test } from "vitest";

import { CENSOR, REDACTION_RULES } from "../rules.js";
import { scrub } from "../scrub.js";

/**
 * Phase 10 debug (aggregate-coverage-run-fails) — the `phone` valueRule must
 * not eat v4 UUIDs.
 *
 * `valueRules` are applied to EVERY string value regardless of its key, which
 * is the point: freeform webhook/event payloads use tenant-chosen key names.
 * The cost is that a pattern which is loose enough to catch `+1 415-555-0199`
 * is also loose enough to catch a UUID, because a UUID's hex groups are 62.5%
 * digits and `-` is one of the pattern's own accepted separators.
 *
 * The rule's comment already records one round of this: an earlier version
 * matched "7+ digit-ish characters" and was caught by
 * webhook-events-sibling-drop.test.ts's Test 4. Widening the floor to the
 * E.164 10-15 digit range reduced the false-positive rate but did NOT remove
 * it — measured at ~4% of `randomUUID()` values, which is why that same Test 4
 * kept failing intermittently: `owningWorkspaceId` came back `[REDACTED]`
 * whenever the fixture's workspace id happened to contain a long enough digit
 * run (e.g. `b2cd545e-6853-418e-a436-2d4658232825`, whose tail holds ten
 * consecutive digits).
 *
 * A 4%-per-run failure in a mandatory gate is not a flaky test — it is this
 * rule reporting a real defect at a low duty cycle. And the defect is a
 * production one, not a test one: SEC-09/WR-01's whole contract is that the
 * sibling-drop signal carries workspace ids, so redacting them destroys the
 * only diagnostic the signal exists to emit.
 *
 * The fix anchors the pattern between non-alphanumeric, non-hyphen boundaries.
 * In a canonical UUID every digit run is preceded by a hex letter or a `-`, so
 * there is no legal start position at all — the false positive is eliminated by
 * construction rather than made rarer.
 */

/**
 * UUIDs observed matching the pre-fix pattern. Kept as literals, not
 * regenerated, so this test fails deterministically on a regression instead of
 * ~4% of the time.
 */
const UUIDS_THAT_MATCHED_THE_OLD_PATTERN = [
  "b2cd545e-6853-418e-a436-2d4658232825",
  "19d95d88-2146-4308-9afc-cdf226a8cfc0",
  "70cacf22-7767-4368-9699-aa895674acfb",
  "68ae1ae6-096b-4943-8b28-988221443521",
  "fc805039-6260-4b25-8cdf-b7991ef87741",
];

function phoneRule(): RegExp {
  const rule = REDACTION_RULES.valueRules.find((candidate) => candidate.name === "phone");
  if (!rule) throw new Error("the `phone` valueRule is gone — this suite is asserting nothing");
  return rule.pattern;
}

describe("scrub: identifiers must survive the phone valueRule", () => {
  test("Test 1: a v4 UUID that matched the pre-fix pattern passes through untouched, under a key that matches no rule", () => {
    for (const uuid of UUIDS_THAT_MATCHED_THE_OLD_PATTERN) {
      const output = scrub({ owningWorkspaceId: uuid }) as Record<string, unknown>;
      expect(output.owningWorkspaceId).toBe(uuid);
    }
  });

  test("Test 2: the exact SEC-09/WR-01 drop signal keeps both workspace ids readable", () => {
    const receivingWorkspaceId = "b2cd545e-6853-418e-a436-2d4658232825";
    const owningWorkspaceId = "68ae1ae6-096b-4943-8b28-988221443521";

    const output = scrub({ receivingWorkspaceId, owningWorkspaceId, count: 1 }) as Record<
      string,
      unknown
    >;

    expect(output.receivingWorkspaceId).toBe(receivingWorkspaceId);
    expect(output.owningWorkspaceId).toBe(owningWorkspaceId);
    expect(output.count).toBe(1);
  });

  test("Test 3: no generated v4 UUID is redacted -- the pre-fix rate was ~4%, so this sampled at 5000 fails on any regression", () => {
    const redacted: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const uuid = randomUUID();
      if ((scrub({ id: uuid }) as Record<string, unknown>).id !== uuid) redacted.push(uuid);
    }
    expect(redacted).toEqual([]);
  });

  test("Test 4: a UUID embedded in a freeform message is still readable", () => {
    const message = "dropped 68ae1ae6-096b-4943-8b28-988221443521 for a sibling workspace";
    const output = scrub({ note: message }) as Record<string, unknown>;
    expect(output.note).toBe(message);
  });

  test("Test 5 (unchanged protection): every realistic phone format is still redacted", () => {
    const phones = [
      "+14155550199",
      "+1 415-555-0199",
      "(415) 555-0199",
      "415-555-0199",
      "4155550199",
      "+7 (999) 123-45-67",
      "+442071838750",
      "tel:+1-415-555-0199",
      "call 415-555-0199 now",
      "phone is (212) 555-1234.",
    ];
    for (const phone of phones) {
      const output = scrub({ reachAt: phone }) as Record<string, unknown>;
      expect(output.reachAt, `expected ${phone} to be redacted`).toBe(CENSOR);
    }
  });

  test("Test 6 (boundary neighbours): the digit-count floor stays at 10, and long digit runs stay covered", () => {
    const pattern = phoneRule();
    // Below the E.164 floor: 9 digits is not a phone number and never was.
    expect(pattern.test("1".repeat(9))).toBe(false);
    // At and above the floor.
    expect(pattern.test("1".repeat(10))).toBe(true);
    expect(pattern.test("1".repeat(15))).toBe(true);
    // A 16-digit run (a card number is the realistic case) must NOT slip
    // through: the pre-fix pattern only caught it by starting mid-run, which
    // the new boundary forbids, so the upper bound has to be open-ended.
    expect(pattern.test("1".repeat(16))).toBe(true);
    expect(pattern.test("1".repeat(19))).toBe(true);
  });

  test("Test 7: the phone rule never matches anywhere inside a canonical UUID, at any start position", () => {
    const pattern = phoneRule();
    for (const uuid of UUIDS_THAT_MATCHED_THE_OLD_PATTERN) {
      expect(pattern.test(uuid), `expected no phone match in ${uuid}`).toBe(false);
    }
  });
});
