import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

import { DIRTY_BLOCK_REASON } from "../campaignDirtyState";
import { CampaignDirtyStateContext, type CampaignDirtyStateContextValue } from "../CampaignDirtyStateContext";
import { UnsavedChangesBanner } from "../UnsavedChangesBanner";
import { LaunchScheduleActions } from "../LaunchScheduleDialogs";
import { TestSendPanel } from "../TestSendPanel";
import CampaignBuilderPage from "../CampaignBuilderPage";
import type { CampaignResponse } from "../api";

/**
 * TMPL-01/D-01: no jsdom/@testing-library in this repo's node-lane vitest
 * config (same constraint documented in campaign-progress-ambiguous.test.tsx)
 * -- `renderToStaticMarkup` plus a seeded QueryClient renders the real
 * components without a DOM. `@/lib/authClient` evaluates
 * `window.location.origin` at module scope (used by TestSendPanel's
 * `useSession`), so it is mocked below rather than imported for real.
 *
 * RED (this plan's Task 3): fails today because LaunchScheduleActions and
 * TestSendPanel do not read the dirty context at all, so their disabled
 * expressions and inline reasons never reflect it.
 * GREEN: both components read `useCampaignDirtyState()` and fold `isDirty`
 * into their existing disabled expression, rendering the block reason
 * through the same `<p className="text-sm text-destructive">` element
 * already used for the incomplete-reason/generic-error copy.
 */

vi.mock("@/lib/authClient", () => ({
  useSession: () => ({ data: null }),
}));

const SLUG = "acme";
const CAMPAIGN_ID = "campaign-1";

