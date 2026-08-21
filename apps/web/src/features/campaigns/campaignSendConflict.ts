/**
 * TMPL-02/D-08/D-09/D-10 -- typed classification of a 409 send response and
 * the conflict copy it selects.
 *
 * The API's `mapCampaignStateError` (apps/api's campaigns.routes.ts, plan
 * 20-02) always carries a typed `code` string in the 409 response body.
 * Branching happens on THAT code -- never on `err.message` -- because copy
 * is not a contract: a later wording change to `CampaignStateError`'s
 * message must never silently break the recovery path a marketer depends
 * on (RESEARCH Pitfall #2, D-08/D-09).
 *
 * No function in this module, and no caller of it, may re-submit a send
 * action after a conflict. Auto-retry was explicitly rejected for this
 * phase (20-CONTEXT.md's Specifics note, T-20-06-01) -- the marketer's own
 * next click is the only thing that may resend. This module only classifies
 * and composes copy; it never calls a mutation.
 *
 * Pure, framework-free (no React import), mirroring campaignDirtyState.ts's
 * role as a single source more than one caller reads.
 */

import { ApiError } from "@/lib/api";
import { CAMPAIGN_STATUS_LABELS } from "@/features/campaigns/CampaignStatusBadge";
import type { CampaignStatus } from "@/features/campaigns/api";

export type SendConflictKind = "version_conflict" | "illegal_transition";

const RECOVERABLE_CODES: ReadonlySet<string> = new Set<SendConflictKind>([
  "version_conflict",
  "illegal_transition",
]);

/**
 * Returns the recoverable conflict kind for a 409 `ApiError` whose parsed
 * body carries one of the two typed codes, or `null` for everything else
 * (a 409 with no/unrecognised code, any other status, or a non-`ApiError`
 * thrown value) -- the generic copy keeps covering everything outside the
 * two recoverable codes. The body is read defensively: it may be a string
 * or `undefined` (a non-JSON error body), and that must never throw.
 */
export function classifySendError(err: unknown): SendConflictKind | null {
  if (!(err instanceof ApiError)) return null;
  if (err.status !== 409) return null;

  const body = err.body;
  if (!body || typeof body !== "object") return null;

  const code = (body as Record<string, unknown>).code;
  if (typeof code !== "string") return null;
  if (!RECOVERABLE_CODES.has(code)) return null;

  return code as SendConflictKind;
}

/** D-08's exact wording -- shown when the caller's `expectedVersion` no longer matches the row. */
export const VERSION_CONFLICT_COPY = "Кампания была изменена — данные обновлены, проверьте и повторите";

/**
 * D-09: composed from the live campaign's own status label -- the caller
 * must pass the FRESH status (read after the conflict-triggered refetch),
 * never a value captured when the error arrived, so the named state is
 * always the real one.
 */
export function illegalTransitionCopy(status: CampaignStatus): string {
  return `Кампания уже в статусе «${CAMPAIGN_STATUS_LABELS[status]}» — данные обновлены, проверьте и повторите`;
}

/** D-10: the informational (not error) notice shown when a conflict-triggered refetch replaces unsaved local edits. */
export const CONFLICT_REFRESH_NOTICE =
  "Данные кампании обновлены — несохранённые изменения заменены сохранёнными значениями.";
