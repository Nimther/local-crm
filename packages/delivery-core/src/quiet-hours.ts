/**
 * Timezone + quiet-hours math (FLOW-05, D-08/D-09/D-10/D-14). Native `Intl`
 * only -- no date-library dependency (T-06-07 prohibition). This file is
 * pure/DB-free: it never imports `pg`/`withTenant`, matching
 * `packages/flows-core`'s "pure compiler package" convention.
 *
 * T-06-07-01: an invalid IANA zone must never reach `Intl.DateTimeFormat`
 * construction unvalidated -- `isValidIanaTimezone` is the write-time
 * allowlist gate (contact/workspace settings write paths), and every
 * zone-aware function below still defensively tolerates a corrupt/legacy
 * stored value via `resolveTimezone`'s own validation + a final `try/catch`
 * fallback to UTC at the call site (see `apps/worker/src/queues/flows/
 * handlers/send-node.ts`/`delay-node.ts`).
 */

let cachedSupportedZones: Set<string> | null = null;

function getSupportedTimezones(): Set<string> {
  if (!cachedSupportedZones) {
    try {
      cachedSupportedZones = new Set(Intl.supportedValuesOf("timeZone"));
    } catch {
      cachedSupportedZones = new Set();
    }
  }
  return cachedSupportedZones;
}

/**
 * `isValidIanaTimezone('Europe/Belgrade')` -> true;
 * `isValidIanaTimezone('Mars/Phobos')` -> false. Primary check is set
 * membership against `Intl.supportedValuesOf('timeZone')`; a defensive
 * `try/catch` construction of `Intl.DateTimeFormat` is the fallback in case
 * `supportedValuesOf` is unavailable or its set is incomplete on some
 * runtime -- never lets an invalid zone slip through either path.
 */
export function isValidIanaTimezone(tz: string | null | undefined): boolean {
  if (!tz) return false;
  if (getSupportedTimezones().has(tz)) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Contact timezone -> workspace default timezone -> 'UTC' (D-08). Both inputs are re-validated (defense-in-depth against a corrupt stored value). */
export function resolveTimezone(
  contactTimezone: string | null | undefined,
  workspaceDefaultTimezone: string | null | undefined
): string {
  if (contactTimezone && isValidIanaTimezone(contactTimezone)) return contactTimezone;
  if (workspaceDefaultTimezone && isValidIanaTimezone(workspaceDefaultTimezone)) return workspaceDefaultTimezone;
  return "UTC";
}

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
 * instant it denotes. Two-pass offset correction (guess -> re-derive offset
 * at the corrected instant -> re-derive once more) so a target time that
 * falls right at a DST transition still resolves to the correct absolute
 * instant (spring-forward/fall-back).
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

export interface QuietHoursWindow {
  /** Minutes since local midnight, 0-1439. */
  startMinutes: number;
  /** Minutes since local midnight, 0-1439. */
  endMinutes: number;
  timezone: string;
}

/**
 * `true` when `now`'s local wall-clock time (in `window.timezone`) falls
 * inside `[startMinutes, endMinutes)`, including a window that wraps
 * midnight (e.g. 21:00 -> 08:00). A zero-width window (`start === end`) is
 * treated as "no quiet hours" (always `false`) -- callers gate on
 * `quiet_hours_enabled`/`quiet_hours_mode` before ever constructing a
 * window, so this is a defensive fallback, not the primary disable switch.
 */
export function isInsideQuietHours(now: Date, window: QuietHoursWindow): boolean {
  const { startMinutes, endMinutes, timezone } = window;
  if (startMinutes === endMinutes) return false;

  const zoned = getZonedParts(now, timezone);
  const nowMinutes = zoned.hour * 60 + zoned.minute;

  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  // Wraps midnight.
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

/**
 * The next absolute instant at which the quiet-hours window (that `now` is
 * currently inside) ends, in `window.timezone`. D-10: this is the ONLY time
 * math a deferred send needs -- callers must not add jitter/stagger on top
 * of this value.
 */
export function nextQuietWindowEnd(now: Date, window: QuietHoursWindow): Date {
  const { startMinutes, endMinutes, timezone } = window;
  const zoned = getZonedParts(now, timezone);
  const nowMinutes = zoned.hour * 60 + zoned.minute;

  const endHour = Math.floor(endMinutes / 60);
  const endMinute = endMinutes % 60;

  // Non-wrapping window: the end always lands on the SAME local calendar
  // day `now` is on. Wrapping window (start > end): if `now` is in the
  // "evening" half (>= start), the end lands TOMORROW; if `now` is in the
  // "early morning" half (< end), the end lands TODAY.
  const dayOffset = startMinutes > endMinutes && nowMinutes >= startMinutes ? 1 : 0;
  const targetDate = addCalendarDays(zoned, dayOffset);

  return zonedTimeToUtc(targetDate.year, targetDate.month, targetDate.day, endHour, endMinute, timezone);
}
