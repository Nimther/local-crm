/**
 * Phase 21 (DSR-03, D-02/D-03, plan 21-02): the single shared definition of
 * the JSONB disclosure rule for `send_events.payload`, consumed by BOTH
 * runtimes -- `apps/api`'s DSR export (disclose) and `apps/worker`'s erasure
 * scrub (erase). Relocated verbatim from `apps/worker/src/queues/erasure-scrub.worker.ts`
 * (Phase 13, CMP-04, D-01/D-04, plan 13-13) so the two runtimes import one
 * definition instead of maintaining two copies that could silently drift
 * apart -- a divergence between what erasure removes and what export
 * discloses is a compliance defect in both directions (D-03's own
 * reversibility note: Phase 22's purge is explicitly designed against this
 * shared definition).
 *
 * ALLOWLIST RECONSTRUCTION, NOT A DENYLIST FILTER (REVIEWS.md (Codex)
 * BLOCKER finding 4 -- this reverses an earlier version of the Phase 13 plan
 * that directed reuse of `@mega-crm/redaction`'s `REDACTION_RULES`). A
 * denylist can only remove what someone anticipated: `REDACTION_RULES`'s
 * `keyRules` match known field NAMES and its `valueRules` backstop narrows
 * the gap for email/phone-SHAPED values, but neither can bound
 * `events.properties`, whose entire key space is tenant-invented, or a
 * `send_events.payload` field like `reason`/`response` that carries the
 * recipient's address inside a longer free-form SMTP diagnostic string
 * under a key name that looks like nothing sensitive at all. Reconstructing
 * from an allowlist inverts the burden: an unanticipated field is dropped BY
 * CONSTRUCTION (it was simply never copied forward), not by a detector that
 * could miss it. This file therefore imports nothing from
 * `@mega-crm/redaction` and defines no PII-shaped regular expression of its
 * own -- see the erasure worker's own tests
 * (`apps/worker/src/queues/__tests__/erasure-scrub.test.ts`) for the specific
 * cases (`reason` embedding an address, a tenant-invented key holding a
 * person's name) that a denylist provably cannot catch and this allowlist
 * closes by never copying them forward at all.
 */

/**
 * The complete, frozen list of `send_events.payload` top-level keys that
 * survive a scrub. This list IS the PII bound and the evidence contract at
 * once (T-13-13-03): shrinking it trades away evidence, widening it risks
 * carrying PII forward, so a change here is a decision about both at the
 * same time, not a routine edit.
 *
 * SURVIVING (what evidence each preserves):
 *   - `event`                 the provider's event name; what happened
 *   - `type`                  the provider's bounce sub-classification (`bounce` vs `blocked`)
 *   - `timestamp`             the provider's event time
 *   - `sg_event_id`           provider event identity, for forensic correlation
 *   - `sg_message_id`         provider message identity, the join back to the send
 *   - `smtp-id`               the message identity the receiving MTA saw
 *   - `status`                the SMTP status code (e.g. `5.1.1`); the delivery outcome
 *   - `attempt`               the delivery attempt number
 *   - `asm_group_id`          the SendGrid unsubscribe-group id; consent evidence
 *   - `bounce_classification` the provider's own bounce category
 *
 * EXCLUDED (everything else, by default -- named here so a future reader
 * does not "restore" one without re-reading why it was dropped):
 *   - `email`                 the recipient address; the entire point of the scrub
 *   - `reason`, `response`    free-form SMTP text that routinely embeds the
 *                             recipient address verbatim inside a longer
 *                             string -- the clearest demonstration of why a
 *                             key-name denylist fails: neither key name
 *                             looks like PII, so no key rule would flag
 *                             them, and the address is a SUBSTRING of a
 *                             longer diagnostic message, not the whole value
 *   - `ip`, `useragent`       network/device identifiers about the person, personal data in their own right
 *   - `url`, `url_offset`     a clicked link can carry a per-recipient token/identifier in its query string
 *   - `category`, `unique_args`, `marketing_campaign_*`, and every other
 *     custom argument -- a tenant-defined key space, unenumerable by construction
 *   - everything else, by default -- the property that makes the guarantee hold
 */
export const SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST = [
  "event",
  "type",
  "timestamp",
  "sg_event_id",
  "sg_message_id",
  "smtp-id",
  "status",
  "attempt",
  "asm_group_id",
  "bounce_classification",
] as const;

