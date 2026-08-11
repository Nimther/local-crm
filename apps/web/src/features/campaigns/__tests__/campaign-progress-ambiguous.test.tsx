import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

import { CampaignProgress } from "../CampaignProgress";
import type { CampaignProgress as CampaignProgressPayload } from "../api";

/**
 * D-16 (Phase 13, closing Phase 11 D-13's deferral): `CampaignProgress.tsx`
 * must render `reconciling`/`unknown` as their own "outcome not yet known"
 * stat, distinct from both the `sent` and `failed` stats, and must render
 * nothing extra when there are no ambiguous sends.
 *
 * No component-rendering harness (`@testing-library/react`, jsdom) exists in
 * this repo, and the plan's threat model (T-13-03-SC) commits to zero new
 * dependencies. `react-dom/server`'s `renderToStaticMarkup`,
 * `@tanstack/react-query`, and `react-router`'s `MemoryRouter` (needed
 * because `CampaignMetricsSummary`, rendered underneath, contains a `<Link>`
 * that requires a router context) are all existing dependencies of apps/web
 * and together are sufficient to render the real component against a seeded
 * query cache in the `environment: "node"` vitest lane already configured
 * for this workspace -- no jsdom required for a one-shot static render, and
 * TanStack Query returns cache-seeded data synchronously on first render
 * (the same mechanism that powers its SSR/hydration support), so no network
 * call or `act()` wrapper is needed.
 *
 * RED (this plan's Task 2): fails today because `CampaignProgress.tsx` does
 * not read `ledger.reconciling`/`ledger.unknown` at all, so no "Исход
 * неизвестен" text is ever rendered.
 * GREEN: `CampaignProgress.tsx` reads both counts and renders their sum
 * under a distinct label, hidden when both are zero.
 */

const SLUG = "acme";
const CAMPAIGN_ID = "campaign-1";
const QUERY_KEY = ["workspace", SLUG, "campaigns", CAMPAIGN_ID, "progress"];

function basePayload(overrides: Partial<CampaignProgressPayload> = {}): CampaignProgressPayload {
  return {
    status: "sending",
    sentCount: 5,
    failedCount: 1,
    sendableTotal: 10,
    excludedTotal: 0,
    deliveredCount: 4,
    openedCount: 2,
    clickedCount: 1,
    bouncedCount: 0,
    unsubscribedCount: 0,
    ledger: {
      sent: 5,
      failed: 1,
      excluded: 0,
      dispatching: 0,
      reconciling: 0,
      unknown: 0,
    },
    excludedBreakdown: [],
    ...overrides,
  };
}

function renderWithSeededProgress(payload: CampaignProgressPayload): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(QUERY_KEY, payload);
  return renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <CampaignProgress slug={SLUG} campaignId={CAMPAIGN_ID} status="sending" />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("CampaignProgress ambiguous-send stat (D-16)", () => {
  it("renders the unknown count under a label distinct from sent and failed", () => {
    const html = renderWithSeededProgress(
      basePayload({ ledger: { sent: 5, failed: 1, excluded: 0, dispatching: 0, reconciling: 0, unknown: 3 } })
    );
    expect(html).toContain("Исход неизвестен: 3");
    expect(html).not.toContain("Исход неизвестен: 3 ошибок");
  });

  it("renders the reconciling count under the same ambiguous label", () => {
    const html = renderWithSeededProgress(
      basePayload({ ledger: { sent: 5, failed: 1, excluded: 0, dispatching: 0, reconciling: 2, unknown: 0 } })
    );
    expect(html).toContain("Исход неизвестен: 2");
  });

  it("renders no ambiguous stat row when both counts are zero", () => {
    const html = renderWithSeededProgress(basePayload());
    expect(html).not.toContain("Исход неизвестен");
  });

  it("renders identical sent and failed stats with and without ambiguous counts present", () => {
    const withoutAmbiguous = renderWithSeededProgress(basePayload());
    const withAmbiguous = renderWithSeededProgress(
      basePayload({ ledger: { sent: 5, failed: 1, excluded: 0, dispatching: 0, reconciling: 1, unknown: 1 } })
    );

    const sentFragment = "5 из 10 отправлено";
    const failedFragment = "1 ошибок";
    expect(withoutAmbiguous).toContain(sentFragment);
    expect(withoutAmbiguous).toContain(failedFragment);
    expect(withAmbiguous).toContain(sentFragment);
    expect(withAmbiguous).toContain(failedFragment);
  });
});
