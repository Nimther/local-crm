import type { FlowStatus } from "@/features/flows/api";
import { Badge } from "@/components/ui/badge";

const LABELS: Record<FlowStatus, string> = {
  draft: "Черновик",
  live: "Live",
  paused: "Приостановлена",
};

/**
 * 06-UI-SPEC Color section: draft=neutral (resting), live=indigo (the
 * "active operation" reuse of Phase 4's «Отправляется» rationale),
 * paused=amber (needs-attention, distinct from a failure).
 */
const CLASSES: Record<FlowStatus, string> = {
  draft: "border-transparent bg-neutral-100 text-neutral-500",
  live: "border-transparent bg-indigo-50 text-indigo-600",
  paused: "border-transparent bg-amber-50 text-amber-700",
};

export function FlowStatusBadge({ status }: { status: FlowStatus }) {
  return (
    <Badge variant="outline" className={CLASSES[status]}>
      {LABELS[status]}
    </Badge>
  );
}

export default FlowStatusBadge;
