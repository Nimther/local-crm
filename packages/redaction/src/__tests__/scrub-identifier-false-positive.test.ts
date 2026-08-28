import { randomUUID } from "node:crypto";

import { describe, expect, test } from "vitest";

import { CENSOR, REDACTION_RULES } from "../rules.js";
import { scrub } from "../scrub.js";

/**
 * Phase 10 debug (aggregate-coverage-run-fails) — the `phone` valueRule must
 * not eat v4 UUIDs.
 *
 * `valueRules` are applied to EVERY string value regardless of its key, which
 * is the point: freeform webhook/event payloads use tenant-chosen key names.
 * The cost is that a pattern which is loose enough to catch `+1 415-555-0199`
 * is also loose enough to catch a UUID, because a UUID's hex groups are 62.5%
 * digits and `-` is one of the pattern's own accepted separators.
 *
 * The rule's comment already records one round of this: an earlier version
 * matched "7+ digit-ish characters" and was caught by
 * webhook-events-sibling-drop.test.ts's Test 4. Widening the floor to the
 * E.164 10-15 digit range reduced the false-positive rate but did NOT remove
 * it — measured at ~4% of `randomUUID()` values, which is why that same Test 4
 * kept failing intermittently: `owningWorkspaceId` came back `[REDACTED]`
 * whenever the fixture's workspace id happened to contain a long enough digit
 * run (e.g. `b2cd545e-6853-418e-a436-2d4658232825`, whose tail holds ten
 * consecutive digits).
 *
 * A 4%-per-run failure in a mandatory gate is not a flaky test — it is this
 * rule reporting a real defect at a low duty cycle. And the defect is a
 * production one, not a test one: SEC-09/WR-01's whole contract is that the
 * sibling-drop signal carries workspace ids, so redacting them destroys the
 * only diagnostic the signal exists to emit.
 *
 * The first fix anchors the pattern between non-alphanumeric, non-hyphen
 * boundaries. That eliminates the false positive for every UUID containing at
 * least one hex LETTER — but NOT "by construction" for all UUIDs, as this
 * file's original version of this paragraph claimed. See the second block of
 * comments above Test 8 for the residue that claim missed, and
 * `rules.ts`'s `phone` rule for the pattern that closes it.
 */

/**
 * UUIDs observed matching the pre-fix pattern. Kept as literals, not
 * regenerated, so this test fails deterministically on a regression instead of
 * ~4% of the time.
 */
const UUIDS_THAT_MATCHED_THE_OLD_PATTERN = [
  "b2cd545e-6853-418e-a436-2d4658232825",
  "19d95d88-2146-4308-9afc-cdf226a8cfc0",
  "70cacf22-7767-4368-9699-aa895674acfb",
  "68ae1ae6-096b-4943-8b28-988221443521",
  "fc805039-6260-4b25-8cdf-b7991ef87741",
];

/**
 * Debug session `uuid-redacted-as-phone` — the residue the "by construction"
 * claim above missed, and the reason Tests 8-11 exist.
 *
 * Work out what a match inside a STANDALONE canonical UUID actually requires
 * under the anchored pattern:
 *
 *   - the lookbehind `(?<![0-9A-Za-z-])` admits only index 0, because every
 *     other position in a UUID is preceded by a hex character or a `-`;
 *   - the closing lookahead `(?![0-9A-Za-z-])` rejects every position followed
 *     by a digit, a hex letter or a `-` — i.e. every INTERNAL position.
 *
 * So the match must start at 0 and end at the value's end, which is possible
 * exactly when EVERY character of the UUID is a digit or a `-`. The anchors
 * therefore protect only UUIDs that contain at least one hex LETTER. An
 * all-decimal canonical UUID — all 32 hex characters happening to be digits —
 * is matched in full, and redacted.
 *
 * That class is rare but real: 0.625^30 x 0.5 = 3.76e-7 of `randomUUID()`
 * values (the version nibble is a fixed `4`, the variant nibble is a digit in 2
 * of its 4 legal values, the other 30 are free), measured as 0 hits in
 * 3,000,000 samples. Which is the whole point — Test 3 below samples 5000, so
 * its chance of ever catching this was ~0.19%. A sampled guard is only as
 * strong as the defect's density, and the previous round's lesson ("a
 * probabilistic bug fixed against a single failing example has only had its
 * rate lowered") applies one level up: a probabilistic GUARD verified against
 * a 4%-density defect says nothing about a 3.76e-7-density one.
 *
 * Hence these tests do not sample the UUID space at all. They pin the two
 * deterministic literals below and then sweep the previously-vulnerable CLASS
 * (all-decimal canonical UUIDs) at 100% density, where the pre-fix pattern
 * matched 200000/200000.
 */
