// Phase 16 plan 06 (UAT-05): behavioral contract for the session-scoped
// SendGrid fault proxy. The asymmetric upstream counts are the safety
// property: 429 must send zero real messages, while timeout must send one.

import { createServer } from "node:http";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFaultProxy, nextMode } from "../uat-fault-proxy.mjs";

const RESPONSE_DELAY_MS = 50;

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("UAT SendGrid fault proxy", () => {
  let upstreamRequests;
  let upstreamServer;
  let proxyServer;
  let proxyBaseUrl;

  beforeEach(async () => {
    upstreamRequests = [];
    upstreamServer = createServer(async (request, response) => {
      upstreamRequests.push({
        method: request.method,
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
        body: await readBody(request),
      });
      response.writeHead(202, {
        "content-type": "application/json",
        "x-upstream-evidence": "forwarded",
      });
      response.end('{"accepted":true}');
    });
    const upstreamBaseUrl = await listen(upstreamServer);

    proxyServer = createFaultProxy({
      upstreamUrl: `${upstreamBaseUrl}/v3/mail/send`,
      responseDelayMs: RESPONSE_DELAY_MS,
    });
    proxyBaseUrl = await listen(proxyServer);
  });

  afterEach(async () => {
    await Promise.all([close(proxyServer), close(upstreamServer)]);
  });

  async function arm(mode) {
    return fetch(`${proxyBaseUrl}/__control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    });
  }

  async function send(body = '{"personalizations":[]}') {
    return fetch(`${proxyBaseUrl}/v3/mail/send`, {
      method: "POST",
      headers: {
        authorization: "Bearer SG.test-key",
        "content-type": "application/json",
      },
      body,
    });
  }

  it("nextMode resets either one-shot mode and leaves pass-through unchanged", () => {
    expect(nextMode("pass-through")).toBe("pass-through");
    expect(nextMode("rate-limit-once")).toBe("pass-through");
    expect(nextMode("timeout-once")).toBe("pass-through");
  });

  it("passes through the upstream status, headers, and response bytes", async () => {
    const response = await send();

    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-upstream-evidence")).toBe("forwarded");
    expect(await response.text()).toBe('{"accepted":true}');
    expect(upstreamRequests).toHaveLength(1);
  });

  it("rate-limit-once returns 429 with Retry-After and sends zero upstream requests", async () => {
    expect((await arm("rate-limit-once")).status).toBe(200);

    const response = await send();

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(upstreamRequests).toHaveLength(0);
  });

  it("rate-limit-once is consumed by one request and then passes through", async () => {
    await arm("rate-limit-once");

    expect((await send()).status).toBe(429);
    expect((await send()).status).toBe(202);
    expect(upstreamRequests).toHaveLength(1);
  });

  it("timeout-once forwards exactly once before delaying its response past the margin", async () => {
    await arm("timeout-once");
    const startedAt = performance.now();

    const response = await send();
    const elapsedMs = performance.now() - startedAt;

    expect(response.status).toBe(202);
    expect(upstreamRequests).toHaveLength(1);
    expect(elapsedMs).toBeGreaterThanOrEqual(RESPONSE_DELAY_MS);
  });

  it("timeout-once is consumed by one request and adds no delay to the next", async () => {
    await arm("timeout-once");
    await send();
    const startedAt = performance.now();

    expect((await send()).status).toBe(202);
    expect(performance.now() - startedAt).toBeLessThan(RESPONSE_DELAY_MS);
    expect(upstreamRequests).toHaveLength(2);
  });

  it("the control endpoint accepts all three documented modes", async () => {
    for (const mode of ["pass-through", "rate-limit-once", "timeout-once"]) {
      const response = await arm(mode);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ mode });
    }
  });

  it("rejects an unknown mode without changing the armed mode", async () => {
    await arm("rate-limit-once");

    const rejected = await arm("forward-and-rate-limit");

    expect(rejected.status).toBe(400);
    expect((await send()).status).toBe(429);
    expect(upstreamRequests).toHaveLength(0);
  });

  it("preserves the request method, authorization, content type, and body bytes", async () => {
    const body = '{"personalizations":[{"to":[{"email":"uat@example.test"}]}]}';

    await send(body);

    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]).toEqual({
      method: "POST",
      authorization: "Bearer SG.test-key",
      contentType: "application/json",
      body: Buffer.from(body),
    });
  });
});
