import { type Page, expect, test } from "@playwright/test";

/**
 * Debug session `auth-session-lifecycle` — the shared browser-level
 * verification for BOTH proven root causes.
 *
 * Symptom 2 (first submit only "reloads" the page): `login.tsx` calls
 * `void navigate("/")` the instant `signIn.email()` resolves, but better-auth's
 * client defers its own session refresh — `client/proxy.mjs` sets the session
 * signal inside `setTimeout(..., 10)` ("To avoid race conditions we set the
 * signal in a setTimeout"). React flushes the navigation in a microtask, long
 * before that 10ms timer, so `RootRedirect` reads the session store's RETAINED
 * logged-out value (`data: null`, `isPending: false`, left there by the
 * "/" -> /login redirect the user arrived through) and sends them straight back
 * to /login. The second submit works only because the bounce's brief mount
 * re-subscribes the store and nanostores' 1000ms STORE_UNMOUNT_DELAY keeps that
 * subscription alive long enough for the deferred refresh to land.
 *
 * Symptom 1 (correct credentials answered "Неверный email или пароль"):
 * `/api/auth/*` shares ONE 20/min bucket, so session reads spend the credential
 * budget and a correct sign-in comes back 429 — which `login.tsx` maps to the
 * wrong-credentials copy like every other error shape. The same 429 on a
 * `get-session` is what strands an authenticated user on the unguarded /login
 * route in the first place (RootRedirect reads neither `error` nor
 * `isRefetching`). The API/session half is pinned by
 * apps/api/src/modules/auth/__tests__/auth-rate-limit-buckets.test.ts.
 *
 * WHY THE INJECTED DELAY (and why it is not a fix disguised as a test):
 * following the pattern this repo already established in
 * segments-behavior.spec.ts (KB: segm-04-live-count-race), the delay is
 * STIMULUS, not remedy. It holds the "session not yet known" window open on
 * every machine, so a fix that merely happens to win a timing race on a fast
 * laptop still fails here. Nothing in the product may paper over this with a
 * delay, a retry, or a re-submission — hence the assertion that exactly ONE
 * sign-in request is ever sent.
 */

const PASSWORD = "correct horse battery staple 42";

/**
 * Long enough to dwarf every window asserted against it (React's microtask
 * flush, and the 400ms/5s race windows below), so the ordering under test is
 * pinned rather than sampled.
 */
const SESSION_READ_DELAY_MS = 1_200;

/** Holds every `/get-session` open, pinning the "session unknown" window. */
async function delaySessionReads(page: Page): Promise<void> {
  await page.route("**/api/auth/get-session*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, SESSION_READ_DELAY_MS));
    await route.continue();
  });
}

/**
 * Registers an owner and a workspace through the API rather than the UI.
 * `page.request` shares the browser context's cookie jar, so the context is
 * authenticated afterwards (and the Vite dev-server proxy forwards /api to the
 * API server). Registering through the API keeps these tests measuring the
 * auth-session lifecycle instead of re-walking the registration UI.
 *
 * The 429 retry mirrors helpers/workspace-setup.ts: the serial E2E corpus
 * legitimately reaches the credential bucket, and the server's own
 * `retry-after` is the contract to honour. It deliberately does NOT paper over
 * the bug under test — no test here retries a sign-in.
 */
