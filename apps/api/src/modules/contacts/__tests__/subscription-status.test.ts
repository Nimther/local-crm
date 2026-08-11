import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

/**
 * 3-state subscription status + suppression compliance (SUBS-01, D-08, D-11,
 * D-12): default status on create, suppression-list override on re-create
 * after delete, asymmetric manual status editing, and suppression-list
 * persistence on delete. Mirrors the sign-up + create-workspace harness from
 * sendgrid-key-connect.test.ts.
 */
describe("Contact subscription status & suppression (SUBS-01)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function signUp(email: string, password: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email, password, name },
    });
    expect(res.statusCode, `sign-up failed: ${res.body}`).toBe(200);
    const sessionCookie = res.cookies.find((c) => c.name.toLowerCase().includes("session"));
    if (!sessionCookie) {
      throw new Error("sign-up response did not set a session cookie");
    }
    return { cookie: `${sessionCookie.name}=${sessionCookie.value}` };
  }

  async function createWorkspace(cookie: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie },
      payload: { name },
    });
    expect(res.statusCode, `create workspace failed: ${res.body}`).toBe(200);
    return res.json<{ id: string; slug: string; name: string }>();
  }

  async function owner(nameSeed: string) {
    const email = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", nameSeed);
    const workspace = await createWorkspace(account.cookie, `${nameSeed} Co`);
    return { ...account, workspace };
  }

  function contactsUrl(slug: string, id?: string) {
    return id ? `/api/workspaces/${slug}/contacts/${id}` : `/api/workspaces/${slug}/contacts`;
  }

  async function createContact(cookie: string, slug: string, payload: Record<string, unknown>) {
    const res = await app.inject({
      method: "POST",
      url: contactsUrl(slug),
      headers: { cookie },
      payload,
    });
    expect(res.statusCode, `create failed: ${res.body}`).toBe(201);
    return res.json<{ id: string; subscriptionStatus: string; email: string }>();
  }

  it("D-11: a freshly created contact whose email is NOT suppressed defaults to subscribed", async () => {
    const { cookie, workspace } = await owner("subs-default");
    const contact = await createContact(cookie, workspace.slug, {
      email: `default-status-${Date.now()}@example.com`,
    });
    expect(contact.subscriptionStatus).toBe("subscribed");
  });

  it("D-08/D-11: re-creating an email that was left unsubscribed/suppressed at delete time yields suppressed, never subscribed", async () => {
    const { cookie, workspace } = await owner("subs-suppression-override");
    const email = `resurrect-${Date.now()}@example.com`;

    const first = await createContact(cookie, workspace.slug, { email });
    // Manually move to unsubscribed before deleting, so the D-08 suppression
    // write triggers on delete.
    const unsubRes = await app.inject({
      method: "PATCH",
      url: contactsUrl(workspace.slug, first.id),
      headers: { cookie },
      payload: { subscriptionStatus: "unsubscribed" },
    });
    expect(unsubRes.statusCode, `unsubscribe failed: ${unsubRes.body}`).toBe(200);

    const deleteRes = await app.inject({
      method: "DELETE",
      url: contactsUrl(workspace.slug, first.id),
      headers: { cookie },
    });
    expect(deleteRes.statusCode, `delete failed: ${deleteRes.body}`).toBe(200);

    const recreated = await createContact(cookie, workspace.slug, { email });
    expect(recreated.subscriptionStatus).toBe("suppressed");
  });

  it("D-12: subscribed <-> unsubscribed transitions succeed via update", async () => {
    const { cookie, workspace } = await owner("subs-asymmetric-toggle");
    const contact = await createContact(cookie, workspace.slug, {
      email: `toggle-${Date.now()}@example.com`,
    });

    const toUnsub = await app.inject({
      method: "PATCH",
      url: contactsUrl(workspace.slug, contact.id),
      headers: { cookie },
      payload: { subscriptionStatus: "unsubscribed" },
    });
    expect(toUnsub.statusCode, `subscribed->unsubscribed failed: ${toUnsub.body}`).toBe(200);
    expect(toUnsub.json().subscriptionStatus).toBe("unsubscribed");

    const toSub = await app.inject({
      method: "PATCH",
      url: contactsUrl(workspace.slug, contact.id),
      headers: { cookie },
      payload: { subscriptionStatus: "subscribed" },
    });
    expect(toSub.statusCode, `unsubscribed->subscribed failed: ${toSub.body}`).toBe(200);
    expect(toSub.json().subscriptionStatus).toBe("subscribed");
  });

  it("D-12: a suppressed contact cannot be moved to subscribed via the ordinary update path", async () => {
    const { cookie, workspace } = await owner("subs-suppressed-locked");
    const email = `locked-${Date.now()}@example.com`;

    // Drive a contact into suppressed via the D-08/D-11 delete-then-recreate path.
    const first = await createContact(cookie, workspace.slug, { email });
    await app.inject({
      method: "PATCH",
      url: contactsUrl(workspace.slug, first.id),
      headers: { cookie },
      payload: { subscriptionStatus: "unsubscribed" },
    });
    await app.inject({
      method: "DELETE",
      url: contactsUrl(workspace.slug, first.id),
      headers: { cookie },
    });
    const suppressed = await createContact(cookie, workspace.slug, { email });
    expect(suppressed.subscriptionStatus).toBe("suppressed");

    const attempt = await app.inject({
      method: "PATCH",
      url: contactsUrl(workspace.slug, suppressed.id),
      headers: { cookie },
      payload: { subscriptionStatus: "subscribed" },
    });
    expect([409, 422]).toContain(attempt.statusCode);

    const getRes = await app.inject({
      method: "GET",
      url: contactsUrl(workspace.slug, suppressed.id),
      headers: { cookie },
    });
    expect(getRes.json().subscriptionStatus).toBe("suppressed");
  });

  it("D-08: deleting an unsubscribed contact writes its email to the workspace suppression list", async () => {
    const { cookie, workspace } = await owner("subs-delete-writes-suppression");
    const email = `suppress-on-delete-${Date.now()}@example.com`;

    const contact = await createContact(cookie, workspace.slug, { email });
    await app.inject({
      method: "PATCH",
      url: contactsUrl(workspace.slug, contact.id),
      headers: { cookie },
      payload: { subscriptionStatus: "unsubscribed" },
    });
    await app.inject({
      method: "DELETE",
      url: contactsUrl(workspace.slug, contact.id),
      headers: { cookie },
    });

    // Re-creating the same email is the observable proxy for "is this email
    // now in workspace_suppressions" (asserted via D-08/D-11 above). CMP-04
    // (plan 13-10) made the suppression write unconditional on every
    // erasure -- the sibling test below proves the SAME outcome for a
    // contact that was still subscribed at delete time, which pre-13-10
    // did NOT suppress.
    const recreated = await createContact(cookie, workspace.slug, { email });
    expect(recreated.subscriptionStatus).toBe("suppressed");
  });

  it("CMP-04 (D-02, plan 13-12): a suppression survives a letter-case change -- re-creating the SHOUTED-CASE form of a deleted address still yields suppressed", async () => {
    const { cookie, workspace } = await owner("subs-suppression-case");
    const email = `Case-Sensitive-${Date.now()}@example.com`;

    const first = await createContact(cookie, workspace.slug, { email });
    await app.inject({
      method: "PATCH",
      url: contactsUrl(workspace.slug, first.id),
      headers: { cookie },
      payload: { subscriptionStatus: "unsubscribed" },
    });
    await app.inject({
      method: "DELETE",
      url: contactsUrl(workspace.slug, first.id),
      headers: { cookie },
    });

    // A different letter case than the address originally suppressed --
    // normalizeSuppressionEmail must make these match, or the hash-based
    // suppression check would let this slip past.
    const shouted = email.toUpperCase();
    expect(shouted).not.toBe(email);
    const recreated = await createContact(cookie, workspace.slug, { email: shouted });
    expect(recreated.subscriptionStatus).toBe("suppressed");
  });

  it("CMP-04 (plan 13-10, Codex BLOCKER finding 1): deleting a still-subscribed contact ALSO suppresses its email -- erasure must not weaken suppression", async () => {
    // Pre-13-10 this contact recreated as "subscribed" (the suppression
    // insert was gated on the pre-erasure status, so a still-subscribed
    // contact left NO suppression row). CMP-04 removed that gate: 13-CONTEXT.md
    // states "Erasure must not weaken suppression: the deleted person's
    // address must remain unmailable" -- an erased address is suppressed
    // regardless of the status it held, so re-creating it now yields
    // "suppressed", the same outcome an unsubscribed-at-delete-time contact
    // already produced.
    const { cookie, workspace } = await owner("subs-delete-subscribed-no-suppress");
    const email = `still-subscribed-${Date.now()}@example.com`;

    const contact = await createContact(cookie, workspace.slug, { email });
    expect(contact.subscriptionStatus).toBe("subscribed");

    await app.inject({
      method: "DELETE",
      url: contactsUrl(workspace.slug, contact.id),
      headers: { cookie },
    });

    const recreated = await createContact(cookie, workspace.slug, { email });
    expect(recreated.subscriptionStatus).toBe("suppressed");
  });
});
