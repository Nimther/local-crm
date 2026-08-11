import type { ConditionOperator } from "./types.js";

/**
 * D-04: standard profile fields as string-attributes, allow-listed by exact
 * name -> real SQL column. Fails closed (compileAttributeCondition throws)
 * on any field not in this map -- this is the phase's primary SQL-injection
 * mitigation (T-03-01, Security Domain V5): a client-supplied field NEVER
 * reaches SQL as a raw identifier, only through this fixed lookup.
 *
 * `tags` is included here (not in RESEARCH.md's illustrative snippet, which
 * only showed the plain string fields) because D-03 requires tag
 * has_tag/not_has_tag conditions to compile through the same allow-listed
 * path as every other attribute condition -- there is exactly one tags
 * column (`contacts.tags`), so it belongs in this map rather than a special
 * case bypassing the allow-list.
 *
 * Built on a null prototype (WR-01): a plain `{}` object literal inherits
 * Object.prototype, so a client-supplied field name like `constructor`,
 * `toString`, `hasOwnProperty`, or `__proto__` would resolve truthy via
 * prototype-chain lookup (`STANDARD_FIELD_COLUMNS[cond.field]`) even though
 * it was never assigned here -- fails open on exactly the injection surface
 * this map exists to close. `Object.create(null)` has no prototype chain to
 * fall through, so only the 7 keys explicitly assigned below ever resolve.
 */
export const STANDARD_FIELD_COLUMNS: Record<string, string> = Object.assign(Object.create(null), {
  country: "c.country",
  city: "c.city",
  firstName: "c.first_name",
  lastName: "c.last_name",
  phone: "c.phone",
  subscriptionStatus: "c.subscription_status",
  tags: "c.tags",
});

/**
 * Maps an allow-listed column expression + D-03 operator + value to a
 * parameterized SQL fragment. `column` is always either a fixed
 * `STANDARD_FIELD_COLUMNS` entry or a `c.properties ->> $N` extraction whose
 * key is itself a bind param (never a client-controlled identifier) --
 * see compile.ts's compileAttributeCondition. Values are always pushed onto
 * `params` and referenced as `$N`, never string-interpolated.
 *
 * is_empty/is_not_empty use plain `->>`-compatible text comparisons (Open
 * Question 2's recommendation) -- no jsonb existence operator (`?`/`?&`/`?|`)
 * and therefore no GIN opclass dependency.
 */
/**
 * WR-04: escape ILIKE's own wildcard characters (`%`, `_`) plus the escape
 * character itself (`\`) BEFORE wrapping the value in `%...%`, so a
 * wildcard-bearing user value (e.g. a coupon code `50%_off`) is matched as a
 * literal substring, not as a LIKE pattern. Postgres ILIKE's default ESCAPE
 * character is backslash, so no explicit `ESCAPE '\'` clause is needed.
 * Order matters: backslash must be escaped first, or escaping `%`/`_`
 * afterwards would double-escape the backslashes just inserted.
 */
function escapeLikeWildcards(value: unknown): string {
  return String(value).replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function compileOperator(
  column: string,
  operator: ConditionOperator,
  value: unknown,
  params: unknown[]
): string {
  switch (operator) {
    case "eq":
      params.push(value);
      return `${column} = $${params.length}`;
    case "neq":
      params.push(value);
      return `${column} <> $${params.length}`;
    case "contains":
      params.push(`%${escapeLikeWildcards(value)}%`);
      return `${column} ILIKE $${params.length}`;
    case "not_contains":
      params.push(`%${escapeLikeWildcards(value)}%`);
      return `NOT (${column} ILIKE $${params.length})`;
    case "is_empty":
      return `(${column} IS NULL OR ${column} = '')`;
    case "is_not_empty":
      return `(${column} IS NOT NULL AND ${column} <> '')`;
    case "gt":
      params.push(value);
      return `(${column})::numeric > $${params.length}`;
    case "gte":
      params.push(value);
      return `(${column})::numeric >= $${params.length}`;
    case "lt":
      params.push(value);
      return `(${column})::numeric < $${params.length}`;
    case "lte":
      params.push(value);
      return `(${column})::numeric <= $${params.length}`;
    case "is_true":
      params.push(true);
      return `(${column})::boolean = $${params.length}`;
    case "is_false":
      params.push(false);
      return `(${column})::boolean = $${params.length}`;
    case "before":
      params.push(value);
      return `(${column})::timestamptz < $${params.length}`;
    case "after":
      params.push(value);
      return `(${column})::timestamptz > $${params.length}`;
    case "in_last_days":
      params.push(value);
      return `(${column})::timestamptz >= now() - ($${params.length} || ' days')::interval`;
    case "has_tag":
      params.push(value);
      return `${column} @> ARRAY[$${params.length}]::text[]`;
    case "not_has_tag":
      params.push(value);
      return `NOT (${column} @> ARRAY[$${params.length}]::text[])`;
    default: {
      // Fails closed -- an operator not in the ConditionOperator union
      // (e.g. an invalid string cast through `as never` in a test, or any
      // future enum drift) never reaches SQL.
      const exhaustiveCheck: never = operator;
      throw new Error(`Unknown condition operator: ${String(exhaustiveCheck)}`);
    }
  }
}
