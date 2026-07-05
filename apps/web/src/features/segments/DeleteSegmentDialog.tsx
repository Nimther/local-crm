import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import type { SegmentResponse } from "@mega-crm/shared-schemas";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { deleteSegment } from "@/features/segments/api";

const GENERIC_ERROR = "Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.";

/**
 * D-14: free-deletion confirmation (Phase 3 -- nothing references segments
 * yet; restrict-when-referenced lands in Phase 4/6). Controlled dialog --
 * opened from the list row's dropdown-menu "Удалить" item, not its own
 * trigger, so the dropdown can close before the alert-dialog mounts.
 */
export function DeleteSegmentDialog({
  slug,
  segment,
  open,
  onOpenChange,
}: {
  slug: string;
  segment: SegmentResponse;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: () => deleteSegment(slug, segment.id),
    onSuccess: async () => {
      setServerError(null);
      toast.success("Сегмент удалён");
      await queryClient.invalidateQueries({ queryKey: ["workspace", slug, "segments"] });
      onOpenChange(false);
    },
    onError: () => {
      setServerError(GENERIC_ERROR);
    },
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Удалить сегмент «{segment.name}»?</AlertDialogTitle>
          <AlertDialogDescription>
            Сегмент будет удалён без возможности восстановления. Сейчас он нигде не используется, поэтому удаление
            ничем не ограничено — в следующих фазах кампании и цепочки будут блокировать удаление сегмента, на
            который они ссылаются.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {serverError ? <p className="text-sm font-medium text-destructive">{serverError}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction
            disabled={deleteMutation.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(e) => {
              e.preventDefault();
              deleteMutation.mutate();
            }}
          >
            {deleteMutation.isPending ? "Удаляем…" : "Удалить сегмент"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default DeleteSegmentDialog;
