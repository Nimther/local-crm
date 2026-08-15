import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface QueryErrorStateProps {
  /**
   * Region-scoped title, e.g. "Не удалось загрузить контакты" -- lets two
   * error regions on the same page (a failed table and a failed feed next
   * to it) be told apart at a glance.
   */
  title: string;
  /**
   * Optional short, user-facing detail line. Never a raw server error body,
   * stack trace or SQL text (T-15-13) -- callers pass a fixed, curated or
   * status-derived message, never `err.message` directly.
   */
  detail?: string;
  /**
   * True while a retry request is in flight. Disables the control (so a
   * second click while one is already pending cannot fire a duplicate
   * request) and swaps its label to a pending state.
   */
  isFetching?: boolean;
  /** Re-runs the failed query -- callers pass their own TanStack Query `refetch`. */
  onRetry: () => void;
  className?: string;
}

/**
 * Shared inline error region (OPS-17, D-11 inline half; T-15-14). Renders a
 * contained, region-scoped failure state with a Retry control, driven
 * entirely by the caller's own TanStack Query `isError`/`isFetching`/
 * `refetch` triple -- this component never fetches, never reads the router,
 * never owns query state.
 *
 * Sized to sit inside a card/table area, never a full-page takeover. The
 * destructive border/text treatment plus the always-present Retry control
 * are what visually and textually distinguish this from `EmptyState`, which
 * never renders either.
 */
export function QueryErrorState({ title, detail, isFetching = false, onRetry, className }: QueryErrorStateProps) {
  return (
    <Card className={cn("border-destructive/50 bg-destructive/5", className)}>
      <CardHeader>
        <CardTitle className="text-destructive">{title}</CardTitle>
        {detail ? <CardDescription>{detail}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        <Button variant="outline" size="sm" onClick={onRetry} disabled={isFetching}>
          {isFetching ? "Повторяем..." : "Повторить"}
        </Button>
      </CardContent>
    </Card>
  );
}

export default QueryErrorState;
