/**
 * 07-10 (gap closure, UAT Test 1): pure helpers for the send-log's
 * campaign/flow target filter. Mirrors SendLogPage.tsx's mutual-exclusion
 * rule (`campaignOrFlowId = campaignId ?? flowId`) so a caller can never
 * write both `?campaign=` and `?flow=` at once.
 */

export type SendTarget = { kind: "campaign" | "flow"; id: string };

/**
 * Returns a NEW URLSearchParams reflecting `target` applied on top of
 * `current` -- never mutates the input. `campaign` and `flow` are always
 * mutually exclusive: setting one clears the other. Any target change also
 * resets pagination (`page`) back to page 1 (i.e. deletes it), matching every
 * other filter mutator on the page (toggleStatus/setPeriod/clearParam).
 */
export function applySendTargetToParams(
  current: URLSearchParams,
  target: SendTarget | null
): URLSearchParams {
  const next = new URLSearchParams(current);

  if (target === null) {
    next.delete("campaign");
    next.delete("flow");
    next.delete("page");
    return next;
  }

  if (target.kind === "campaign") {
    next.set("campaign", target.id);
    next.delete("flow");
  } else {
    next.set("flow", target.id);
    next.delete("campaign");
  }
  next.delete("page");

  return next;
}

export interface SendTargetOption {
  id: string;
  name: string;
}

/**
 * Resolves the send-log's active campaign/flow filter to a displayable
 * label. Campaign takes priority over flow when both are set (mirrors
 * SendLogPage's `campaignOrFlowId = campaignId ?? flowId`). If the id isn't
 * found in the provided list (e.g. a stale deep-link), the label falls back
 * to the raw id string rather than returning null -- a stale filter still
 * renders something instead of silently disappearing.
 */
export function resolveSendTargetLabel(
  campaignId: string | undefined,
  flowId: string | undefined,
  campaigns: SendTargetOption[],
  flows: SendTargetOption[]
): { kind: "campaign" | "flow"; id: string; label: string } | null {
  if (campaignId) {
    const match = campaigns.find((c) => c.id === campaignId);
    return { kind: "campaign", id: campaignId, label: match?.name ?? campaignId };
  }
  if (flowId) {
    const match = flows.find((f) => f.id === flowId);
    return { kind: "flow", id: flowId, label: match?.name ?? flowId };
  }
  return null;
}
