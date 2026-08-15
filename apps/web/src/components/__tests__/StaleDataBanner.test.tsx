import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DataAsOfLabel } from "../DataAsOfLabel";
import { STALE_DATA_LAG_THRESHOLD_MINUTES, StaleDataBanner } from "../StaleDataBanner";

/**
 * OPS-18 / D-12 (plan 15-15): the two freshness-rendering components --
 * `DataAsOfLabel` (always-visible watermark) and `StaleDataBanner`
 * (conditional delay warning), both driven purely by the two fields plan
 * 15-12 added to the analytics response (`dataAsOf`, `lagMinutes`), never by
 * the data's own age.
 *
 * Same technique as `QueryErrorState.test.tsx`: no component-rendering
 * harness exists in this repo (`apps/web`'s vitest lane runs with
 * `environment: "node"`, no jsdom, and this plan's threat model, T-15-SC,
 * forbids any new dependency) -- both components are plain function
 * components with no hooks, so `renderToStaticMarkup` on their direct
 * function-call result covers every textual/presence assertion needed here.
 */

describe("DataAsOfLabel", () => {
  it("renders the watermark timestamp in the viewer's local time when present", () => {
    const dataAsOf = "2026-08-15T09:30:00.000Z";
    const html = renderToStaticMarkup(DataAsOfLabel({ dataAsOf }));
    const expected = new Date(dataAsOf).toLocaleString("ru-RU");
    expect(html).toContain(expected);
  });

  it("renders a distinct no-data-yet message when the watermark is null, never a blank or fabricated timestamp", () => {
    const html = renderToStaticMarkup(DataAsOfLabel({ dataAsOf: null }));
    expect(html).toContain("Данных пока нет");
    expect(html).not.toContain("Invalid Date");
    expect(html.trim().length).toBeGreaterThan(0);
  });
});

describe("StaleDataBanner", () => {
  it("does not render when there is no outstanding lag, regardless of how old the watermark is", () => {
    const tree = StaleDataBanner({ lagMinutes: null });
    expect(tree).toBeNull();
  });

  it("does not render when the lag is below the threshold", () => {
    const tree = StaleDataBanner({ lagMinutes: STALE_DATA_LAG_THRESHOLD_MINUTES - 1 });
    expect(tree).toBeNull();
  });

  it("does not render exactly at the threshold -- only strictly above trips the banner", () => {
    const atThreshold = StaleDataBanner({ lagMinutes: STALE_DATA_LAG_THRESHOLD_MINUTES });
    expect(atThreshold).toBeNull();

    const aboveThreshold = StaleDataBanner({ lagMinutes: STALE_DATA_LAG_THRESHOLD_MINUTES + 1 });
    expect(aboveThreshold).not.toBeNull();
  });

  it("renders the delayed message when the lag exceeds the threshold", () => {
    const html = renderToStaticMarkup(
      StaleDataBanner({ lagMinutes: STALE_DATA_LAG_THRESHOLD_MINUTES + 5 }) as ReturnType<typeof StaleDataBanner> & object
    );
    expect(html).toContain("задержк");
  });

  it("never fires from data age alone -- a quiet workspace with an old watermark and zero outstanding lag is not flagged (T-15-53)", () => {
    // A workspace that sent nothing in months has an old `dataAsOf` but no
    // dirty day outstanding, so the API reports `lagMinutes: null` -- the
    // banner must never infer staleness from `dataAsOf`'s own age.
    const tree = StaleDataBanner({ lagMinutes: null });
    expect(tree).toBeNull();
  });
});
