import type { ReactNode } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** Optional call-to-action node (e.g. a "create contact" button). */
  action?: ReactNode;
  className?: string;
}

/**
 * Shared empty-state region (OPS-17, D-11 inline half; T-15-14). Renders a
 * successful fetch that returned zero rows -- visually and textually
 * distinct from `QueryErrorState` by construction: no destructive styling,
 * and never a Retry control. Call sites pass an optional `action` node for
 * the zero-rows case (e.g. "create your first contact"); this component
 * never fetches, never reads the router, never owns query state.
 */
export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <Card className={cn(className)}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      {action ? <CardContent>{action}</CardContent> : null}
    </Card>
  );
}

export default EmptyState;
