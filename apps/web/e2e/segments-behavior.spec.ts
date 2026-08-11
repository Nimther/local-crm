import { test, expect, type Page } from "@playwright/test";

/**
 * Gap-closure coverage for 03-08 (SEGM-02 + SEGM-04) -- the two
 * `behavior_unverified_items` from 03-VERIFICATION.md that were present and
 * wired but had no automated test:
 *
 * 1. SEGM-02: the behavioral condition row's conditional inputs (the count
 *    number input hides on «ни разу» / shows on «выполнено ≥ N раз»; the
 *    days input hides on «за всё время» / shows on «за последние N дней»)
 *    and its save/reopen round-trip.
 * 2. SEGM-04: the degraded live-count state (amber «(устарело)» marker,
 *    last-good count never blanked). A real `statement_timeout` cannot be
 *    forced at this test-data volume, so this test uses Playwright
 *    `page.route` interception to return the exact `{ degraded: true }`
 *    shape the real preview-count route emits on Postgres error 57014 (the
 *    API side of that mechanism is proven separately by
 *    `preview-count.test.ts`).
 *
 * Kept as its own spec file -- the existing happy-path segments.spec.ts is
 * left untouched.
 */

/** Register a fresh owner, create a workspace, and land on `/w/:slug`. Returns the slug. */
async function registerAndCreateWorkspace(page: Page): Promise<string> {
  const email = `owner-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  await page.goto("/register");
  await page.getByLabel(/имя/i).fill("Segments Behavior Owner");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/пароль/i).fill("correct horse battery staple 42");
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();

  await page.waitForURL("**/create-workspace");
  await page.getByLabel(/название/i).fill(`Behavior Test ${Date.now()}`);
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

/**
 * Selects `optionName` from the Nth Radix Select-role combobox on the page
 * (0-indexed, in DOM order). The builder's custom Field/Event comboboxes are
 * plain buttons (no `combobox` role -- 03-03-STATE decision), so this only
 * ever matches the behavioral row's countOperator/timeframe `<Select>`s.
 */
async function selectComboboxOption(page: Page, index: number, optionName: string): Promise<void> {
  await page.getByRole("combobox").nth(index).click();
  await page.getByRole("option", { name: optionName }).click();
}

test("behavioral conditional inputs hide/show correctly and round-trip through save (SEGM-02)", async ({ page }) => {
  const slug = await registerAndCreateWorkspace(page);
  await openSegmentCreatePage(page, slug);

  // Remove the default (empty) attribute condition so the group ends up
  // with only the behavioral condition under test.
  await page.getByRole("button", { name: "Удалить условие" }).click();

  await page.getByRole("button", { name: "Добавить условие" }).click();
  await page.getByRole("menuitem", { name: "По событию" }).click();

  // Free-text event name via the combobox fallback (no observed events yet).
  await page.getByRole("button", { name: "Выберите событие" }).click();
  await page.getByPlaceholder("Поиск события…").fill("purchase completed");
  await page.getByRole("button", { name: "Использовать «purchase completed»" }).click();

  // Default state: countOperator=at_least -- count input visible.
  await expect(page.getByPlaceholder("Количество")).toBeVisible();
  // Default state: timeframe=all_time -- days input hidden.
  await expect(page.getByPlaceholder("Дней")).not.toBeVisible();

  // Switch countOperator to «ни разу» -- count input must hide.
  await selectComboboxOption(page, 0, "ни разу");
  await expect(page.getByPlaceholder("Количество")).not.toBeVisible();

  // Switch back to «выполнено ≥ N раз» -- count input must reappear.
  await selectComboboxOption(page, 0, "выполнено ≥ N раз");
  await expect(page.getByPlaceholder("Количество")).toBeVisible();
  await page.getByPlaceholder("Количество").fill("2");

  // Switch timeframe to «за последние N дней» -- days input must appear.
  await selectComboboxOption(page, 1, "за последние N дней");
  await expect(page.getByPlaceholder("Дней")).toBeVisible();
  await page.getByPlaceholder("Дней").fill("30");

  // Switch back to «за всё время» -- days input must hide again.
  await selectComboboxOption(page, 1, "за всё время");
  await expect(page.getByPlaceholder("Дней")).not.toBeVisible();

  // Restore the concrete condition under test: «выполнено ≥ 2 раз» «за
  // последние 30 дней».
  await selectComboboxOption(page, 1, "за последние N дней");
  await page.getByPlaceholder("Дней").fill("30");

  const segmentName = `Behavior Roundtrip ${Date.now()}`;
  await page.getByLabel("Название сегмента").fill(segmentName);
  await page.getByRole("button", { name: "Сохранить сегмент" }).click();

  await page.waitForURL(`**/w/${slug}/segments`);
  await expect(page.getByText(segmentName)).toBeVisible();

  // Reopen the segment: the behavioral row must round-trip in full.
  await page.getByText(segmentName).click();
  await page.waitForURL(/\/w\/[a-z0-9-]+\/segments\/[^/]+$/);

  await expect(page.getByRole("heading", { name: "Определение сегмента" })).toBeVisible();
  await expect(page.getByRole("button", { name: "purchase completed" })).toBeVisible();
  await expect(page.getByText("выполнено ≥ N раз")).toBeVisible();
  await expect(page.getByPlaceholder("Количество")).toHaveValue("2");
  await expect(page.getByText("за последние N дней")).toBeVisible();
  await expect(page.getByPlaceholder("Дней")).toHaveValue("30");
});

test("degraded live-count state shows the amber marker and preserves the last-good count (SEGM-04)", async ({
  page,
}) => {
  const slug = await registerAndCreateWorkspace(page);
  await openSegmentCreatePage(page, slug);

  // Build a simple, valid attribute condition so a real (non-intercepted)
  // count settles first -- this is the "last-good count" the degraded state
  // must preserve.
  await page.getByRole("button", { name: "Выберите поле" }).first().click();
  await page.getByRole("option", { name: "Страна" }).click();
  await page.getByPlaceholder("Значение").fill("RU");

  await expect(page.getByText(/контактов подходит/i)).toBeVisible({ timeout: 10_000 });

  const countParagraph = page.getByText(/контактов подходит/i).locator("xpath=preceding-sibling::p[1]");
  await expect(countParagraph).toBeVisible();
  const lastGoodText = (await countParagraph.textContent())?.trim();
  expect(lastGoodText).toBeTruthy();
  expect(lastGoodText).not.toBe("—");

  // Now intercept the preview-count route to return the exact degraded
  // shape the real route emits on a 57014 statement-timeout, and trigger a
  // re-evaluation by editing the condition's value.
  await page.route("**/segments/preview-count", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ degraded: true }),
    });
  });

  await page.getByPlaceholder("Значение").fill("US");

  await expect(page.getByText("(устарело)")).toBeVisible({ timeout: 10_000 });

  // The last-good count must still be displayed alongside the amber marker
  // -- never blanked to «—» or replaced entirely by the degraded response.
  await expect(countParagraph).toContainText(lastGoodText as string);
});
