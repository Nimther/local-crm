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
    } else if (STANDARD_FIELDS.has(field)) {
      target[field] = field === "email" ? value.trim().toLowerCase() : value;
    } else {
      input.properties![field] = value;
    }
  }

  if (!input.externalId && !input.email) {
    return { input, error: "Missing both external_id and email (D-02)" };
  }
  if (input.email && !EMAIL_RE.test(input.email)) {
    return { input, error: "Invalid email format" };
  }
  return { input };
}
