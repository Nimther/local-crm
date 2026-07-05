import { test, expect } from "@playwright/test";

/**
 * RED test for 02-13 (UAT Test 2, major): the contact list search input
 * must keep focus while the user types, even though every debounced
 * keystroke change fires a new list query. Root cause (diagnosed in
 * .planning/debug/contact-search-focus-loss.md): ContactsListPage has a
 * full-page skeleton early-return on contactsQuery.isLoading that sits
 * ABOVE the search toolbar, and the query lacks
 * `placeholderData: keepPreviousData` -- so every new search queryKey with
 * no cached data re-enters isLoading, unmounting the toolbar/input and
 * dropping focus to <body>.
 *
 * This spec MUST fail before the 02-13 Task 2 fix is applied.
 */
test("typing character-by-character into the contact search keeps focus and accumulates the value", async ({
  page,
}) => {
  const email = `owner-${Date.now()}@example.com`;

  await page.goto("/register");
  await page.getByLabel(/имя/i).fill("Search Focus Owner");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/пароль/i).fill("correct horse battery staple 42");
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();

  await page.waitForURL("**/create-workspace");
  await page.getByLabel(/название/i).fill(`Focus Test ${Date.now()}`);
  await page.getByRole("button", { name: "Создать воркспейс" }).click();

  await page.waitForURL(/\/w\/[a-z0-9-]+/);
  const slug = new URL(page.url()).pathname.match(/\/w\/([a-z0-9-]+)/)?.[1];
  expect(slug).toBeTruthy();

  // Seed 2 contacts so the results region renders a table. Best-effort
  // realism aid only -- the focus assertion below does not depend on it:
  // typing any character sets hasActiveFilters=true and triggers the
  // debounced query regardless of how many contacts exist.
  for (const seedEmail of ["seed1@example.com", "seed2@example.com"]) {
    const response = await page.request.post(`/api/workspaces/${slug}/contacts`, {
      data: { email: seedEmail },
    });
    expect(response.ok()).toBeTruthy();
  }

  await page.goto(`/w/${slug}/contacts`);
  const searchInput = page.getByPlaceholder("Поиск по email, имени или external_id");

  await searchInput.click();
  await expect(searchInput).toBeFocused();

  const target = "maria@example.com";

  // Use page.keyboard.type (NOT locator.pressSequentially / locator.fill):
  // pressSequentially and fill re-focus the located element before/during
  // each keypress, which would mask the unmount-driven focus loss this test
  // exists to catch. page.keyboard dispatches to whatever element currently
  // holds focus -- so once the debounced skeleton swap unmounts the input,
  // the next character lands on <body> and both assertions below fail,
  // exactly reproducing the reported bug.
  for (const char of target) {
    await page.keyboard.type(char);
    // Exceeds the 300ms debounce so a refetch fires mid-typing.
    await page.waitForTimeout(350);
    await expect(searchInput).toBeFocused();
  }

  await expect(searchInput).toHaveValue(target);
});
