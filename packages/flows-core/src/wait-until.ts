/**
 * Wait-until date math for delay nodes (FLOW-05). Pure, DB-free, native
 * `Intl` only -- no date-library dependency (T-06-07 prohibition). Mirrors
 * `packages/delivery-core/src/quiet-hours.ts`'s zone-math approach; the two
 * files are intentionally self-contained (this package has no dependency
 * path to `delivery-core`) rather than sharing a private helper module.
 */

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Reads `date`'s wall-clock representation in `timeZone` via `Intl.DateTimeFormat.formatToParts` (DST-correct by construction). */
function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const map: Record<string, string> = {};
  for (const part of parts) map[part.type] = part.value;

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24, // defensive: some ICU builds format midnight as "24" even with hourCycle:"h23"
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/** The zone's UTC offset (ms) AT `instantMs`, expressed as `zonedWallClockAsUtcMs - instantMs`. */
function offsetMsAt(instantMs: number, timeZone: string): number {
  const zoned = getZonedParts(new Date(instantMs), timeZone);
  const zonedAsUtcMs = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second);
  return zonedAsUtcMs - instantMs;
}

/**
 * Converts a local wall-clock Y/M/D H:M in `timeZone` to the absolute UTC
 * instant it denotes. Two-pass offset correction so a target time that
 * falls right at a DST transition (spring-forward/fall-back) still
 * resolves to the correct absolute instant.
 */
function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const targetAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  let instantMs = targetAsUtcMs - offsetMsAt(targetAsUtcMs, timeZone);
  instantMs = targetAsUtcMs - offsetMsAt(instantMs, timeZone);
  return new Date(instantMs);
}

/** Pure calendar-day arithmetic (no zone/DST ambiguity -- Y/M/D triples only). */
function addCalendarDays(date: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * 86_400_000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** ISO weekday convention used across this file: 0 (Sunday) - 6 (Saturday), matching `flowDelayWaitUntilSchema.dayOfWeek`. */
function weekdayOfCalendarDate(date: { year: number; month: number; day: number }): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/**
 * Pure `computeNextWaitUntil(now, timeOfDayMinutes, dayOfWeek?, timezone)`
 * (FLOW-05): the next absolute instant at which the local wall-clock time in
 * `timezone` matches `timeOfDayMinutes` (minutes since local midnight,
 * 0-1439) -- and, when `dayOfWeek` (0=Sunday..6=Saturday) is given, also
 * matches that weekday. Walks forward day-by-day (bounded to 8 days --
 * strictly more than a full week, so a `dayOfWeek` match is always found)
 * rather than doing closed-form weekday arithmetic, keeping the DST-correct
 * `zonedTimeToUtc` conversion as the only place absolute-instant math
 * happens.
 */
export function computeNextWaitUntil(
  now: Date,
  timeOfDayMinutes: number,
  dayOfWeek: number | undefined,
  timezone: string
): Date {
  const targetHour = Math.floor(timeOfDayMinutes / 60);
  const targetMinute = timeOfDayMinutes % 60;

  const zoned = getZonedParts(now, timezone);
  const nowMinutes = zoned.hour * 60 + zoned.minute;

  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const candidate = addCalendarDays(zoned, dayOffset);
    if (dayOfWeek !== undefined && weekdayOfCalendarDate(candidate) !== dayOfWeek) continue;
    if (dayOffset === 0 && nowMinutes >= timeOfDayMinutes) continue; // today's time-of-day has already passed
    return zonedTimeToUtc(candidate.year, candidate.month, candidate.day, targetHour, targetMinute, timezone);
  }

  // Unreachable in practice (dayOfWeek is constrained to 0-6, the loop scans
  // a full week + 1 day) -- a defensive error rather than silently
  // returning a wrong instant.
  throw new Error("computeNextWaitUntil: no matching day found within 8 days");
}
