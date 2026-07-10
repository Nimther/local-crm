import { describe, expect, it } from "vitest";

import { computeNextWaitUntil } from "../wait-until.js";

describe("computeNextWaitUntil -- plain same-day/next-day (UTC)", () => {
  it("lands later TODAY when the time-of-day has not yet passed", () => {
    const now = new Date("2026-07-10T08:00:00Z"); // 08:00 UTC
    const result = computeNextWaitUntil(now, 12 * 60, undefined, "UTC"); // 12:00
    expect(result.toISOString()).toBe("2026-07-10T12:00:00.000Z");
  });

  it("lands TOMORROW when the time-of-day has already passed today", () => {
    const now = new Date("2026-07-10T14:00:00Z"); // 14:00 UTC
    const result = computeNextWaitUntil(now, 12 * 60, undefined, "UTC"); // 12:00
    expect(result.toISOString()).toBe("2026-07-11T12:00:00.000Z");
  });
});

describe("computeNextWaitUntil -- dayOfWeek constraint", () => {
  it("walks forward to the next matching weekday", () => {
    // 2026-07-10 is a Friday (5). Ask for Monday (1) at 09:00.
    const now = new Date("2026-07-10T08:00:00Z");
    const result = computeNextWaitUntil(now, 9 * 60, 1, "UTC");
    expect(result.toISOString()).toBe("2026-07-13T09:00:00.000Z"); // next Monday
  });

  it("uses TODAY when today already matches the weekday and the time hasn't passed", () => {
    // 2026-07-10 is a Friday (5), time-of-day (09:00) hasn't passed yet at 08:00.
    const now = new Date("2026-07-10T08:00:00Z");
    const result = computeNextWaitUntil(now, 9 * 60, 5, "UTC");
    expect(result.toISOString()).toBe("2026-07-10T09:00:00.000Z");
  });
});

describe("computeNextWaitUntil -- DST spring-forward boundary (America/New_York, 2026-03-08)", () => {
  it("lands on the correct absolute instant when the wait crosses the spring-forward transition", () => {
    // 2026-03-08 02:00 local -> 03:00 local is the US spring-forward
    // transition (07:00 UTC). "now" is 01:00 EST (pre-transition, 06:00Z);
    // the target 10:00 local occurs AFTER the transition, so it must
    // resolve in EDT (UTC-4), not EST (UTC-5).
    const now = new Date("2026-03-08T06:00:00Z");
    const result = computeNextWaitUntil(now, 10 * 60, undefined, "America/New_York");
    expect(result.toISOString()).toBe("2026-03-08T14:00:00.000Z");
  });
});
