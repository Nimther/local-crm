import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { classifyTransportError } from "../transport-classify.js";

/**
 * Phase 11, D-10, DLV-06 -- every `<behavior>` item from 11-05-PLAN.md's
 * Task 1, plus the acceptance criteria's explicit `cause`-unwrapping case.
 */
describe("classifyTransportError (D-10 fail-closed transport classification)", () => {
  it("classifies ENOTFOUND as pre_connection_retryable", () => {
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND api.sendgrid.com"), { code: "ENOTFOUND" });
    expect(classifyTransportError(err)).toBe("pre_connection_retryable");
  });

  it("classifies EAI_AGAIN as pre_connection_retryable", () => {
    const err = Object.assign(new Error("getaddrinfo EAI_AGAIN api.sendgrid.com"), { code: "EAI_AGAIN" });
    expect(classifyTransportError(err)).toBe("pre_connection_retryable");
  });

  it("classifies ECONNREFUSED as pre_connection_retryable", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" });
    expect(classifyTransportError(err)).toBe("pre_connection_retryable");
  });

  it("classifies ECONNRESET as ambiguous -- a connection was established, then torn down mid-flight", () => {
    const err = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(classifyTransportError(err)).toBe("ambiguous");
  });

  it("classifies name: AbortError as ambiguous", () => {
    const err = new DOMException("The operation was aborted", "AbortError");
    expect(classifyTransportError(err)).toBe("ambiguous");
  });

  it("classifies name: TimeoutError as ambiguous", () => {
    const err = new DOMException("The operation was aborted.", "TimeoutError");
    expect(classifyTransportError(err)).toBe("ambiguous");
  });

  it(
    "classifies the actual DOMException a real AbortSignal.timeout() firing during fetch produces as ambiguous " +
      "(asserts the runtime's real shape, not only the shape predicted above)",
    async () => {
      // A local server that never responds -- the request hangs until the
      // 1ms timeout fires, exactly like an unbounded SendGrid call would.
      // Local loopback only: no outbound network egress is required, unlike
      // dialing an unroutable external address.
      const server = createServer(() => {
        /* never respond */
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected an AddressInfo from the ephemeral listener");
      }

      let thrown: unknown;
      try {
        await fetch(`http://127.0.0.1:${address.port}/`, { signal: AbortSignal.timeout(1) });
      } catch (err) {
        thrown = err;
      } finally {
        server.close();
      }

      expect(thrown, "the timed-out fetch must have rejected").toBeDefined();
      expect(classifyTransportError(thrown)).toBe("ambiguous");
    }
  );

  it("classifies a plain unrecognized Error (no code, no recognized name) as ambiguous -- the fail-closed default", () => {
    expect(classifyTransportError(new Error("boom"))).toBe("ambiguous");
  });

  it("classifies null, undefined, a bare string, and a number as ambiguous without throwing", () => {
    for (const value of [null, undefined, "some string error", 42]) {
      expect(() => classifyTransportError(value)).not.toThrow();
      expect(classifyTransportError(value)).toBe("ambiguous");
    }
  });

  it("classifies undefined specifically as ambiguous (acceptance criteria)", () => {
    expect(classifyTransportError(undefined)).toBe("ambiguous");
  });

  it("unwraps one level of `cause` to classify undici's `TypeError: fetch failed` wrapper as pre_connection_retryable", () => {
    const socketError = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
    const fetchFailed = new TypeError("fetch failed");
    (fetchFailed as unknown as { cause?: unknown }).cause = socketError;
    expect(classifyTransportError(fetchFailed)).toBe("pre_connection_retryable");
  });

  it("does NOT misclassify a `cause`-wrapped ambiguous error as retryable", () => {
    const resetError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const fetchFailed = new TypeError("fetch failed");
    (fetchFailed as unknown as { cause?: unknown }).cause = resetError;
    expect(classifyTransportError(fetchFailed)).toBe("ambiguous");
  });
});
