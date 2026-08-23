import { test, expect } from "@playwright/test";

import { registerAndCreateWorkspace, createContactViaApi } from "./helpers/workspace-setup";

/**
 * Gap-closure regression for G-21-2 (UAT Phase 21 Test 2): the contact
 * card's «Удалить контакт» action must perform the DELETE and erase the
 * contact. This is the automated form of the UAT path that first surfaced
 * apiFetch's unconditional Content-Type: application/json header breaking
 * every bodyless delete (see .planning/debug/ui-delete-empty-json-body-400.md).
 *
 * A response listener logs the DELETE call's status/body whenever it is not
 * 2xx, behind the `[contact-delete:response]` prefix -- without it a failure
 * here is only a generic UI error/timeout with no server-side reason in the
 * run log. Kept after the fix so a future regression reports the server's
 * actual refusal code instead of only a failed assertion.
 */
test("clicking «Удалить контакт» deletes the contact and returns to the list", async ({ page }) => {
  page.on("response", (response) => {
    const request = response.request();
    if (request.method() === "DELETE" && response.url().includes("/contacts/") && !response.ok()) {
      void response
        .text()
        .then((body) => {
          console.log(`[contact-delete:response] status=${response.status()} body=${body}`);
        })
        .catch(() => {
          console.log(`[contact-delete:response] status=${response.status()} body=<unreadable>`);
        });
    }
  });

  const slug = await registerAndCreateWorkspace(page, "Contact Delete");
  const email = `contact-${Date.now()}@example.com`;
  const contactId = await createContactViaApi(page, slug, {
    email,
    firstName: "Delete",
    lastName: "Me",
  });

  await page.goto(`/w/${slug}/contacts/${contactId}`);
  await expect(page.getByRole("button", { name: "Удалить контакт" })).toBeVisible();

  await page.getByRole("button", { name: "Удалить контакт" }).click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  // Scoped to the dialog: the trigger and the dialog's confirm action share
  // the same accessible name ("Удалить контакт"), so an unscoped
  // page-level click by name hits a Playwright strict-mode violation.
  await dialog.getByRole("button", { name: "Удалить контакт" }).click();

  await page.waitForURL(`**/w/${slug}/contacts`);
  await expect(page.getByText(email)).toHaveCount(0);
});