const ALL_DECIMAL_UUIDS = [
  // Reported verbatim in the debug session. A legal v4 UUID (version nibble
  // `4`, variant nibble `9`) whose every hex character is a digit.
  "17240210-0546-4077-9954-207876832048",
  // The nil UUID — all-decimal by definition, so this is the same defect with
  // no randomness in it whatsoever. A sentinel this codebase can legitimately
  // log; there is nothing to redact in it and never was.
  "00000000-0000-0000-0000-000000000000",
];

/**
 * Deterministic PRNG (mulberry32) so the class sweep in Test 10 reproduces
 * byte-for-byte on every run. `randomUUID()` is deliberately NOT used: the
 * point of this suite is that a random draw cannot reach this defect's class.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A canonical, all-decimal v4 UUID: the exact class the anchors fail to protect. */
function allDecimalV4Uuid(rand: () => number): string {
  const digits = (n: number) =>
    Array.from({ length: n }, () => String(Math.floor(rand() * 10))).join("");
  return [
    digits(8),
    digits(4),
    `4${digits(3)}`,
    `${rand() < 0.5 ? "8" : "9"}${digits(3)}`,
    digits(12),
  ].join("-");
}

function phoneRule(): RegExp {
  const rule = REDACTION_RULES.valueRules.find((candidate) => candidate.name === "phone");
  if (!rule) throw new Error("the `phone` valueRule is gone — this suite is asserting nothing");
  return rule.pattern;
}

