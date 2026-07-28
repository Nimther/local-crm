import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { evaluatePreSendGate } from "../pre-send-gate.js";
import { dispatchSendGate } from "../send-ledger.js";
import { getWorkspaceSendSettings } from "../send-settings.js";

/** Stubs a PoolClient whose `query()` returns each of `responses` in order (one per call). */
function stubClient(responses: Array<Record<string, unknown>[]>): PoolClient {
  let call = 0;
  // eslint-disable-next-line @typescript-eslint/require-await -- test double: the signature must match the async function it replaces at the DI seam; a stub having nothing to await is the point
  const query = vi.fn(async () => {
    const rows = responses[call] ?? [];
    call += 1;
    return { rows };
  });
  return { query } as unknown as PoolClient;
}

describe("evaluatePreSendGate (SUBS-03/SEND-04/D-04/D-14)", () => {
  it("returns 'suppressed' for a suppressed contact without touching the DB", async () => {
    const client = stubClient([]);
    const decision = await evaluatePreSendGate(client, {
      workspaceId: "ws-1",
      contact: { id: "c-1", email: "a@example.com", subscriptionStatus: "suppressed" },
    });
    expect(decision).toEqual({ sendable: false, reason: "suppressed" });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- asserting that a mocked method was never called requires referencing it unbound; there is no `this` to lose because it is a vi.fn, not a real PoolClient method
    expect(client.query as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("returns 'unsubscribed' for an unsubscribed contact", async () => {
    const client = stubClient([]);
    const decision = await evaluatePreSendGate(client, {
      workspaceId: "ws-1",
      contact: { id: "c-1", email: "a@example.com", subscriptionStatus: "unsubscribed" },
    });
    expect(decision).toEqual({ sendable: false, reason: "unsubscribed" });
  });

  it("returns 'no_email' for a subscribed contact with no email on file", async () => {
    const client = stubClient([]);
    const decision = await evaluatePreSendGate(client, {
      workspaceId: "ws-1",
      contact: { id: "c-1", email: null, subscriptionStatus: "subscribed" },
    });
    expect(decision).toEqual({ sendable: false, reason: "no_email" });
  });

  it("returns 'frequency_cap' (skip, not defer -- D-14) when the sent count meets the cap", async () => {
    const client = stubClient([
      [{ frequencyCap: 3, frequencyWindowHours: 24, rpsLimit: null }],
      [{ count: "3" }],
    ]);
    const decision = await evaluatePreSendGate(client, {
      workspaceId: "ws-1",
      contact: { id: "c-1", email: "a@example.com", subscriptionStatus: "subscribed" },
    });
    expect(decision).toEqual({ sendable: false, reason: "frequency_cap" });
  });

  it("returns sendable:true on the happy path (subscribed, has email, under the cap)", async () => {
    const client = stubClient([
      [{ frequencyCap: 3, frequencyWindowHours: 24, rpsLimit: null }],
      [{ count: "1" }],
    ]);
    const decision = await evaluatePreSendGate(client, {
      workspaceId: "ws-1",
      contact: { id: "c-1", email: "a@example.com", subscriptionStatus: "subscribed" },
    });
    expect(decision).toEqual({ sendable: true });
  });

  it("the frequency-cap query filters on status='sent' and a rolling interval derived from workspace_send_settings", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ frequencyCap: 5, frequencyWindowHours: 48, rpsLimit: null }] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] });
    const client = { query } as unknown as PoolClient;

    await evaluatePreSendGate(client, {
      workspaceId: "ws-1",
      contact: { id: "c-1", email: "a@example.com", subscriptionStatus: "subscribed" },
    });

    const [sql, params] = query.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain("status = 'sent'");
    expect(sql).toContain("hours')::interval");
    expect(params).toEqual(["ws-1", "c-1", 48]);
  });
});

describe("getWorkspaceSendSettings (D-13 defaults)", () => {
  it("returns the 3/24/null defaults (plus 06-07's unset timezone/quiet-hours defaults) when no settings row exists", async () => {
    const client = stubClient([[]]);
    const settings = await getWorkspaceSendSettings(client, "ws-1");
    expect(settings).toEqual({
      frequencyCap: 3,
      frequencyWindowHours: 24,
      rpsLimit: null,
      defaultTimezone: null,
      quietHoursStart: null,
      quietHoursEnd: null,
      quietHoursEnabled: false,
    });
  });

  it("returns the persisted row when one exists", async () => {
    const client = stubClient([
      [
        {
          frequencyCap: 10,
          frequencyWindowHours: 12,
          rpsLimit: 5,
          defaultTimezone: "America/New_York",
          quietHoursStart: 21 * 60,
          quietHoursEnd: 8 * 60,
          quietHoursEnabled: true,
        },
      ],
    ]);
    const settings = await getWorkspaceSendSettings(client, "ws-1");
    expect(settings).toEqual({
      frequencyCap: 10,
      frequencyWindowHours: 12,
      rpsLimit: 5,
      defaultTimezone: "America/New_York",
      quietHoursStart: 21 * 60,
      quietHoursEnd: 8 * 60,
      quietHoursEnabled: true,
    });
  });
});

describe("dispatchSendGate idempotency (SEND-06)", () => {
  it("returns the sendId to proceed on a fresh insert", async () => {
    const client = stubClient([[{ id: "send-2" }]]);
    const result = await dispatchSendGate(client, {
      workspaceId: "ws-1",
      campaignId: "camp-1",
      contactId: "c-2",
    });
    expect(result).toEqual({ sendId: "send-2" });
  });

  it("returns 'skipped' when the existing row (FOR UPDATE) is already status='sent'", async () => {
    const client = stubClient([[], [{ id: "send-1", status: "sent" }]]);
    const result = await dispatchSendGate(client, {
      workspaceId: "ws-1",
      campaignId: "camp-1",
      contactId: "c-1",
    });
    expect(result).toBe("skipped");
  });

  it("returns 'skipped' when the existing row (FOR UPDATE) is already status='failed'", async () => {
    const client = stubClient([[], [{ id: "send-4", status: "failed" }]]);
    const result = await dispatchSendGate(client, {
      workspaceId: "ws-1",
      campaignId: "camp-1",
      contactId: "c-4",
    });
    expect(result).toBe("skipped");
  });

  it("returns 'skipped' when the existing row (FOR UPDATE) is already status='excluded'", async () => {
    const client = stubClient([[], [{ id: "send-5", status: "excluded" }]]);
    const result = await dispatchSendGate(client, {
      workspaceId: "ws-1",
      campaignId: "camp-1",
      contactId: "c-5",
    });
    expect(result).toBe("skipped");
  });

  it("CR-04: returns { sendId, interrupted: true } when the existing row is still 'dispatching' -- a prior attempt committed the claim and never finished, so the caller must NOT re-call SendGrid", async () => {
    const client = stubClient([[], [{ id: "send-3", status: "dispatching" }]]);
    const result = await dispatchSendGate(client, {
      workspaceId: "ws-1",
      campaignId: "camp-1",
      contactId: "c-3",
    });
    expect(result).toEqual({ sendId: "send-3", interrupted: true });
  });
});
