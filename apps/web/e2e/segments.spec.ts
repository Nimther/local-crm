import { test, expect } from "@playwright/test";

/**
 * MVP happy-path RED test for 03-03 (SEGM-01/02/04): register -> create
 * workspace -> open Сегменты -> build a segment (one attribute condition) ->
 * watch the live count -> name and save -> segment appears in the list.
 * MUST fail until Task 3 wires up the builder's live count + save flow.
 */
test("build, preview, and save a segment from the Сегменты section", async ({ page }) => {
  const email = `owner-${Date.now()}@example.com`;

  await page.goto("/register");
  await page.getByLabel(/имя/i).fill("Segments Owner");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/пароль/i).fill("correct horse battery staple 42");
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();

  await page.waitForURL("**/create-workspace");
  await page.getByLabel(/название/i).fill(`Segments Test ${Date.now()}`);
  await page.getByRole("button", { name: "Создать воркспейс" }).click();

  await page.waitForURL(/\/w\/[a-z0-9-]+/);
  const slug = new URL(page.url()).pathname.match(/\/w\/([a-z0-9-]+)/)?.[1];
  expect(slug).toBeTruthy();

  await page.getByRole("link", { name: "Сегменты" }).click();
  await page.waitForURL(`**/w/${slug}/segments`);
  await expect(page.getByText("Сегментов пока нет")).toBeVisible();

  await page.getByRole("button", { name: "Создать сегмент" }).click();
  await page.waitForURL(`**/w/${slug}/segments/new`);

  // Add one attribute condition: Страна = RU.
  await page.getByRole("button", { name: "Добавить условие" }).click();
  await page.getByRole("menuitem", { name: "По свойству" }).click();

  await page.getByRole("button", { name: "Выберите поле" }).click();
  await page.getByRole("option", { name: "Страна" }).click();

  await page.getByPlaceholder("Значение").fill("RU");

  // Live count settles (debounced request-response).
  await expect(page.getByText(/контактов подходит/i)).toBeVisible({ timeout: 10_000 });

  const segmentName = `VIP Россия ${Date.now()}`;
  await page.getByLabel("Название сегмента").fill(segmentName);
  await page.getByRole("button", { name: "Сохранить сегмент" }).click();

  await page.waitForURL(`**/w/${slug}/segments`);
  await expect(page.getByText(segmentName)).toBeVisible();
});
