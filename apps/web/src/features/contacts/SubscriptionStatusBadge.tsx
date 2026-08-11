import type { SubscriptionStatus } from "@mega-crm/shared-schemas";
import { Badge } from "@/components/ui/badge";

const LABELS: Record<SubscriptionStatus, string> = {
  subscribed: "Подписан",
  unsubscribed: "Отписан",
  suppressed: "В списке подавления",
};

/** SUBS-01/D-12: semantic status colors (badge-only) -- subscribed=green, unsubscribed=neutral, suppressed=red (destructive precedent). */
const CLASSES: Record<SubscriptionStatus, string> = {
  subscribed: "border-transparent bg-green-50 text-green-600",
  unsubscribed: "border-transparent bg-neutral-100 text-neutral-500",
  suppressed: "border-transparent bg-red-50 text-destructive",
};

export function SubscriptionStatusBadge({ status }: { status: SubscriptionStatus }) {
  return (
    <Badge variant="outline" className={CLASSES[status]}>
      {LABELS[status]}
    </Badge>
  );
}

export default SubscriptionStatusBadge;
