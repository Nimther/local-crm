import { test, expect } from "@playwright/test";

/**
 * MVP happy-path test for 03-03 (SEGM-01/02/04): register -> create
 * workspace -> open Сегменты -> build a segment (one attribute condition) ->
 * watch the live count -> name and save -> segment appears in the list.
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

  await page
    .getByRole("button", { name: "Создать сегмент" })
    .first()
    .click();
  await page.waitForURL(`**/w/${slug}/segments/new`);

  // The builder opens with one empty attribute condition row -- fill it in:
  // Страна = RU.
  await page.getByRole("button", { name: "Выберите поле" }).first().click();
  await page.getByRole("option", { name: "Страна" }).click();

  await page.getByPlaceholder("Значение").fill("RU");

  // Live count settles (debounced request-response).
  await expect(page.getByText(/контактов подходит/i)).toBeVisible({ timeout: 10_000 });

  const segmentName = `VIP Россия ${Date.now()}`;
  await page.getByLabel("Название сегмента").fill(segmentName);
  await page.getByRole("button", { name: "Сохранить сегмент" }).click();

  await page.waitForURL(`**/w/${slug}/segments`);
  await expect(page.getByText(segmentName)).toBeVisible();

  // Open the segment detail page (03-04): the definition builder is
  // prefilled and the «Участники» section renders (member rows or the
  // D-12 empty state).
  await page.getByText(segmentName).click();
  await page.waitForURL(/\/w\/[a-z0-9-]+\/segments\/[^/]+$/);

  await expect(page.getByRole("heading", { name: "Определение сегмента" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Страна" })).toBeVisible();
  await expect(page.getByPlaceholder("Значение")).toHaveValue("RU");

  await expect(page.getByRole("heading", { name: "Участники" })).toBeVisible();
  await expect(
    page.getByText("Пока никто не подходит под условия").or(page.getByRole("table"))
  ).toBeVisible();

  // Delete the segment via the row action + confirm dialog (03-04 Task 2):
  // navigate back to the list first, since the detail page has no delete
  // action of its own (delete lives on the list row per the plan's scope).
  await page.getByRole("link", { name: "Сегменты" }).click();
  await page.waitForURL(`**/w/${slug}/segments`);

  const segmentRow = page.getByRole("row", { name: new RegExp(segmentName) });
  await segmentRow.getByRole("button", { name: "Действия" }).click();
  await page.getByRole("menuitem", { name: "Удалить" }).click();
  await page.getByRole("button", { name: "Удалить сегмент" }).click();

  await expect(page.getByRole("row", { name: new RegExp(segmentName) })).toHaveCount(0);
});
