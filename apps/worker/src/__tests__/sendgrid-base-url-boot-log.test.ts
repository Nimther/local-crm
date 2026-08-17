import { afterEach, describe, expect, it, vi } from "vitest";
import { logSendgridBaseUrlOverrideIfActive } from "../server.js";

/**
 * Phase 16 (D-06/D-07): the worker's boot-time announcement for the
 * `SENDGRID_BASE_URL` override -- factored out of `buildWorker()` (same
 * testability reasoning as `attachSharedListeners`/`closeWorkerRuntime` in
 * this file) so this can be exercised directly, against an injected logger
 * double, instead of constructing all twenty production BullMQ workers.
 * D-07 explicitly rejected a production guard/throw here (the UAT itself
 * runs on the production VPS) -- these tests assert `logger.warn` is the
 * ONLY effect, never a thrown error.
 */
describe("logSendgridBaseUrlOverrideIfActive (Phase 16, D-06/D-07)", () => {
  const originalOverride = process.env.SENDGRID_BASE_URL;

  afterEach(() => {
    if (originalOverride === undefined) {
      delete process.env.SENDGRID_BASE_URL;
    } else {
      process.env.SENDGRID_BASE_URL = originalOverride;
    }
  });

  it("with the override unset, emits no warning", () => {
    delete process.env.SENDGRID_BASE_URL;
    const warn = vi.fn();
    expect(() => logSendgridBaseUrlOverrideIfActive({ warn })).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("with the override set to an empty string, emits no warning", () => {
    process.env.SENDGRID_BASE_URL = "";
    const warn = vi.fn();
    expect(() => logSendgridBaseUrlOverrideIfActive({ warn })).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("with the override set to a URL, emits exactly one warning naming the value and does not throw", () => {
    process.env.SENDGRID_BASE_URL = "http://127.0.0.1:9999/fault-proxy/mail/send";
    const warn = vi.fn();
    expect(() => logSendgridBaseUrlOverrideIfActive({ warn })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    const [context, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(context.sendgridBaseUrlOverride).toBe("http://127.0.0.1:9999/fault-proxy/mail/send");
    expect(message).toContain("SENDGRID_BASE_URL");
  });
});
