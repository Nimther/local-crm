import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAuthTestDatabaseUrl } from "@mega-crm/test-support";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

/**
 * Debug session `auth-session-lifecycle`, symptom 1 — API/session level.
 *
 * `modules/auth/plugin.ts` registers @fastify/rate-limit once for the WHOLE
 * `/api/auth/*` scope (`max: 20`, `timeWindow: "1 minute"`, no keyGenerator),
 * so better-auth's session READS spend the very budget the comment says is
 * there to stop credential stuffing. The better-auth client refetches
 * `/get-session` on window focus, tab visibility, online events, cross-tab
 * broadcast and every fresh store mount, so an authenticated user who simply
 * uses the app drains the bucket — and the next sign-in with CORRECT
 * credentials is answered 429, which `apps/web/src/routes/login.tsx` renders
 * as "Неверный email или пароль" (it maps every error shape to that one
 * message). apps/web/e2e/helpers/workspace-setup.ts already documents the
 * same bucket being hit by the E2E corpus.
 *
 * Oracles here are STATUS CODES, not `x-ratelimit-*` headers: the auth scope
 * calls `reply.hijack()` and writes through `reply.raw`, so Fastify never
 * applies the limiter's response headers to a successful auth response
 * (verified by probe — they come back empty).
 *
 * Every test uses its own `remoteAddress`, because the limiter is keyed per IP
 * and its counters live for a whole minute — sharing one IP would leak one
 * test's spent budget into the next.
 */
describe("auth rate-limit buckets (debug: auth-session-lifecycle)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  const PASSWORD = "correct horse battery staple 42";
  /** plugin.ts's configured ceiling for the credential bucket. */
  const CREDENTIAL_MAX = 20;
  /**
   * Upper bound the session-read bucket must stay under. Deliberately generous
   * — better-auth's focus refetch is floored at one per 5s (~12/min) — but
   * FINITE, so the fix cannot be "exempt /get-session from the limiter".
   */
  const SESSION_READ_CEILING = 200;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    process.env.AUTH_DATABASE_URL = getAuthTestDatabaseUrl();
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function signUp(remoteAddress: string) {
    const email = `rl-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const res = await app.inject({
      remoteAddress,
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email, password: PASSWORD, name: "Rate Limit Probe" },
    });
    expect(res.statusCode, `sign-up failed: ${res.body}`).toBe(200);
    const cookie = res.cookies.find((c) => c.name.toLowerCase().includes("session"));
    if (!cookie) throw new Error("sign-up did not set a session cookie");
    return { email, cookie: `${cookie.name}=${cookie.value}` };
  }

  const readSession = (remoteAddress: string, cookie: string) =>
    app.inject({ remoteAddress, method: "GET", url: "/api/auth/get-session", headers: { cookie } });

  const submitCredentials = (remoteAddress: string, email: string, password: string) =>
    app.inject({
      remoteAddress,
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: "http://localhost:5173" },
      payload: { email, password },
    });

  /**
   * THE DRIVING TEST (RED before the fix: the sign-in comes back 429).
   *
   * Session reads must not be able to deny a credential submit — they belong
   * in a different bucket than credential attempts.
   */
  it("does not let a burst of session reads deny a correct credential submit", async () => {
    const ip = "10.10.0.1";
    const { email, cookie } = await signUp(ip);

    // Well past the 20/min scope budget, and well within what a real browsing
    // session produces across focus/visibility/mount refetches.
    const readStatuses: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      readStatuses.push((await readSession(ip, cookie)).statusCode);
    }

    const signIn = await submitCredentials(ip, email, PASSWORD);
    expect(
      signIn.statusCode,
      `correct credentials were rejected after ${readStatuses.length} session reads ` +
        `(read statuses: ${readStatuses.join(",")}); body: ${signIn.body}`
    ).toBe(200);
  });

  /**
   * The security control this must not weaken (must stay GREEN): a splitting
   * fix has to keep throttling credential attempts, not remove the limiter.
   */
  it("still throttles repeated wrong-password submits", async () => {
    const ip = "10.10.0.2";
    const { email } = await signUp(ip);

    const statuses: number[] = [];
    let throttled: Awaited<ReturnType<typeof submitCredentials>> | undefined;
    for (let i = 0; i < CREDENTIAL_MAX + 10 && !throttled; i += 1) {
      const res = await submitCredentials(ip, email, "definitely not the password");
      statuses.push(res.statusCode);
      if (res.statusCode === 429) throttled = res;
    }

    expect(
      throttled,
      `brute-force attempts were never throttled (statuses: ${statuses.join(",")})`
    ).toBeDefined();

    // The rejections before the throttle must be genuine credential failures,
    // and they must be DISTINGUISHABLE from the throttle — that distinction is
    // exactly what the login page has to key its message on.
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    const rejected = await submitCredentials("10.10.0.3", email, "definitely not the password");
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });

    const throttledBody = throttled!.json<Record<string, unknown>>();
    expect(throttledBody).toMatchObject({ statusCode: 429, error: "Too Many Requests" });
    expect(
      throttledBody.code,
      "a throttle response must not carry a better-auth error code, or the UI cannot tell it apart from bad credentials"
    ).toBeUndefined();
    expect(throttled!.headers["retry-after"]).toBeDefined();
  });

  /**
   * Prevents the other way of "fixing" this — exempting session reads from the
   * limiter entirely. Their bucket may be roomier, never unbounded.
   */
  it("keeps session reads bounded by a limiter of their own", async () => {
    const ip = "10.10.0.4";
    const { cookie } = await signUp(ip);

    let sawThrottle = false;
    for (let i = 0; i < SESSION_READ_CEILING && !sawThrottle; i += 1) {
      sawThrottle = (await readSession(ip, cookie)).statusCode === 429;
    }

    expect(
      sawThrottle,
      `${SESSION_READ_CEILING} consecutive session reads from one IP were never throttled — ` +
        "the session-read bucket must stay finite"
    ).toBe(true);
  }, 60_000);

  /**
   * Regression pin for the eliminated hypothesis: re-authenticating while a
   * live session cookie is already attached is LEGITIMATE and the server
   * answers it happily, so nothing in the UI may treat it as an error.
   */
  it("accepts a correct sign-in while a live session cookie is already attached", async () => {
    const ip = "10.10.0.5";
    const { email, cookie } = await signUp(ip);

    const res = await app.inject({
      remoteAddress: ip,
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { cookie, origin: "http://localhost:5173" },
      payload: { email, password: PASSWORD },
    });

    expect(res.statusCode, res.body).toBe(200);
    const reissued = res.cookies.find((c) => c.name.toLowerCase().includes("session"));
    expect(reissued?.value, "re-login must issue a fresh session token").toBeTruthy();
    expect(reissued?.value).not.toBe(cookie.split("=")[1]);
  });
});
