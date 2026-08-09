/**
 * Executable send-delivery state machine (DLV-01, Phase 11 D-18).
 *
 * This module is the executable mirror of ARCHITECTURE.md's "The send
 * delivery state machine" section (## 9) -- every transition documented
 * there as prose/mermaid/table must appear here as a data entry, and vice
 * versa. The `satisfies Record<SendStatus, ...>` clause below is what turns
 * "someone added a status and forgot to document its transitions" into a
 * `npm run typecheck` failure rather than a silent drift between the two
 * artifacts.
 *
 * No `reconciling -> failed` (or `unknown -> failed`) transition exists,
 * anywhere in this matrix, and none should ever be added: `failed` means
 * "SendGrid synchronously rejected the send with a permanent 4xx", a fact
 * only the job processor can observe directly at send time (unit 2/3 of the
 * three-unit dispatch discipline). A webhook is asynchronous, positive-only
 * evidence -- SendGrid tells you what a message *did* do, and never emits an
 * event proving a message was *never* accepted. The reconciler therefore has
 * exactly two possible terminal writes leaving `reconciling`/`unknown`:
 * `-> sent` (evidence found) and `-> unknown` (resolution window elapsed
 * with no evidence). See ARCHITECTURE.md ## 9, "Why the reconciler never
 * writes `failed`".
 *
 * `excluded` is reachable directly from no-row-yet, via
 * `recordExcluded`/`recordFlowExcluded`, for contacts that never reach the
 * claim gate at all (suppressed/unsubscribed/frequency-capped before any
 * SendGrid attempt) -- it does not pass through `dispatching`, and this
 * module's transition table (which only records edges *leaving* a state)
 * does not need a special case for that: `excluded`'s own entry below is
 * simply the terminal, empty transition list.
 */

/** The full send-status vocabulary (Phase 11 adds `reconciling`/`unknown`). */
export const SEND_STATUSES = [
  "dispatching",
  "sent",
  "failed",
  "excluded",
  "reconciling",
  "unknown",
] as const;

export type SendStatus = (typeof SEND_STATUSES)[number];

/**
 * The one component allowed to write a given transition. `pre_send_gate` is
 * included in the union for completeness (it is the component that inserts
 * the very first `dispatching` row / `excluded` row), even though no entry
 * in `SEND_STATUS_TRANSITIONS` below currently names it as a writer of a
 * `from -> to` edge -- `[*] -> dispatching` and `[*] -> excluded` are entry
 * points, not transitions between two `SendStatus` values, so they are
 * documented in ARCHITECTURE.md's diagram but are not represented as rows
 * in this from-keyed table.
 */
export type SendStatusWriter = "worker" | "reconciler" | "pre_send_gate";

export interface SendTransition {
  to: SendStatus;
  writers: readonly SendStatusWriter[];
  trigger: string;
}

/**
 * Per-`from`-status list of allowed outgoing transitions. Every `SendStatus`
 * value must have an entry (enforced by `satisfies Record<SendStatus, ...>`
 * below) -- terminal states (`sent`, `failed`, `excluded`) have an empty
 * array, meaning "no outgoing transition is ever allowed to leave this
 * state again".
 *
 * `dispatching -> reconciling` is the ONLY transition with two writers
 * (`worker` and `reconciler`), by deliberate design (Phase 11 CONTEXT.md
 * D-08, assumption-delta decision "add-alongside, accepted debt"): the
 * worker writes it for the ambiguous-outcome and interrupted-redelivery
 * cases it observes directly in-band; the reconciler writes it for the
 * stale-age sweep of orphaned `dispatching` rows it discovers out-of-band.
 * Every other transition in this table has exactly one writer -- a test in
 * `send-state-machine.test.ts` asserts this invariant so a future third
 * writer on any transition (or a second writer added to any transition
 * other than this one) breaks a test rather than silently reintroducing the
 * duplicate-write race this phase exists to close.
 */
export const SEND_STATUS_TRANSITIONS = {
  dispatching: [
    {
      to: "sent",
      writers: ["worker"],
      trigger: "unit 3, SendGrid 2xx response",
    },
    {
      to: "failed",
      writers: ["worker"],
      trigger: "unit 3, SendGrid permanent 4xx response",
    },
    {
      to: "reconciling",
      writers: ["worker", "reconciler"],
      trigger:
        "worker: unit 3 ambiguous throw (timeout/ECONNRESET/fail-closed default) or interrupted redelivery (a prior claim survived with no terminal write); reconciler: stale-dispatching sweep (age exceeds the max-job-lifetime threshold with no interrupted detection ever having run)",
    },
  ],
  reconciling: [
    {
      to: "sent",
      writers: ["reconciler"],
      trigger: "webhook evidence found in send_events for this send_id",
    },
    {
      to: "unknown",
      writers: ["reconciler"],
      trigger: "resolution window (~24h) elapsed with no evidence",
    },
  ],
  unknown: [
    {
      to: "sent",
      writers: ["reconciler"],
      trigger: "late evidence found within the re-scan horizon (~72h)",
    },
  ],
  sent: [],
  failed: [],
  excluded: [],
} as const satisfies Record<SendStatus, readonly SendTransition[]>;

/** True iff `from -> to` appears in `SEND_STATUS_TRANSITIONS`. */
export function isAllowedTransition(from: SendStatus, to: SendStatus): boolean {
  return SEND_STATUS_TRANSITIONS[from].some((transition) => transition.to === to);
}

/**
 * The writer(s) for a given `from -> to` transition, or an empty array if
 * the transition is not in the matrix at all (including the case where
 * `from` is a terminal state with no outgoing transitions).
 */
export function writersFor(from: SendStatus, to: SendStatus): readonly SendStatusWriter[] {
  const transition = SEND_STATUS_TRANSITIONS[from].find((t) => t.to === to);
  return transition ? transition.writers : [];
}
