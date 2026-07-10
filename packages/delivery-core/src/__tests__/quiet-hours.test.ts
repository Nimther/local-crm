import { describe, expect, it } from "vitest";

import { isInsideQuietHours, isValidIanaTimezone, nextQuietWindowEnd, resolveTimezone } from "../quiet-hours.js";

describe("isValidIanaTimezone", () => {
  it("accepts a real IANA zone", () => {
    expect(isValidIanaTimezone("Europe/Belgrade")).toBe(true);
    expect(isValidIanaTimezone("America/New_York")).toBe(true);
    expect(isValidIanaTimezone("UTC")).toBe(true);
  });

  it("rejects a fake zone", () => {
    expect(isValidIanaTimezone("Mars/Phobos")).toBe(false);
  });

  it("rejects null/undefined/empty", () => {
    expect(isValidIanaTimezone(null)).toBe(false);
    expect(isValidIanaTimezone(undefined)).toBe(false);
    expect(isValidIanaTimezone("")).toBe(false);
  });
});

describe("resolveTimezone", () => {
  it("prefers a valid contact timezone", () => {
    expect(resolveTimezone("Europe/Belgrade", "America/New_York")).toBe("Europe/Belgrade");
  });

  it("falls back to the workspace default when the contact zone is invalid/absent", () => {
    expect(resolveTimezone(null, "America/New_York")).toBe("America/New_York");
    expect(resolveTimezone("Mars/Phobos", "America/New_York")).toBe("America/New_York");
  });

  it("falls back to UTC when neither is valid", () => {
    expect(resolveTimezone(null, null)).toBe("UTC");
    expect(resolveTimezone("Mars/Phobos", "Mars/Phobos")).toBe("UTC");
  });
});

describe("isInsideQuietHours -- non-wrapping window", () => {
  const window = { startMinutes: 9 * 60, endMinutes: 17 * 60, timezone: "UTC" };

  it("is true inside the window", () => {
    expect(isInsideQuietHours(new Date("2026-07-10T12:00:00Z"), window)).toBe(true);
  });

  it("is false outside the window", () => {
    expect(isInsideQuietHours(new Date("2026-07-10T20:00:00Z"), window)).toBe(false);
  });
});

describe("isInsideQuietHours -- midnight-wrapping window (21:00 -> 08:00)", () => {
  const window = { startMinutes: 21 * 60, endMinutes: 8 * 60, timezone: "UTC" };

  it("is true late at night", () => {
    expect(isInsideQuietHours(new Date("2026-07-10T23:00:00Z"), window)).toBe(true);
  });

  it("is true in the early morning", () => {
    expect(isInsideQuietHours(new Date("2026-07-10T05:00:00Z"), window)).toBe(true);
  });

  it("is false during the day", () => {
    expect(isInsideQuietHours(new Date("2026-07-10T12:00:00Z"), window)).toBe(false);
  });

  it("a zero-width window (start === end) is always false", () => {
    expect(isInsideQuietHours(new Date("2026-07-10T23:00:00Z"), { startMinutes: 60, endMinutes: 60, timezone: "UTC" })).toBe(
      false
    );
  });
});

describe("nextQuietWindowEnd -- midnight-wrapping window (21:00 -> 08:00, UTC)", () => {
  const window = { startMinutes: 21 * 60, endMinutes: 8 * 60, timezone: "UTC" };

  it("lands TOMORROW's 08:00 when now is in the evening half (>= start)", () => {
    const end = nextQuietWindowEnd(new Date("2026-07-10T23:00:00Z"), window);
    expect(end.toISOString()).toBe("2026-07-11T08:00:00.000Z");
  });

  it("lands TODAY's 08:00 when now is in the early-morning half (< end)", () => {
    const end = nextQuietWindowEnd(new Date("2026-07-10T05:00:00Z"), window);
    expect(end.toISOString()).toBe("2026-07-10T08:00:00.000Z");
  });
});

describe("nextQuietWindowEnd -- non-wrapping window (09:00 -> 17:00, UTC)", () => {
  it("lands the same day's end", () => {
    const window = { startMinutes: 9 * 60, endMinutes: 17 * 60, timezone: "UTC" };
    const end = nextQuietWindowEnd(new Date("2026-07-10T12:00:00Z"), window);
    expect(end.toISOString()).toBe("2026-07-10T17:00:00.000Z");
  });
});

describe("nextQuietWindowEnd -- non-UTC timezone", () => {
  it("resolves the window end against the zone's local wall clock, not UTC", () => {
    // America/New_York in July is UTC-4 (EDT). A 21:00->08:00 local window,
    // "now" at 23:30 local (03:30 UTC the next calendar day).
    const window = { startMinutes: 21 * 60, endMinutes: 8 * 60, timezone: "America/New_York" };
    const now = new Date("2026-07-11T03:30:00Z"); // 2026-07-10 23:30 EDT
    const end = nextQuietWindowEnd(now, window);
    // 2026-07-11 08:00 EDT == 2026-07-11T12:00:00Z
    expect(end.toISOString()).toBe("2026-07-11T12:00:00.000Z");
  });
});