/**
 * Phase 21 (DSR-03, D-02): the DSR export allowlist, declared as a SPREAD of
 * `SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST` followed by four additional keys
 * -- declaring it this way, rather than as a retyped 14-element literal, is
 * what makes the superset relationship STRUCTURAL rather than a promise a
 * future edit could quietly break; `send-event-payload-allowlist.test.ts`'s
 * "export allowlist is a superset of the evidence allowlist" test asserts
 * exactly this relationship, and its sibling test pins the set difference to
 * these four keys exactly, so an undecided addition to the export list
 * fails loudly.
 *
 * WHY THESE FOUR KEYS BELONG ON THE EXPORT PATH AND NOT THE EVIDENCE PATH:
 * on a per-recipient `send_events` row, `ip`, `useragent`, `url` and `reason`
 * are THIS subject's own network/device identifiers and the diagnostic text
 * about their own delivery attempt -- personal data about the data subject
 * making the DSR request, not about anyone else. A DSR answer that omitted
 * them would be incomplete: GDPR Art. 15 entitles the subject to their own
 * data, including data that a security-motivated redaction (the erasure
 * scrub) legitimately still removes because ERASURE only needs the fact and
 * status of the send to remain as compliance evidence -- it has no reason to
 * retain the subject's own network identifiers once the relationship with
 * the data has ended. Export and erasure answer different questions over
 * the same row, which is why the two allowlists differ by exactly these
 * four keys and no others.
 *
 * Tenant-defined keys (`unique_args`, `categories`, `marketing_campaign_*`,
 * and anything else a tenant's SendGrid custom_args might carry) stay OFF
 * both lists, for the same reason `buildScrubbedEventProperties` below
 * allowlists nothing from `events.properties`: that key space is
 * unenumerable by construction -- a tenant can put another subject's email,
 * name, or any other person's data under any key name it invents, and no
 * fixed list can be proven to exclude every such case. What erasure cannot
 * defend keeping, export cannot defend disclosing (D-01/D-02).
 */
export const SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST = [
  ...SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST,
  "ip",
  "useragent",
  "url",
  "reason",
] as const;

/**
 * Reconstructs a `send_events.payload` value by copying ONLY allowlisted
 * keys forward from the input -- builds a NEW object up from nothing, never
 * walks the input tearing keys out of it. The distinction matters even
 * though the two read as equivalent on a known-shape input: a build-up
 * implementation cannot leak a key nobody thought to name, a tear-down one
 * always can.
 *
 * Handles `null`, an array, or any other non-plain-object input by returning
 * an empty object rather than throwing -- the scrub must never fail on a
 * malformed historical row. Omits an allowlisted key that was absent from
 * the input rather than materializing it as `null`, so a scrubbed payload
 * never gains a field the original never had. Pure and idempotent by
 * construction (a reconstruction from a fixed allowlist applied to its own
 * output is a fixed point) -- asserted by tests anyway, because a resumed
 * page or a replayed job re-processes rows and a future change to this
 * function could break that silently.
 */
export function buildScrubbedSendEventPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return {};
  }
  const input = payload as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST) {
    if (key in input) {
      result[key] = input[key];
    }
  }
  return result;
}

/**
 * Phase 21 (DSR-03, D-02): the export-side counterpart to
 * `buildScrubbedSendEventPayload`, over `SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST`
 * instead of the evidence list. Identical build-up shape and the same
 * null/array/non-object handling and omit-rather-than-null-fill behavior --
 * the two builders are deliberately structurally parallel so a reviewer can
 * see at a glance that the only difference between "what erasure keeps" and
 * "what export discloses" is which allowlist each reads.
 */
export function buildExportSendEventPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return {};
  }
  const input = payload as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST) {
    if (key in input) {
      result[key] = input[key];
    }
  }
  return result;
}

/**
 * Unconditionally returns an empty object, for every input. `events.properties`
 * gets NO allowlist because there is no field in it that can be shown to be
 * evidence: the entire key space is tenant-supplied at event-ingestion time,
 * so naming any field here would be a guess about one tenant's schema
 * applied to every tenant. The event's own evidence -- that it occurred,
 * when, and for which contact -- lives in the row's non-JSONB columns
 * (`name`, `occurred_at`, `contact_id`), which this scrub never touches. If
 * a specific tenant-defined field is ever proven necessary as evidence,
 * adding a scoped allowlist for it is the change to make at that time; until
 * then, empty is the only defensible bound. Pure and idempotent (an empty
 * object rewritten from an empty object is still empty) -- asserted by
 * tests for the same replay-safety reason as `buildScrubbedSendEventPayload`.
 *
 * This is also the DSR export rule for `events.properties` (D-01): the
 * export path calls this SAME function rather than defining its own "always
 * empty" stub, so "no field of `events.properties` is ever disclosed" has
 * exactly one place to change if that rule is ever revisited, rather than
 * two independent copies of the same ruling that could silently diverge.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature intentionally accepts the input it ignores, documenting that no field of it is ever inspected
export function buildScrubbedEventProperties(properties: unknown): Record<string, unknown> {
  return {};
}

/** Rows-per-page bound for both scrub walks (T-13-13-05). Sized to match `flow-segment-sweep-flow.worker.ts`'s `SWEEP_PAGE_SIZE` precedent: large enough that a typical contact's history scrubs in a handful of pages, small enough that each page's transaction (a bounded SELECT plus up to this many single-row UPDATEs) stays short. Also the DSR export's own pagination precedent (D-10, plan 21-02+): the export's keyset-paginated reads over `sends`/`send_events`/`events` follow this same page-size bound. */
export const ERASURE_SCRUB_PAGE_LIMIT = 500;
