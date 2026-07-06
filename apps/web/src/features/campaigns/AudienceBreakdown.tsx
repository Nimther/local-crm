import type { CampaignAudienceBreakdown } from "@/features/campaigns/api";

/**
 * D-04: exact Russian nouns reused verbatim from SubscriptionStatusBadge's
 * labels («Отписан» -> «отписаны», «В списке подавления» -> «в списке
 * подавления») for the two subscription-driven exclusion reasons, plus the
 * two send-gate-only reasons (`no_email`, `frequency_cap`) from
 * pre-send-gate.ts's `PreSendSkipReason` union.
 */
const REASON_LABELS: Record<string, string> = {
  unsubscribed: "отписаны",
  suppressed: "в списке подавления",
  no_email: "без email",
  frequency_cap: "превысили частотный лимит",
};

/**
 * D-04 audience-exclusion panel: the sendable count in Display (28/600) +
 * «получателей» underneath, then each non-zero exclusion reason as its own
 * Label/meta line — zero-count reasons are omitted entirely (04-UI-SPEC empty
 * state rule), never rendered as "0 исключено".
 */
export function AudienceBreakdown({ data }: { data: CampaignAudienceBreakdown }) {
  const nonZero = data.breakdown.filter((item) => item.count > 0);

  return (
    <div className="space-y-1">
      <p className="text-display font-semibold">{data.sendableCount.toLocaleString("ru-RU")}</p>
      <p className="text-sm text-muted-foreground">получателей</p>
      {nonZero.map((item) => (
        <p key={item.reason} className="text-sm text-muted-foreground">
          {item.count.toLocaleString("ru-RU")} {REASON_LABELS[item.reason] ?? item.reason}
        </p>
      ))}
    </div>
  );
}

export default AudienceBreakdown;
