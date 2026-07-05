import type { UpsertContactIdentityInput } from "./contact-repository.js";

/**
 * Mapping target values that land on a contact's standard (typed) columns.
 * Any OTHER target string is treated as a custom-property key (D-19:
 * "create a new property on the fly" is simply choosing an unrecognized
 * mapping target -- no separate "create property" step exists).
 */
const STANDARD_FIELDS = new Set([
  "externalId",
  "email",
  "firstName",
  "lastName",
  "phone",
  "city",
  "country",
  "tags",
  "subscriptionStatus",
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * WR-05: only these two values may ever be SET from a CSV cell.
 * `suppressed` is deliberately excluded even though it is otherwise a valid
 * subscriptionStatus enum value elsewhere in the app -- suppression is
 * reserved for automated bounce/spam handling (D-12), never a marketer's
 * CSV upload.
 */
const CSV_SETTABLE_SUBSCRIPTION_STATUSES = new Set(["subscribed", "unsubscribed"]);

export interface CsvMappingResult {
  input: UpsertContactIdentityInput;
  error?: string;
}

/**
 * Applies a column(header)->field mapping to one staged CSV row (CONT-02,
 * 02-07). Shared by apps/api's dry-run counter (`csv-import.routes.ts`) and
 * apps/worker's apply worker (`imports-csv.worker.ts`) so both processes
 * agree byte-for-byte on which rows will error and how fields land --
 * duplicating this interpretation across processes would let the dry-run
 * preview (D-17) silently drift from what apply actually does (the same
 * drift risk RESEARCH.md's shared-upsert-function rationale calls out for
 * `upsertContactByIdentity`).
 *
 * D-15: only NON-EMPTY CSV cells are applied -- this is what makes "update"
 * a merge (existing contact fields are preserved when the CSV cell for that
 * row is blank), not a blind overwrite. "tags" is comma-split; any target
 * not in STANDARD_FIELDS lands verbatim in `properties`.
 */
export function applyCsvRowMapping(
  raw: Record<string, string>,
  mapping: Record<string, string>
): CsvMappingResult {
  const input: UpsertContactIdentityInput = { properties: {} };
  const target = input as unknown as Record<string, unknown>;

  for (const [header, field] of Object.entries(mapping)) {
    const value = raw[header];
    if (value === undefined || value === "") continue;

    if (field === "tags") {
      input.tags = value
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    } else if (field === "subscriptionStatus") {
      // WR-05: validated below (after the loop) so both "invalid value"
      // and "missing identity" errors go through the same
      // { input, error } return shape -- the raw normalized value is
      // stashed here and checked once the whole row has been mapped.
      target[field] = value.trim().toLowerCase();
    } else if (STANDARD_FIELDS.has(field)) {
      target[field] = field === "email" ? value.trim().toLowerCase() : value;
    } else {
      input.properties![field] = value;
    }
  }

  if (
    input.subscriptionStatus !== undefined &&
    !CSV_SETTABLE_SUBSCRIPTION_STATUSES.has(input.subscriptionStatus)
  ) {
    // Covers both a nonsense value ("yes") and a deliberate attempt to set
    // "suppressed" via CSV (D-12) -- neither may pass dry-run OR apply, so
    // this is the SAME mapper both call, keeping them in agreement.
    return { input, error: "Invalid subscription status" };
  }

  if (!input.externalId && !input.email) {
    return { input, error: "Missing both external_id and email (D-02)" };
  }
  if (input.email && !EMAIL_RE.test(input.email)) {
    return { input, error: "Invalid email format" };
  }
  return { input };
}
