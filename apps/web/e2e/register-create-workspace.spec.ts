import { test, expect } from "@playwright/test";

/**
 * Walking-skeleton happy path (SKELETON.md): register -> create workspace ->
 * see role Owner at /w/{slug}. This is the RED test for 01-02 Task 1 — it
 * MUST fail until Task 3 wires up the full UI.
 */
test("register, create a workspace, and see Owner at /w/:slug", async ({ page }) => {
  const email = `owner-${Date.now()}@example.com`;

  await page.goto("/register");
  await page.getByLabel(/имя/i).fill("Ada Owner");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/пароль/i).fill("correct horse battery staple 42");
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();

  await page.waitForURL("**/create-workspace");
  await page.getByLabel(/название/i).fill("Acme");
  await page.getByRole("button", { name: "Создать воркспейс" }).click();

  await page.waitForURL(/\/w\/acme(-[a-z0-9]+)?/);
  await expect(page.getByText(/owner|владелец/i)).toBeVisible();
});
