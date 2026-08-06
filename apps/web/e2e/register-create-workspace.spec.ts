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

  // 08-10: this assertion used to run against the workspace index route, which
  // rendered the role via WorkspaceHome. 07-07 (aa1c09f) swapped that route to
  // WorkspaceDashboard, which does not show a role, and left WorkspaceHome
  // orphaned — so the assertion had been failing since 14 Jul without anyone
  // noticing, because the E2E lane is not in CI and running it locally attached
  // to a dev stack via reuseExistingServer.
  //
  // The intent is unchanged — the registering user must be the Owner — but the
  // app no longer prints the role anywhere for a solo owner: MemberRow renders
  // "Владелец", and TeamPage suppresses the whole table behind
  // `members.length <= 1 && invites.length === 0`. So this asserts Owner-ness
  // through an owner-EXCLUSIVE affordance instead, gated on the same viewerRole
  // the original assertion was about (TeamPage.tsx: `viewerRole === "owner"`).
  const slug = new URL(page.url()).pathname.split("/")[2];
  await page.goto(`/w/${slug}/team`);
  await expect(page.getByRole("button", { name: "Удалить воркспейс" })).toBeVisible();
});