async function registerOwner(page: Page): Promise<{ email: string; slug: string }> {
  const email = `auth-lc-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  const signUp = async () =>
    page.request.post("/api/auth/sign-up/email", {
      data: { email, password: PASSWORD, name: "Auth Lifecycle Owner" },
    });

  let response = await signUp();
  if (response.status() === 429) {
    const retryAfterSeconds = Number(response.headers()["retry-after"] ?? "1");
    const retryDelayMs = (Number.isFinite(retryAfterSeconds) ? retryAfterSeconds + 1 : 2) * 1_000;
    const testInfo = test.info();
    testInfo.setTimeout(testInfo.timeout + retryDelayMs);
    await page.waitForTimeout(retryDelayMs);
    response = await signUp();
  }
  if (!response.ok()) {
    throw new Error(`E2E sign-up failed with HTTP ${response.status()}: ${await response.text()}`);
  }

  const workspace = await page.request.post("/api/workspaces", {
    data: { name: `Auth Lifecycle ${Date.now()}` },
  });
  if (!workspace.ok()) {
    throw new Error(`E2E workspace create failed with HTTP ${workspace.status()}: ${await workspace.text()}`);
  }
  const { slug } = (await workspace.json()) as { slug: string };
  return { email, slug };
}

/** Counts credential submissions, so a fix can never be a silent re-submit. */
function countSignInRequests(page: Page): () => number {
  let count = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/auth/sign-in/email")) count += 1;
  });
  return () => count;
}

test("correct credentials authenticate on the FIRST submission (symptom 2)", async ({ page }) => {
  test.setTimeout(60_000);
  const { email } = await registerOwner(page);

  // Log out at the browser level: the app ships no sign-out affordance, and
  // clearing the cookie jar is what a returning, expired-session user has.
  await page.context().clearCookies();

  const signInRequests = countSignInRequests(page);
  await delaySessionReads(page);

  // THE PRECONDITION: arrive at /login through the app's OWN redirect, which is
  // what leaves the session store holding a resolved logged-out value. (A
  // direct hard load of /login leaves the store unmounted at isPending: true,
  // and submits fine on the first try — that asymmetry is the fingerprint of
  // this bug.)
  await page.goto("/");
  await page.waitForURL("**/login");
  // Waiting for the form proves the delayed session read has resolved to
  // "logged out" — i.e. the stale value is now in the store.
  await expect(page.getByRole("button", { name: "Войти" })).toBeVisible();

  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/пароль/i).fill(PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();

  // ONE submission must be enough to get into the app.
  await page.waitForURL((url) => /^\/(w\/[a-z0-9-]+|create-workspace)/.test(url.pathname), {
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Войти" })).toHaveCount(0);
  expect(signInRequests(), "the fix must not re-submit the credentials").toBe(1);
});

test("an authenticated user is redirected off /login, and never sees the form while the session is still unknown (symptom 1)", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const { slug } = await registerOwner(page);
  await delaySessionReads(page);

  await page.goto("/login");

  // Whichever happens FIRST decides. Under the bug the form renders (and no
  // redirect ever comes). A fix that redirected only AFTER rendering the form
  // would also lose this race — which is the point: Symptoms.expected requires
  // that the auth loading state must not render the login page.
  const outcome = await Promise.race([
    page
      .waitForURL((url) => url.pathname !== "/login", { timeout: 15_000 })
      .then(() => "redirected" as const)
      .catch(() => "timeout" as const),
    page
      .getByRole("button", { name: "Войти" })
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => "login-form" as const)
      .catch(() => "timeout" as const),
  ]);
  expect(outcome, "an already-authenticated user must never be shown the login form").toBe("redirected");

  await page.waitForURL(new RegExp(`/w/${slug}`));
});

test("a throttled sign-in is not reported as wrong credentials (symptom 1)", async ({ page }) => {
  test.setTimeout(60_000);
  const { email } = await registerOwner(page);
  await page.context().clearCookies();

  await page.goto("/");
  await page.waitForURL("**/login");
  await expect(page.getByRole("button", { name: "Войти" })).toBeVisible();

  // The exact response the shared /api/auth bucket returns (verified against
  // the real server in auth-rate-limit-buckets.test.ts): a Fastify rate-limit
  // body with NO better-auth error `code`, so it is distinguishable from a
  // genuine 401 INVALID_EMAIL_OR_PASSWORD.
  await page.route("**/api/auth/sign-in/email", async (route) => {
    await route.fulfill({
      status: 429,
      headers: { "retry-after": "60" },
      contentType: "application/json",
      body: JSON.stringify({
        statusCode: 429,
        error: "Too Many Requests",
        message: "Rate limit exceeded, retry in 1 minute",
      }),
    });
  });

  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/пароль/i).fill(PASSWORD);
  const throttled = page.waitForResponse(
    (response) => response.url().includes("/api/auth/sign-in/email") && response.status() === 429
  );
  await page.getByRole("button", { name: "Войти" }).click();
  await throttled;

  // The user's credentials were correct; the server just refused to answer
  // right now. The message must say so, and must not blame the credentials.
  // (`p.text-destructive` is the login page's own error slot; FormMessage uses
  // the same class for field errors, and both fields hold valid values here.)
  const errorSlot = page.locator("p.text-destructive");
  await expect(errorSlot.first()).toBeVisible();
  await expect(page.getByText(/Неверный email или пароль/i)).toHaveCount(0);
  await expect(errorSlot.first(), "a throttle must not be reported as a credential failure").not.toHaveText(
    /парол/i
  );
  await expect(page).toHaveURL(/\/login$/);
});

test("a page refresh after signing in keeps the session", async ({ page }) => {
  test.setTimeout(60_000);
  const { email } = await registerOwner(page);
  await page.context().clearCookies();

  await page.goto("/");
  await page.waitForURL("**/login");
  await expect(page.getByRole("button", { name: "Войти" })).toBeVisible();
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/пароль/i).fill(PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();

  await page.waitForURL((url) => /^\/(w\/[a-z0-9-]+|create-workspace)/.test(url.pathname), {
    timeout: 30_000,
  });
  const landedOn = new URL(page.url()).pathname;

  await page.reload();
  await expect(page).toHaveURL(new RegExp(`${landedOn}$`));
  await expect(page.getByRole("button", { name: "Войти" })).toHaveCount(0);
});