describe("scrub: identifiers must survive the phone valueRule", () => {
  test("Test 1: a v4 UUID that matched the pre-fix pattern passes through untouched, under a key that matches no rule", () => {
    for (const uuid of UUIDS_THAT_MATCHED_THE_OLD_PATTERN) {
      const output = scrub({ owningWorkspaceId: uuid }) as Record<string, unknown>;
      expect(output.owningWorkspaceId).toBe(uuid);
    }
  });

  test("Test 2: the exact SEC-09/WR-01 drop signal keeps both workspace ids readable", () => {
    const receivingWorkspaceId = "b2cd545e-6853-418e-a436-2d4658232825";
    const owningWorkspaceId = "68ae1ae6-096b-4943-8b28-988221443521";

    const output = scrub({ receivingWorkspaceId, owningWorkspaceId, count: 1 }) as Record<
      string,
      unknown
    >;

    expect(output.receivingWorkspaceId).toBe(receivingWorkspaceId);
    expect(output.owningWorkspaceId).toBe(owningWorkspaceId);
    expect(output.count).toBe(1);
  });

  /**
   * KEPT, but read its scope narrowly. 5000 samples reliably detects a GROSS
   * regression (drop the anchors and the rate returns to ~4%, which this
   * catches with probability ~1). It is near-vacuous for the all-decimal class
   * at 3.76e-7 — ~0.19% detection — which is exactly how the
   * `uuid-redacted-as-phone` defect survived a guard written for this rule.
   * Tests 8-11 are the deterministic cover for that class; do not read a green
   * Test 3 as evidence about it.
   */
  test("Test 3: no generated v4 UUID is redacted -- catches a gross (~4%) regression at 5000 samples, NOT the all-decimal class (see Tests 8-11)", () => {
    const redacted: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const uuid = randomUUID();
      if ((scrub({ id: uuid }) as Record<string, unknown>).id !== uuid) redacted.push(uuid);
    }
    expect(redacted).toEqual([]);
  });

  test("Test 4: a UUID embedded in a freeform message is still readable", () => {
    const message = "dropped 68ae1ae6-096b-4943-8b28-988221443521 for a sibling workspace";
    const output = scrub({ note: message }) as Record<string, unknown>;
    expect(output.note).toBe(message);
  });

  test("Test 5 (unchanged protection): every realistic phone format is still redacted", () => {
    const phones = [
      "+14155550199",
      "+1 415-555-0199",
      "(415) 555-0199",
      "415-555-0199",
      "4155550199",
      "+7 (999) 123-45-67",
      "+442071838750",
      "tel:+1-415-555-0199",
      "call 415-555-0199 now",
      "phone is (212) 555-1234.",
    ];
    for (const phone of phones) {
      const output = scrub({ reachAt: phone }) as Record<string, unknown>;
      expect(output.reachAt, `expected ${phone} to be redacted`).toBe(CENSOR);
    }
  });

  test("Test 6 (boundary neighbours): the digit-count floor stays at 10, and long digit runs stay covered", () => {
    const pattern = phoneRule();
    // Below the E.164 floor: 9 digits is not a phone number and never was.
    expect(pattern.test("1".repeat(9))).toBe(false);
    // At and above the floor.
    expect(pattern.test("1".repeat(10))).toBe(true);
    expect(pattern.test("1".repeat(15))).toBe(true);
    // A 16-digit run (a card number is the realistic case) must NOT slip
    // through: the pre-fix pattern only caught it by starting mid-run, which
    // the new boundary forbids, so the upper bound has to be open-ended.
    expect(pattern.test("1".repeat(16))).toBe(true);
    expect(pattern.test("1".repeat(19))).toBe(true);
  });

  test("Test 7: the phone rule never matches anywhere inside a hex-lettered canonical UUID, at any start position", () => {
    const pattern = phoneRule();
    for (const uuid of UUIDS_THAT_MATCHED_THE_OLD_PATTERN) {
      expect(pattern.test(uuid), `expected no phone match in ${uuid}`).toBe(false);
    }
  });

  test("Test 8: an all-decimal canonical UUID passes through untouched, under a key that matches no rule", () => {
    for (const uuid of ALL_DECIMAL_UUIDS) {
      const output = scrub({ owningWorkspaceId: uuid }) as Record<string, unknown>;
      expect(output.owningWorkspaceId, `expected ${uuid} to survive scrub()`).toBe(uuid);
    }
  });

  test("Test 9: an all-decimal UUID survives every position a UUID actually appears in", () => {
    for (const uuid of ALL_DECIMAL_UUIDS) {
      // Embedded in a freeform message, as in the SEC-09/WR-01 drop signal.
      const message = `dropped ${uuid} for a sibling workspace`;
      expect((scrub({ note: message }) as Record<string, unknown>).note).toBe(message);

      // Parenthesised and `+`-prefixed. These two discriminate WHERE the fix's
      // UUID-shape exclusion sits: placed before the pattern's optional `\+?\(?`
      // prefix instead of after it, the match simply starts one character
      // earlier -- on the `(` or the `+` -- and the UUID is redacted anyway.
      const parenthesised = `(${uuid})`;
      expect((scrub({ note: parenthesised }) as Record<string, unknown>).note).toBe(parenthesised);

      const plusPrefixed = `+${uuid}`;
      expect((scrub({ note: plusPrefixed }) as Record<string, unknown>).note).toBe(plusPrefixed);
    }
  });

  test("Test 10: the phone rule matches no all-decimal canonical UUID -- swept over the whole previously-vulnerable class, not sampled from the UUID space", () => {
    const pattern = phoneRule();
    for (const uuid of ALL_DECIMAL_UUIDS) {
      expect(pattern.test(uuid), `expected no phone match in ${uuid}`).toBe(false);
    }

    // 100%-density sweep: the pre-fix pattern matched 200000/200000 of these.
    // Deterministic seed, so a regression names the same UUID every run.
    const rand = mulberry32(0x5eed_1724);
    const matched: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const uuid = allDecimalV4Uuid(rand);
      // Both mechanisms, reported once per offending value: the rule's own
      // pattern, and the pattern as `scrub()` actually applies it.
      const patternMatched = pattern.test(uuid);
      const scrubRedacted = (scrub({ id: uuid }) as Record<string, unknown>).id !== uuid;
      if (patternMatched || scrubRedacted) matched.push(uuid);
    }
    expect(matched).toEqual([]);
  });

  test("Test 11 (positive control): long digit runs that are NOT canonical UUIDs are still redacted", () => {
    const pattern = phoneRule();
    // 8-4-4-4-13: one digit too many in the last group, so it is not a UUID and
    // must stay covered. This is what forces the shape exclusion to require a
    // boundary after the 12th character of the final group rather than just
    // matching a UUID-shaped prefix.
    expect(pattern.test("12345678-1234-1234-1234-1234567890123")).toBe(true);
    // Same shape, one digit too FEW -- also not a UUID.
    expect(pattern.test("12345678-1234-1234-1234-12345678901")).toBe(true);
    // A card number, and the bare long runs Test 6 pins.
    expect(pattern.test("4111111111111111")).toBe(true);
    expect(pattern.test("1".repeat(16))).toBe(true);
    // And the unhyphenated 32-digit form is NOT a canonical UUID: still covered.
    expect(pattern.test("17240210054640779954207876832048")).toBe(true);
  });
});
