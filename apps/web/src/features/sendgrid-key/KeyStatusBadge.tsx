import { Badge } from "@/components/ui/badge";

export type SendgridKeyBadgeStatus = "active" | "error" | "pending";

const LABELS: Record<SendgridKeyBadgeStatus, string> = {
  active: "Активен",
  error: "Ошибка",
  pending: "Проверяем…",
};

/** D-22: semantic status colors (badge-only, per UI-SPEC) -- green/red/neutral, never general UI accent. */
const CLASSES: Record<SendgridKeyBadgeStatus, string> = {
  active: "border-transparent bg-green-50 text-green-600",
  error: "border-transparent bg-red-50 text-destructive",
  pending: "border-transparent bg-neutral-100 text-neutral-500",
};

export function KeyStatusBadge({ status }: { status: SendgridKeyBadgeStatus }) {
  return (
    <Badge variant="outline" className={CLASSES[status]}>
      {LABELS[status]}
    </Badge>
  );
}

export default KeyStatusBadge;
