import { XCircle } from "lucide-react";

import type { CampaignStatus } from "@/features/campaigns/api";
import { Badge } from "@/components/ui/badge";

const LABELS: Record<CampaignStatus, string> = {
  draft: "Черновик",
  scheduled: "Запланирована",
  sending: "Отправляется",
  sent: "Отправлена",
  canceled: "Отменена",
};

/**
 * 04-UI-SPEC Color section: draft/canceled=neutral (canceled distinguished
 * by an XCircle icon, not a new color), scheduled=amber ("needs attention"),
 * sending=indigo (the one accent extension, mirrors the progress bar),
 * sent=green (success, same as Подписан/CSV-created precedent).
 */
const CLASSES: Record<CampaignStatus, string> = {
  draft: "border-transparent bg-neutral-100 text-neutral-500",
  scheduled: "border-transparent bg-amber-50 text-amber-700",
  sending: "border-transparent bg-indigo-50 text-indigo-600",
  sent: "border-transparent bg-green-50 text-green-600",
  canceled: "border-transparent bg-neutral-100 text-neutral-500",
};

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  return (
    <Badge variant="outline" className={CLASSES[status]}>
      {status === "canceled" ? <XCircle className="mr-1 h-3 w-3" /> : null}
      {LABELS[status]}
    </Badge>
  );
}

export default CampaignStatusBadge;
