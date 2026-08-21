import { test, expect, type Page } from "@playwright/test";

/**
 * Click-through proof of TMPL-01/TMPL-02's two interaction-level success
 * criteria (Phase 20 ROADMAP.md SC1 and SC3). apps/web's unit lane is
 * `environment: "node"` with no jsdom/Testing Library (segmentSaveGate.
 * test.ts's precedent), so neither of the two behaviours below -- a real
 * click disabling a real button, a real dialog staying open after a real
 * 409 -- can be proven there. This spec is that proof, following the
 * established e2e conventions exactly (registration fixture shape from
 * flow-unsaved-changes.spec.ts/segments-behavior.spec.ts, the same
 * fail-closed provisioned database via run-e2e.ts -- no new harness, no new
 * dependency).
 *
 * 1. "unsaved changes block all three actions" (SC1): edits a saved,
 *    launchable campaign's name without saving and asserts the banner
 *    appears and all three send actions (launch-now, schedule, test-send)
 *    disable; saving re-enables all three.
 * 2. "a stale send conflicts, stays open and dispatches nothing" (SC3):
 *    opens the launch dialog, mutates the same campaign from outside it
 *    (bumping its version), clicks «Отправить», and asserts the dialog
 *    stays open, the version-conflict copy renders, exactly one launch
 *    request was made, and the campaign is still a draft.
 * 3. "an illegal-transition conflict names the real state and the dialog
 *    survives the refetch that reveals it" (D-09, human-verification
 *    checkpoint failure fixed by this commit): opens the launch dialog on a
 *    draft campaign, SCHEDULES the same campaign from outside it (a real
 *    status change, not just a version bump), clicks «Отправить», and
 *    asserts the dialog is STILL VISIBLE showing
 *    «Кампания уже в статусе «Запланирована»…» -- proving
 *    `CampaignDetailPage`'s status-branched render no longer unmounts an
 *    open dialog out from under the conflict copy it is about to show.
 *
 * Both tests reach a launchable campaign by PATCHing `templateId` and
 * `fromEmail` directly through `page.request` rather than driving the
 * template/sender comboboxes -- those pickers list a tenant's real SendGrid
 * Dynamic Templates/verified senders and have nothing to list without a
 * live SendGrid key. The API accepts any non-empty `templateId` string
 * (createCampaignSchema/updateCampaignSchema place no provider-side
 * constraint on it), so this is a legitimate shortcut to a launchable draft,
 * not a weakened assertion -- both assertions below are about the send
 * DECISION (blocked vs not, conflict vs not), never about what SendGrid
 * actually renders. Confirming that a real Dynamic Template is honoured is
 * deliberately out of scope here; that is the plan's Task 3 human
 * checkpoint against a real SendGrid workspace.
 */

