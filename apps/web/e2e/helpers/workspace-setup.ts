import { type Page, expect } from "@playwright/test";

/**
 * Shared e2e preamble (21-07/21-08): register a fresh owner and create a
 * workspace, landing on `/w/:slug`. Reproduces the behavior already proven in
 * segments-behavior.spec.ts's in-file `registerAndCreateWorkspace` (including
 * its 429 retry-after backoff), factored out here so it is reusable across
 * specs without touching that file.
 */
export async function registerAndCreateWorkspace(page: Page, namePrefix: string): Promise<string> {
  const email = `owner-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  await page.goto("/register");
  await page.getByLabel(/имя/i).fill(`${namePrefix} Owner`);
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/пароль/i).fill("correct horse battery staple 42");

  const signUpResponse = page.waitForResponse(
    (response) => response.url().endsWith("/api/auth/sign-up/email") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();

  const response = await signUpResponse;
  if (response.status() === 429) {
    // The full serial E2E corpus legitimately exercises enough /api/auth/*
    // requests to reach the production-shaped shared bucket. Respect the
    // server's own backoff contract rather than weakening rate limiting in
    // test mode or sleeping unconditionally on every registration.
    const retryAfterSeconds = Number(response.headers()["retry-after"] ?? "1");
    await page.waitForTimeout((Number.isFinite(retryAfterSeconds) ? retryAfterSeconds + 1 : 2) * 1_000);
    await page.getByRole("button", { name: "Зарегистрироваться" }).click();
  }

  await page.waitForURL("**/create-workspace");
  await page.getByLabel(/название/i).fill(`${namePrefix} ${Date.now()}`);
  await page.getByRole("button", { name: "Создать воркспейс" }).click();

  await page.waitForURL(/\/w\/[a-z0-9-]+/);
  const slug = new URL(page.url()).pathname.match(/\/w\/([a-z0-9-]+)/)?.[1];
  expect(slug).toBeTruthy();
  return slug as string;
}

/**
 * Creates a contact through the API directly (`page.request` shares the
 * browser context's cookie jar, so the session cookie from registration
 * authenticates the call, and the Vite dev-server proxy forwards it to the
 * API). There is no contact-creation affordance in the UI -- contacts arrive
 * via CSV import or the API -- so this is the correct fixture path, not a UI
 * walk.
 */
export async function createContactViaApi(
  page: Page,
  slug: string,
  input: { email?: string; firstName?: string; lastName?: string },
): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${slug}/contacts`, {
    data: input,
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { id: string };
  return body.id;
}
