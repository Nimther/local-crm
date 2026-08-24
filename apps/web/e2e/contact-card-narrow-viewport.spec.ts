import { test, expect } from "@playwright/test";

import { registerAndCreateWorkspace, createContactViaApi } from "./helpers/workspace-setup";

/**
 * Gap closure G-21-3 (21-08): the 375px measurement the UAT tester made,
 * reproduced as an automated Playwright spec.
 *
 * `.planning/debug/contact-card-narrow-viewport-overflow.md` measured, at
 * 375px, body clientWidth 375 vs scrollWidth 1029, a Delete button rendered
 * outside the viewport, and the inline export message starting off-screen.
 * This spec asserts the same three facts so a regression on any of the two
 * AND-gated layers (the fixed shell sidebar, the contact-card header rows)
 * fails loudly again.
 *
 * Spec-scoped viewport only (`test.use` below) -- every other spec in this
 * corpus keeps Playwright's default 1280x720 desktop viewport.
 */
test.use({ viewport: { width: 375, height: 812 } });

test("at 375px the contact card has no horizontal overflow and both header actions are visible", async ({ page }) => {
  const slug = await registerAndCreateWorkspace(page, "Narrow Viewport");
  const contactId = await createContactViaApi(page, slug, { email: `narrow-${Date.now()}@example.com` });

  await page.goto(`/w/${slug}/contacts/${contactId}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  const exportButton = page.getByRole("button", { name: /Скачать данные контакта/ });
  const deleteButton = page.getByRole("button", { name: "Удалить контакт" });
  await expect(exportButton).toBeVisible();
  await expect(deleteButton).toBeVisible();

  // 1. No horizontal page overflow -- the UAT report's exact measurement shape.
  const { clientWidth, scrollWidth } = await page.evaluate(() => ({
    clientWidth: document.body.clientWidth,
    scrollWidth: document.body.scrollWidth,
  }));
  expect(
    scrollWidth,
    `body scrollWidth (${scrollWidth}) must not exceed clientWidth (${clientWidth}) at 375px`,
  ).toBeLessThanOrEqual(clientWidth);

  const viewportWidth = 375;

  // 2. Both header actions are fully inside the viewport.
  const exportBox = await exportButton.boundingBox();
  const deleteBox = await deleteButton.boundingBox();
  expect(exportBox, "Export button must have a bounding box").not.toBeNull();
  expect(deleteBox, "Delete button must have a bounding box").not.toBeNull();
  if (exportBox) {
    expect(exportBox.x, `Export button x (${exportBox.x}) must be >= 0`).toBeGreaterThanOrEqual(0);
    expect(
      exportBox.x + exportBox.width,
      `Export button right edge (${exportBox.x + exportBox.width}) must be <= viewport width (${viewportWidth})`,
    ).toBeLessThanOrEqual(viewportWidth);
  }
  if (deleteBox) {
    expect(deleteBox.x, `Delete button x (${deleteBox.x}) must be >= 0`).toBeGreaterThanOrEqual(0);
    expect(
      deleteBox.x + deleteBox.width,
      `Delete button right edge (${deleteBox.x + deleteBox.width}) must be <= viewport width (${viewportWidth})`,
    ).toBeLessThanOrEqual(viewportWidth);
  }

  // 3. The inline export error message renders inside the viewport.
  // Interception is the deterministic way to hit this slot -- the
  // erased-contact path would require erasing the contact mid-spec, and the
  // generic-error copy exercises the same reserved message slot.
  await page.route("**/dsr-export", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Внутренняя ошибка сервера" }),
    });
  });

  await exportButton.click();

  const message = page.getByText("Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.");
  await expect(message).toBeVisible();

  const messageBox = await message.boundingBox();
  expect(messageBox, "inline message must have a bounding box").not.toBeNull();
  if (messageBox) {
    expect(messageBox.x, `inline message x (${messageBox.x}) must be >= 0`).toBeGreaterThanOrEqual(0);
    expect(
      messageBox.x + messageBox.width,
      `inline message right edge (${messageBox.x + messageBox.width}) must be <= viewport width (${viewportWidth})`,
    ).toBeLessThanOrEqual(viewportWidth);
  }
});