/** Register a fresh owner, create a workspace, and land on `/w/:slug`. Returns the slug. */
async function registerAndCreateWorkspace(page: Page): Promise<string> {
  const email = `owner-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  await page.goto("/register");
  await page.getByLabel(/имя/i).fill("Template Correctness Owner");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/пароль/i).fill("correct horse battery staple 42");

  const signUpResponse = page.waitForResponse(
    (response) => response.url().endsWith("/api/auth/sign-up/email") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();

  // Same backoff-respecting retry as segments-behavior.spec.ts -- the full
  // serial E2E corpus legitimately exercises enough /api/auth/* requests to
  // reach the production-shaped shared rate-limit bucket.
  const response = await signUpResponse;
  if (response.status() === 429) {
    const retryAfterSeconds = Number(response.headers()["retry-after"] ?? "1");
    await page.waitForTimeout((Number.isFinite(retryAfterSeconds) ? retryAfterSeconds + 1 : 2) * 1_000);
    await page.getByRole("button", { name: "Зарегистрироваться" }).click();
  }

  await page.waitForURL("**/create-workspace");
  await page.getByLabel(/название/i).fill(`Template Correctness ${Date.now()}`);
  await page.getByRole("button", { name: "Создать воркспейс" }).click();

  await page.waitForURL(/\/w\/[a-z0-9-]+/);
  const slug = new URL(page.url()).pathname.match(/\/w\/([a-z0-9-]+)/)?.[1];
  expect(slug).toBeTruthy();
  return slug as string;
}

/**
 * Creates a segment with one trivially-true attribute condition
 * ("country" is_not_empty) directly through the API -- the segment
 * BUILDER's own UI interaction is covered by segments-behavior.spec.ts;
 * this spec only needs a valid segmentId a campaign can reference.
 */
async function createSegment(page: Page, slug: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${slug}/segments`, {
    data: {
      name: `Template Correctness Segment ${Date.now()}`,
      definition: {
        version: 1,
        groups: [
          {
            conditions: [{ type: "attribute", source: "standard", field: "country", operator: "is_not_empty" }],
          },
        ],
      },
    },
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { id: string };
  return body.id;
}

/** Creates a draft campaign for `segmentId` directly through the API. Returns its id. */
async function createCampaign(page: Page, slug: string, segmentId: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${slug}/campaigns`, {
    data: { name: `Template Correctness Campaign ${Date.now()}`, segmentId },
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { id: string };
  return body.id;
}

/**
 * PATCHes `templateId`/`fromEmail` onto a draft campaign so it satisfies
 * `computeIncompleteReason` (segment already set at creation) and becomes
 * launchable without a live SendGrid key -- see the file header comment for
 * why this is a legitimate substitute for driving the template/sender
 * comboboxes.
 */
async function makeCampaignLaunchable(page: Page, slug: string, campaignId: string): Promise<void> {
  const response = await page.request.patch(`/api/workspaces/${slug}/campaigns/${campaignId}`, {
    data: { templateId: "d-test-template-0000000000000000", fromEmail: "sender@example.com" },
  });
  expect(response.ok()).toBe(true);
}

async function getCampaignStatus(page: Page, slug: string, campaignId: string): Promise<string> {
  const response = await page.request.get(`/api/workspaces/${slug}/campaigns/${campaignId}`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { status: string };
  return body.status;
}

/**
 * Schedules the campaign from OUTSIDE the open dialog -- draft -> scheduled,
 * one minute in the future, using the campaign's OWN current version (a
 * fresh GET immediately before, not the stale value the open launch dialog
 * is holding). `campaign.repository.ts`'s `launchCampaign` checks
 * `existing.status !== "draft"` BEFORE it ever compares a version, so this
 * is what makes the launch click below hit `illegal_transition` specifically
 * (not `version_conflict`, which SC3 above already covers) -- a scheduled
 * campaign is a real state, not a raced version bump.
 */
async function scheduleCampaignFromOutside(page: Page, slug: string, campaignId: string): Promise<void> {
  const getResponse = await page.request.get(`/api/workspaces/${slug}/campaigns/${campaignId}`);
  expect(getResponse.ok()).toBe(true);
  const { version } = (await getResponse.json()) as { version: number };

  const scheduledAt = new Date(Date.now() + 60_000).toISOString();
  const response = await page.request.post(`/api/workspaces/${slug}/campaigns/${campaignId}/schedule`, {
    data: { scheduledAt, expectedVersion: version },
  });
  expect(response.ok()).toBe(true);
}

test.describe("TMPL-01/TMPL-02: unsaved-changes blocking and conflict recovery", () => {
  test("unsaved changes block launch (both modes) and test-send; saving re-enables them (SC1)", async ({
    page,
  }) => {
    const slug = await registerAndCreateWorkspace(page);
    const segmentId = await createSegment(page, slug);
    const campaignId = await createCampaign(page, slug, segmentId);
    await makeCampaignLaunchable(page, slug, campaignId);

    await page.goto(`/w/${slug}/campaigns/${campaignId}`);
    await expect(page.getByRole("heading", { name: "Изменить кампанию" })).toBeVisible();

    const launchNowButton = page.getByRole("button", { name: "Отправить сейчас" });
    const scheduleRadio = page.getByRole("radio", { name: "Запланировать на дату и время" });
    const scheduleButton = page.getByRole("button", { name: "Запланировать" });
    const testSendButton = page.getByRole("button", { name: "Отправить тестовое письмо" });

    // Clean state: all three enabled (the campaign is already complete --
    // segment/template/sender all set -- so nothing but dirtiness gates them).
    await expect(launchNowButton).toBeEnabled();
    await expect(testSendButton).toBeEnabled();

    // Dirty the form: any one of the four compared fields is enough (D-02).
    const nameInput = page.getByLabel("Название кампании");
    await nameInput.fill(`${await nameInput.inputValue()} (edited)`);

    await expect(page.getByText("Есть несохранённые изменения")).toBeVisible();
    await expect(launchNowButton).toBeDisabled();
    await expect(testSendButton).toBeDisabled();

    // "Запланировать" mode -- the plan requires checking BOTH radio modes,
    // since LaunchScheduleActions renders one primary button whose label and
    // dialog depend on the selected mode.
    await scheduleRadio.click();
    await expect(scheduleButton).toBeDisabled();

    // Save via the banner's own button -- reuses the same save mutation as
    // the builder's "Сохранить черновик" (D-03).
    await page.getByRole("button", { name: "Сохранить", exact: true }).click();

    await expect(page.getByText("Есть несохранённые изменения")).not.toBeVisible();
    await expect(scheduleButton).toBeEnabled();
    await expect(testSendButton).toBeEnabled();
  });

  test("a stale launch conflicts, the dialog stays open, and nothing is dispatched (SC3)", async ({ page }) => {
    const slug = await registerAndCreateWorkspace(page);
    const segmentId = await createSegment(page, slug);
    const campaignId = await createCampaign(page, slug, segmentId);
    await makeCampaignLaunchable(page, slug, campaignId);

    await page.goto(`/w/${slug}/campaigns/${campaignId}`);
    await expect(page.getByRole("heading", { name: "Изменить кампанию" })).toBeVisible();

    let launchRequestCount = 0;
    await page.route(`**/api/workspaces/${slug}/campaigns/${campaignId}/launch`, async (route) => {
      launchRequestCount += 1;
      await route.continue();
    });

    await page.getByRole("button", { name: "Отправить сейчас" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Mutate the SAME campaign from outside the open dialog -- this is what
    // bumps `campaigns.version` out from under the value the open dialog is
    // still holding, the exact precondition a stale `expectedVersion` needs.
    const renameResponse = await page.request.patch(`/api/workspaces/${slug}/campaigns/${campaignId}`, {
      data: { name: "Renamed From Outside The Dialog" },
    });
    expect(renameResponse.ok()).toBe(true);

    await page.getByRole("dialog").getByRole("button", { name: "Отправить" }).click();

    // Dialog stays open, D-08's exact copy renders, and no automatic retry
    // fires a second request (T-20-06-01).
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText("Кампания была изменена — данные обновлены, проверьте и повторите")).toBeVisible();
    await expect.poll(() => launchRequestCount).toBe(1);

    // The campaign never transitioned -- checked directly through the API
    // rather than through the DOM, since the dialog overlay may render on
    // top of (not replace) the underlying draft view.
    expect(await getCampaignStatus(page, slug, campaignId)).toBe("draft");
  });

  test("an illegal-transition conflict names the real state and keeps the dialog open through the status refetch (D-09)", async ({
    page,
  }) => {
    const slug = await registerAndCreateWorkspace(page);
    const segmentId = await createSegment(page, slug);
    const campaignId = await createCampaign(page, slug, segmentId);
    await makeCampaignLaunchable(page, slug, campaignId);

    await page.goto(`/w/${slug}/campaigns/${campaignId}`);
    await expect(page.getByRole("heading", { name: "Изменить кампанию" })).toBeVisible();

    let launchRequestCount = 0;
    await page.route(`**/api/workspaces/${slug}/campaigns/${campaignId}/launch`, async (route) => {
      launchRequestCount += 1;
      await route.continue();
    });

    await page.getByRole("button", { name: "Отправить сейчас" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Real status change from OUTSIDE the open dialog -- draft -> scheduled --
    // not just a version bump. This is the exact precondition the human
    // checkpoint's step 4 exercised and the previous composition unmounted
    // the dialog under: the refetch this conflict triggers below flips
    // `campaign.status` away from "draft", which used to take the whole
    // draft branch (and the open dialog inside it) down with it.
    await scheduleCampaignFromOutside(page, slug, campaignId);

    await page.getByRole("dialog").getByRole("button", { name: "Отправить" }).click();

    // The dialog survives the refetch and names the campaign's REAL current
    // state using the same label CampaignStatusBadge shows (D-09) -- not the
    // generic «что-то пошло не так» and not silence.
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(
      page.getByText("Кампания уже в статусе «Запланирована» — данные обновлены, проверьте и повторите")
    ).toBeVisible();
    await expect.poll(() => launchRequestCount).toBe(1);

    expect(await getCampaignStatus(page, slug, campaignId)).toBe("scheduled");
  });
});
