import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useEnrollPreview, usePublishFlow, type FlowResponse } from "@/features/flows/api";

const GENERIC_ERROR = "Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.";

interface PublishBlocker {
  /** nodeId for a node-scoped error, or the literal "trigger" for the flow-scoped no_trigger error (mirrors shapeFlowValidationFields). */
  key: string;
  message: string;
}

/**
 * Pitfall 3/D-17: the publish action is ALWAYS server-authoritative -- a 422
 * response's {fields} breakdown IS the blocker list, never the client's own
 * validateFlowDefinition computation. Parses the exact shape
 * shapeFlowValidationFields produces (apps/api/src/modules/flows/flow-validation.ts).
 */
function parseBlockerFields(body: unknown): PublishBlocker[] {
  if (!body || typeof body !== "object" || !("fields" in body)) return [];
  const fields = (body as { fields?: unknown }).fields;
  if (!fields || typeof fields !== "object") return [];
  return Object.entries(fields as Record<string, string>).map(([key, message]) => ({ key, message }));
}

/**
 * D-04 publish/enroll dialog. For a segment-triggered flow: fetches the
 * enroll-preview count and presents the three-choice dialog («Зачислить и
 * опубликовать» / «Опубликовать только для новых» / «Отмена»). For an
 * event-triggered flow: the simple confirm variant. On a 422 rejection,
 * renders the SERVER-returned hard-error blocker list with the offending
 * node/trigger clickable via onSelectNode (which the caller wires to switch
 * to the canvas tab and focus that node) -- the client never trusts its own
 * validity flag as authority (Pitfall 3, T-06-11-02).
 */
export function PublishEnrollDialog({
  slug,
  flow,
  segmentName,
  open,
  onOpenChange,
  onSelectNode,
}: {
  slug: string;
  flow: FlowResponse;
  segmentName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectNode: (nodeId: string) => void;
}) {
  const isSegmentTriggered = flow.triggerType === "segment";

  const enrollPreviewQuery = useEnrollPreview(slug, flow.id, open && isSegmentTriggered);
  const publishMutation = usePublishFlow(slug);

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
  }

  function publish(enrollExisting?: boolean) {
    publishMutation.mutate(
      { id: flow.id, enrollExisting },
      {
        onSuccess: () => {
          toast.success("Цепочка опубликована");
          handleOpenChange(false);
        },
        onError: (error: unknown) => {
          if (error instanceof ApiError && error.status === 422) {
            toast.error("Не удалось опубликовать — исправьте отмеченные узлы");
          } else {
            toast.error(GENERIC_ERROR);
          }
        },
      }
    );
  }

  const blockers =
    publishMutation.isError && publishMutation.error instanceof ApiError && publishMutation.error.status === 422
      ? parseBlockerFields(publishMutation.error.body)
      : [];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Опубликовать цепочку «{flow.name}»?</DialogTitle>
          <DialogDescription>
            {isSegmentTriggered
              ? `В сегменте «${segmentName ?? "…"}» сейчас ~${
                  enrollPreviewQuery.data ? enrollPreviewQuery.data.count.toLocaleString("ru-RU") : "…"
                } контактов. Зачислить их в цепочку сейчас, или запускать только для тех, кто попадёт в сегмент после публикации?`
              : `Цепочка начнёт запускаться по событию «${flow.triggerEventName ?? ""}». Новые подходящие контакты будут входить в неё автоматически.`}
          </DialogDescription>
        </DialogHeader>

        {isSegmentTriggered && enrollPreviewQuery.isLoading ? <Skeleton className="h-6 w-32" /> : null}

        {blockers.length > 0 ? (
          <div className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-3">
            <p className="text-sm font-semibold text-destructive">Не удалось опубликовать</p>
            <ul className="space-y-1">
              {blockers.map((blocker) => (
                <li key={blocker.key}>
                  <button
                    type="button"
                    className="text-left text-sm text-destructive underline-offset-2 hover:underline"
                    onClick={() => onSelectNode(blocker.key)}
                  >
                    {blocker.message}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <DialogFooter className={isSegmentTriggered ? "flex-col gap-2 sm:flex-col" : undefined}>
          {isSegmentTriggered ? (
            <>
              <Button
                type="button"
                className="w-full"
                disabled={publishMutation.isPending}
                onClick={() => publish(true)}
              >
                {publishMutation.isPending ? "Публикуем…" : "Зачислить и опубликовать"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                disabled={publishMutation.isPending}
                onClick={() => publish(false)}
              >
                Опубликовать только для новых
              </Button>
              <Button type="button" variant="ghost" className="w-full" onClick={() => handleOpenChange(false)}>
                Отмена
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Отмена
              </Button>
              <Button type="button" disabled={publishMutation.isPending} onClick={() => publish(undefined)}>
                {publishMutation.isPending ? "Публикуем…" : "Опубликовать"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default PublishEnrollDialog;
