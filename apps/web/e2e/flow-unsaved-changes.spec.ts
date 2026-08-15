import { test, expect, type Page } from "@playwright/test";

/**
 * OPS-19/D-13 end-to-end proof of both unsaved-canvas guards (15-09):
 *
 * 1. In-app navigation with unsaved changes -> the confirmation dialog
 *    appears; "Остаться" cancels the navigation and leaves the canvas
 *    unchanged; "Уйти без сохранения" proceeds.
 * 2. With everything saved, the same nav click navigates with no dialog.
 * 3. A failed draft save (route interception on the draft PATCH) shows the
 *    persistent SaveErrorBanner with Retry; the toolbar indicator never
 *    reads "Сохранено"; clicking Retry after restoring the route makes the
 *    banner disappear.
 * 4/5. The native `beforeunload` prompt fires on reload while dirty and does
 *    not fire when clean -- asserted on the dialog event itself (native
 *    prompts are browser-controlled and cannot be asserted by message text).
 *
 * Follows the established e2e conventions (register-and-create-workspace
 * fixture shape from segments-behavior.spec.ts, same fail-closed provisioned
 * database via run-e2e.ts/provision-database.ts -- no new test harness).
 */

/** Register a fresh owner, create a workspace, and land on `/w/:slug`. Returns the slug. */
async function registerAndCreateWorkspace(page: Page): Promise<string> {
  const email = `owner-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  await page.goto("/register");
  await page.getByLabel(/имя/i).fill("Unsaved Changes Owner");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/пароль/i).fill("correct horse battery staple 42");
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();

  await page.waitForURL("**/create-workspace");
  await page.getByLabel(/название/i).fill(`Unsaved Test ${Date.now()}`);
  await page.getByRole("button", { name: "Создать воркспейс" }).click();

  await page.waitForURL(/\/w\/[a-z0-9-]+/);
  const slug = new URL(page.url()).pathname.match(/\/w\/([a-z0-9-]+)/)?.[1];
  expect(slug).toBeTruthy();
  return slug as string;
}

/** Create a new flow via the list-page dialog and land on its canvas. Returns the flow id. */
async function createFlowAndOpenCanvas(page: Page, slug: string): Promise<string> {
  await page.getByRole("link", { name: "Цепочки" }).click();
  await page.waitForURL(`**/w/${slug}/flows`);

  await page.getByRole("button", { name: "Создать цепочку" }).first().click();
  const name = `Flow ${Date.now()}`;
  await page.getByLabel("Название").fill(name);
  await page.getByRole("dialog").getByRole("button", { name: "Создать цепочку" }).click();

  await page.waitForURL(new RegExp(`/w/${slug}/flows/[^/]+$`));
  const id = new URL(page.url()).pathname.split("/").pop();
  expect(id).toBeTruthy();
  return id as string;
}

/**
 * Selects the seeded Trigger node and sets a free-text event name via the
 * combobox fallback -- the smallest edit that changes the serialized
 * definition and therefore dirties the canvas (initialCanvas already seeds
 * one unconfigured Trigger node, so this is a real edit, not the baseline).
 */
async function dirtyCanvas(page: Page): Promise<void> {
  // React Flow wraps each node with a `.react-flow__node-{type}` class --
  // targeting that (not the label text) avoids matching NodePalette's own
  // identically-labelled "Триггер" draggable row.
  await page.locator(".react-flow__node-trigger").click();
  await page.getByRole("button", { name: "Выберите событие" }).click();
  await page.getByPlaceholder("Поиск события…").fill("checkout completed");
  await page.getByRole("button", { name: "Использовать «checkout completed»" }).click();
}

test.describe("OPS-19: unsaved canvas changes guard", () => {
  test("in-app navigation with unsaved changes opens the dialog; stay cancels, discard navigates", async ({
    page,
  }) => {
    const slug = await registerAndCreateWorkspace(page);
    await createFlowAndOpenCanvas(page, slug);
    await dirtyCanvas(page);

    // The debounce has not settled yet -- the canvas is unsaved right now.
    await page.getByRole("link", { name: "Цепочки" }).click();

    await expect(page.getByRole("alertdialog")).toBeVisible();
    await expect(page.getByText("Есть несохранённые изменения")).toBeVisible();

    // Stay: cancels the navigation, canvas is untouched, still on the flow URL.
    await page.getByRole("button", { name: "Остаться" }).click();
    await expect(page.getByRole("alertdialog")).not.toBeVisible();
    expect(page.url()).toMatch(new RegExp(`/w/${slug}/flows/[^/]+$`));
    await expect(page.getByRole("button", { name: "checkout completed" })).toBeVisible();

    // Discard: proceeds with the navigation the marketer originally triggered.
    await page.getByRole("link", { name: "Цепочки" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "Уйти без сохранения" }).click();
    await page.waitForURL(`**/w/${slug}/flows`);
  });

  test("with everything saved, the same nav click navigates with no dialog", async ({ page }) => {
    const slug = await registerAndCreateWorkspace(page);
    const flowId = await createFlowAndOpenCanvas(page, slug);
    await dirtyCanvas(page);

    // The toolbar's three-state indicator reads "Сохранено" whenever nothing
    // is in flight and nothing has errored -- INCLUDING the ~1s debounce
    // window before the PATCH even fires (deriveAutosaveState, unchanged by
    // this plan). That text alone is therefore not a reliable "fully
    // settled" signal for this test; wait on the actual draft PATCH
    // succeeding instead.
    await page.waitForResponse(
      (response) =>
        response.url().includes(`/api/workspaces/${slug}/flows/${flowId}`) &&
        response.request().method() === "PATCH" &&
        response.ok(),
      { timeout: 10_000 }
    );
    await expect(page.getByText("Сохранено", { exact: true })).toBeVisible({ timeout: 10_000 });

    await page.getByRole("link", { name: "Цепочки" }).click();
    await page.waitForURL(`**/w/${slug}/flows`);
    await expect(page.getByRole("alertdialog")).not.toBeVisible();
  });

  test("a failed draft save shows a persistent banner with Retry; toolbar never reads saved; Retry clears it", async ({
    page,
  }) => {
    const slug = await registerAndCreateWorkspace(page);
    const flowId = await createFlowAndOpenCanvas(page, slug);

    const draftPatchUrl = `**/api/workspaces/${slug}/flows/${flowId}`;

    // FAILURE INJECTION -- intercept only the draft PATCH (the publish/pause/
    // resume/delete actions are separate POST/DELETE routes on the same base
    // path and are unaffected by this method filter).
    await page.route(draftPatchUrl, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
    });

    await dirtyCanvas(page);

    // The persistent banner appears (not a toast) once the debounced PATCH
    // fails, and the toolbar indicator must never read "Сохранено" while it
    // is showing.
    await expect(page.getByRole("alert")).toContainText("Не удалось сохранить изменения холста", {
      timeout: 10_000,
    });
    await expect(page.getByText("Сохранено", { exact: true })).not.toBeVisible();
    await expect(page.getByText("Не сохранено", { exact: false })).toBeVisible();

    // Restore the real route, then click Retry -- re-attempts the SAME save
    // without requiring another edit.
    await page.unroute(draftPatchUrl);
    await page.getByRole("button", { name: "Повторить" }).click();

    await expect(page.getByRole("alert")).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Сохранено", { exact: true })).toBeVisible({ timeout: 10_000 });
  });

  test("beforeunload fires on reload while dirty and does not fire when clean", async ({ page }) => {
    const slug = await registerAndCreateWorkspace(page);
    await createFlowAndOpenCanvas(page, slug);

    // --- Dirty case: the debounce has not settled, edit is unsaved. ---
    await dirtyCanvas(page);

    let dirtyDialogType: string | null = null;
    page.once("dialog", (dialog) => {
      dirtyDialogType = dialog.type();
      void dialog.dismiss();
    });
    // Native leave-confirmation prompts are asserted on the dialog EVENT
    // itself, never by message text -- the browser controls that copy.
    // reload() blocks on the pending dialog, so it is not awaited directly;
    // the dialog listener above resolves the promise by dismissing it.
    void page.reload().catch(() => {});
    await expect.poll(() => dirtyDialogType, { timeout: 10_000 }).toBe("beforeunload");

    // Reload actually happened (or was cancelled) -- re-sync to a known URL
    // before the clean-state assertion below, independent of which occurred.
    await page.goto(`/w/${slug}/flows`);

    // --- Clean case: freshly created flow, canvas is not dirtied at all. ---
    await createFlowAndOpenCanvas(page, slug);
    await expect(page.getByText("Сохранено", { exact: true })).toBeVisible({ timeout: 10_000 });

    let cleanDialogFired = false;
    page.once("dialog", (dialog) => {
      cleanDialogFired = true;
      void dialog.dismiss();
    });
    await page.reload();
    expect(cleanDialogFired).toBe(false);
  });
});