function baseCampaign(overrides: Partial<CampaignResponse> = {}): CampaignResponse {
  return {
    id: CAMPAIGN_ID,
    workspaceId: "workspace-1",
    name: "Spring Sale",
    status: "draft",
    segmentId: "segment-1",
    templateId: "template-1",
    fromSenderId: "sender-1",
    fromEmail: null,
    scheduledAt: null,
    sendableTotal: null,
    sentCount: 0,
    failedCount: 0,
    version: 1,
    excludedTotal: null,
    sendingStartedAt: null,
    terminalAt: null,
    deliveredCount: 0,
    openedCount: 0,
    clickedCount: 0,
    bouncedCount: 0,
    unsubscribedCount: 0,
    createdByUserId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function dirtyValue(overrides: Partial<CampaignDirtyStateContextValue> = {}): CampaignDirtyStateContextValue {
  return {
    isDirty: true,
    blockReason: DIRTY_BLOCK_REASON,
    isSaving: false,
    save: () => {},
    publish: () => {},
    ...overrides,
  };
}

function cleanValue(overrides: Partial<CampaignDirtyStateContextValue> = {}): CampaignDirtyStateContextValue {
  return {
    isDirty: false,
    blockReason: null,
    isSaving: false,
    save: () => {},
    publish: () => {},
    ...overrides,
  };
}

function renderWithContext(
  node: ReactNode,
  value: CampaignDirtyStateContextValue,
  queryClient: QueryClient = new QueryClient()
): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <CampaignDirtyStateContext.Provider value={value}>{node}</CampaignDirtyStateContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

/**
 * Extracts the opening tag of the `<button>` immediately preceding the LAST
 * occurrence of `label` in the markup, for a precise assertion (the primary
 * submit button's own text can also appear as a radio-group `<label>`
 * earlier in the same markup, e.g. "Отправить сейчас" -- the last occurrence
 * is always the actual `<button>{label}</button>`).
 */
function buttonOpenTagFor(html: string, label: string): string {
  const labelIndex = html.lastIndexOf(label);
  if (labelIndex === -1) throw new Error(`Label not found in markup: ${label}`);
  const tagStart = html.lastIndexOf("<button", labelIndex);
  if (tagStart === -1) throw new Error(`No <button before label: ${label}`);
  const tagEnd = html.indexOf(">", tagStart);
  return html.slice(tagStart, tagEnd + 1);
}

/**
 * True when the button's opening tag carries the HTML `disabled` boolean
 * attribute. Checking for the literal `disabled=""` (rather than a bare
 * substring match on "disabled") is required because the Button component's
 * static className always contains the Tailwind variant classes
 * `disabled:pointer-events-none disabled:opacity-50` regardless of whether
 * the element is actually disabled.
 */
function isDisabled(buttonOpenTag: string): boolean {
  return buttonOpenTag.includes('disabled=""');
}

describe("UnsavedChangesBanner", () => {
  it("renders the unsaved-changes copy, amber classes and a save button when dirty", () => {
    const html = renderWithContext(<UnsavedChangesBanner />, dirtyValue());
    expect(html).toContain("Есть несохранённые изменения");
    expect(html).toContain("border-amber-200");
    expect(html).toContain("bg-amber-50");
    expect(html).toContain("Сохранить");
  });

  it("renders nothing when clean", () => {
    const html = renderWithContext(<UnsavedChangesBanner />, cleanValue());
    expect(html).toBe("");
  });
});

describe("LaunchScheduleActions dirty-blocking", () => {
  it("disables the primary action and shows the dirty reason for a complete campaign while dirty", () => {
    const campaign = baseCampaign();
    const html = renderWithContext(
      <LaunchScheduleActions
        slug={SLUG}
        campaign={campaign}
        canLaunch={true}
        onOpenConfirm={() => {}}
        onOpenSchedule={() => {}}
      />,
      dirtyValue()
    );
    const tag = buttonOpenTagFor(html, "Отправить сейчас");
    expect(isDisabled(tag)).toBe(true);
    expect(html).toContain(DIRTY_BLOCK_REASON);
  });

  it("does not disable the primary action for a complete campaign while clean", () => {
    const campaign = baseCampaign();
    const html = renderWithContext(
      <LaunchScheduleActions
        slug={SLUG}
        campaign={campaign}
        canLaunch={true}
        onOpenConfirm={() => {}}
        onOpenSchedule={() => {}}
      />,
      cleanValue()
    );
    const tag = buttonOpenTagFor(html, "Отправить сейчас");
    expect(isDisabled(tag)).toBe(false);
    expect(html).not.toContain(DIRTY_BLOCK_REASON);
  });

  it("keeps the incomplete reason as the only line when a campaign is both incomplete and dirty", () => {
    const campaign = baseCampaign({ templateId: null });
    const html = renderWithContext(
      <LaunchScheduleActions
        slug={SLUG}
        campaign={campaign}
        canLaunch={true}
        onOpenConfirm={() => {}}
        onOpenSchedule={() => {}}
      />,
      dirtyValue()
    );
    expect(html).toContain("Выберите шаблон письма");
    expect(html).not.toContain(DIRTY_BLOCK_REASON);
  });
});

describe("TestSendPanel dirty-blocking", () => {
  function seededQueryClient(): QueryClient {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["workspace", SLUG, "campaigns", CAMPAIGN_ID, "test-sample"], {
      sample: { email: "contact@example.com" },
    });
    return queryClient;
  }

  it("disables the send button and shows the dirty reason for a complete campaign while dirty", () => {
    const campaign = baseCampaign();
    const html = renderWithContext(
      <TestSendPanel slug={SLUG} campaign={campaign} />,
      dirtyValue(),
      seededQueryClient()
    );
    const tag = buttonOpenTagFor(html, "Отправить тестовое письмо");
    expect(isDisabled(tag)).toBe(true);
    expect(html).toContain(DIRTY_BLOCK_REASON);
  });

  it("does not disable the send button for a complete campaign while clean", () => {
    const campaign = baseCampaign();
    const html = renderWithContext(
      <TestSendPanel slug={SLUG} campaign={campaign} />,
      cleanValue(),
      seededQueryClient()
    );
    const tag = buttonOpenTagFor(html, "Отправить тестовое письмо");
    expect(isDisabled(tag)).toBe(false);
    expect(html).not.toContain(DIRTY_BLOCK_REASON);
  });
});

describe("CampaignBuilderPage with no provider (as /campaigns/new mounts it)", () => {
  it("renders markup and throws nothing", () => {
    const queryClient = new QueryClient();
    expect(() =>
      renderToStaticMarkup(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <CampaignBuilderPage />
          </QueryClientProvider>
        </MemoryRouter>
      )
    ).not.toThrow();
  });
});
