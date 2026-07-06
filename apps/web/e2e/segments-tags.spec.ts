import { test, expect, type Page } from "@playwright/test";

/**
 * Gap-closure coverage for 03-08 (SEGM-01): the tags condition slice the
 * builder UI could not reach before 03-07 (STANDARD_FIELDS had no `tags`
 * entry -- 03-VERIFICATION.md failed-truth #1), plus the CR-01 regression
 * guard (saving the default unconfigured attribute condition must show an
 * inline validation error and must NOT navigate away / silently 500).
 *
 * Kept as its own spec file -- the existing happy-path segments.spec.ts is
 * left untouched.
 */

/** Register a fresh owner, create a workspace, and land on `/w/:slug`. Returns the slug. */
async function registerAndCreateWorkspace(page: Page): Promise<string> {
  const email = `owner-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  await page.goto("/register");
  await page.getByLabel(/имя/i).fill("Segments Tags Owner");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/пароль/i).fill("correct horse battery staple 42");
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();

  await page.waitForURL("**/create-workspace");
  await page.getByLabel(/название/i).fill(`Tags Test ${Date.now()}`);
  await page.getByRole("button", { name: "Создать воркспейс" }).click();

  await page.waitForURL(/\/w\/[a-z0-9-]+/);
  const slug = new URL(page.url()).pathname.match(/\/w\/([a-z0-9-]+)/)?.[1];
  expect(slug).toBeTruthy();
  return slug as string;
}

/** Navigate to the Сегменты section and open the create-segment builder. */
async function openSegmentCreatePage(page: Page, slug: string): Promise<void> {
  await page.getByRole("link", { name: "Сегменты" }).click();
  await page.waitForURL(`**/w/${slug}/segments`);

  await page.getByRole("button", { name: "Создать сегмент" }).first().click();
  await page.waitForURL(`**/w/${slug}/segments/new`);
}

test("build, save, and reopen a tags segment (SEGM-01 tags slice)", async ({ page }) => {
  const slug = await registerAndCreateWorkspace(page);
  await openSegmentCreatePage(page, slug);

  // Default first condition row -- open the field combobox and choose «Теги»
  // (post-03-07: reachable in STANDARD_FIELDS).
  await page.getByRole("button", { name: "Выберите поле" }).first().click();
  await page.getByRole("option", { name: "Теги" }).click();

  // Selecting the field auto-defaults the operator to the first entry for
  // its kind (`has_tag` / «есть тег») -- confirm it explicitly via the
  // now-visible operator Select (the only Radix Select-role combobox on the
  // page at this point).
  await expect(page.getByRole("combobox").first()).toBeVisible();
  await page.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "есть тег" }).click();

  await page.getByPlaceholder("Значение").fill("vip");

  // Live count settles (debounced request-response).
  await expect(page.getByText(/контактов подходит/i)).toBeVisible({ timeout: 10_000 });

  const segmentName = `Tags VIP ${Date.now()}`;
  await page.getByLabel("Название сегмента").fill(segmentName);
  await page.getByRole("button", { name: "Сохранить сегмент" }).click();

  await page.waitForURL(`**/w/${slug}/segments`);
  await expect(page.getByText(segmentName)).toBeVisible();

  // Reopen the segment: the definition builder must be prefilled with the
  // tags condition (field, operator, and value all round-trip).
  await page.getByText(segmentName).click();
  await page.waitForURL(/\/w\/[a-z0-9-]+\/segments\/[^/]+$/);

  await expect(page.getByRole("heading", { name: "Определение сегмента" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Теги" })).toBeVisible();
  await expect(page.getByText("есть тег", { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder("Значение")).toHaveValue("vip");
});

test("CR-01 regression: saving the default unconfigured condition fails loudly, not silently", async ({ page }) => {
  const slug = await registerAndCreateWorkspace(page);
  await openSegmentCreatePage(page, slug);

  // Fill only the name -- leave the default first condition's field
  // unselected (the exact scenario 03-VERIFICATION.md flagged as a silent
  // 500 pre-03-07).
  const segmentName = `CR-01 Regression ${Date.now()}`;
  await page.getByLabel("Название сегмента").fill(segmentName);
  await page.getByRole("button", { name: "Сохранить сегмент" }).click();

  // Inline validation error is shown -- the save is blocked loudly.
  await expect(page.getByText("Выберите поле в каждом условии")).toBeVisible();

  // No navigation away from the create page -- the save was never sent.
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/segments/new$`));
});
