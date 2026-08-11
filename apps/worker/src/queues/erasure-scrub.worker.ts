/**
 * Phase 13 (CMP-04, D-01/D-04, plan 13-13): the asynchronous evidence-hygiene
 * half of contact erasure. Plan 13-10's `deleteContact` anonymizes the
 * `contacts` row synchronously and enqueues exactly one job on
 * `ERASURE_SCRUB_QUEUE`; this file consumes it, walking the erased contact's
 * linked `send_events.payload` and `events.properties` rows in bounded,
 * resumable pages and rewriting each JSONB value.
 *
 * ALLOWLIST RECONSTRUCTION, NOT A DENYLIST FILTER (REVIEWS.md (Codex)
 * BLOCKER finding 4 -- this reverses an earlier version of this plan that
 * directed reuse of `@mega-crm/redaction`'s `REDACTION_RULES`). A denylist
 * can only remove what someone anticipated: `REDACTION_RULES`'s `keyRules`
 * match known field NAMES and its `valueRules` backstop narrows the gap for
 * email/phone-SHAPED values, but neither can bound `events.properties`,
 * whose entire key space is tenant-invented, or a `send_events.payload`
 * field like `reason`/`response` that carries the recipient's address inside
 * a longer free-form SMTP diagnostic string under a key name that looks
 * like nothing sensitive at all. Reconstructing from an allowlist inverts
 * the burden: an unanticipated field is dropped BY CONSTRUCTION (it was
 * simply never copied forward), not by a detector that could miss it. This
 * file therefore imports nothing from `@mega-crm/redaction` and defines no
 * PII-shaped regular expression of its own -- see this module's own tests
 * for the specific cases (`reason` embedding an address, a tenant-invented
 * key holding a person's name) that a denylist provably cannot catch and
 * this allowlist closes by never copying them forward at all.
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
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature intentionally accepts the input it ignores, documenting that no field of it is ever inspected
export function buildScrubbedEventProperties(properties: unknown): Record<string, unknown> {
  return {};
}
