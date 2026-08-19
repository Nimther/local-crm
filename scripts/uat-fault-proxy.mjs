#!/usr/bin/env node
// Phase 16 plan 06 (UAT-05): session-scoped SendGrid fault proxy.
//
// Safety invariant: rate-limit-once never forwards, while timeout-once always
// forwards and waits for SendGrid before delaying the response. Reversing
// either branch can create a real duplicate or a real lost message.

import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { SENDGRID_TIMEOUT_MS } from "@mega-crm/delivery-core";

const MODES = new Set(["pass-through", "rate-limit-once", "timeout-once"]);
const CONTROL_PATH = "/__control";
const REAL_SENDGRID_MAIL_SEND_URL = "https://api.sendgrid.com/v3/mail/send";
const DEFAULT_LISTEN_PORT = 4180;
const DEFAULT_RESPONSE_DELAY_MS = SENDGRID_TIMEOUT_MS + 2_000;
const RATE_LIMIT_RETRY_AFTER_SECONDS = 10;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function nextMode(current) {
  if (!MODES.has(current)) {
    throw new Error(`Unknown UAT fault-proxy mode: ${current}`);
  }
  return "pass-through";
}

function readRawBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function forwardHeaders(incomingHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incomingHeaders)) {
    if (value === undefined || name === "host" || HOP_BY_HOP_HEADERS.has(name)) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

function copyResponseHeaders(upstreamResponse, response) {
  for (const [name, value] of upstreamResponse.headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(name)) response.setHeader(name, value);
  }
}

function sendJson(response, statusCode, body) {
  const serialized = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(serialized),
  });
  response.end(serialized);
}

function parsePositiveInteger(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== String(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function requestBelongsToWorkspace(rawBody, targetWorkspaceId) {
  if (!targetWorkspaceId) return true;
  try {
    const payload = JSON.parse(rawBody.toString("utf8"));
    return payload?.personalizations?.some(
      (personalization) => personalization?.custom_args?.workspace_id === targetWorkspaceId,
    );
  } catch {
    return false;
  }
}

/**
 * Build the server without listening so tests can bind it to an ephemeral
 * loopback port. `uatListenPort` is attached for the guarded CLI wrapper.
 */
export function createFaultProxy({
  upstreamUrl = REAL_SENDGRID_MAIL_SEND_URL,
  listenPort = DEFAULT_LISTEN_PORT,
  responseDelayMs = DEFAULT_RESPONSE_DELAY_MS,
  targetWorkspaceId = null,
  fetchImpl = fetch,
} = {}) {
  const parsedUpstreamUrl = new URL(upstreamUrl);
  const validatedListenPort = parsePositiveInteger(listenPort, "listenPort");
  const validatedResponseDelayMs = parsePositiveInteger(responseDelayMs, "responseDelayMs");
  let mode = "pass-through";

  const server = createServer(async (request, response) => {
    try {
      if (request.url === CONTROL_PATH) {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }

        let requestedMode;
        try {
          const body = JSON.parse((await readRawBody(request)).toString("utf8"));
          requestedMode = body?.mode;
        } catch {
          sendJson(response, 400, { error: "invalid_json" });
          return;
        }

        if (!MODES.has(requestedMode)) {
          sendJson(response, 400, { error: "unknown_mode" });
          return;
        }

        mode = requestedMode;
        sendJson(response, 200, { mode });
        return;
      }

      const rawBody = await readRawBody(request);
      const matchesTarget = requestBelongsToWorkspace(rawBody, targetWorkspaceId);
      const requestMode = matchesTarget ? mode : "pass-through";
      if (matchesTarget) mode = nextMode(requestMode);

      if (requestMode === "rate-limit-once") {
        response.writeHead(429, {
          "retry-after": String(RATE_LIMIT_RETRY_AFTER_SECONDS),
          "content-length": "0",
        });
        response.end();
        return;
      }

      const upstreamResponse = await fetchImpl(parsedUpstreamUrl, {
        method: request.method,
        headers: forwardHeaders(request.headers),
        body: rawBody.length > 0 ? rawBody : undefined,
        redirect: "manual",
      });
      const upstreamBody = Buffer.from(await upstreamResponse.arrayBuffer());

      if (requestMode === "timeout-once") {
        await sleep(validatedResponseDelayMs);
      }

      if (response.destroyed) return;
      response.statusCode = upstreamResponse.status;
      response.statusMessage = upstreamResponse.statusText;
      copyResponseHeaders(upstreamResponse, response);
      response.end(upstreamBody);
    } catch (error) {
      if (response.destroyed) return;
      sendJson(response, 502, {
        error: "upstream_failure",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.uatListenPort = validatedListenPort;
  return server;
}

function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

async function main() {
  const server = createFaultProxy({
    upstreamUrl: process.env.UAT_FAULT_PROXY_UPSTREAM_URL ?? REAL_SENDGRID_MAIL_SEND_URL,
    listenPort: process.env.UAT_FAULT_PROXY_PORT ?? DEFAULT_LISTEN_PORT,
    responseDelayMs:
      process.env.UAT_FAULT_PROXY_RESPONSE_DELAY_MS ?? DEFAULT_RESPONSE_DELAY_MS,
    targetWorkspaceId: process.env.UAT_FAULT_PROXY_WORKSPACE_ID ?? null,
  });

  server.on("error", (error) => {
    console.error("uat-fault-proxy: FAILED --", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
  server.listen(server.uatListenPort, "0.0.0.0", () => {
    console.log(`uat-fault-proxy: listening on port ${server.uatListenPort}; mode=pass-through`);
  });
}

if (isDirectInvocation()) {
  main().catch((error) => {
    console.error("uat-fault-proxy: FAILED --", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
