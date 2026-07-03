import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiDelete } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

/** D-20: Owner-only, type-the-name-to-confirm soft delete. */
export function DeleteWorkspaceDialog({ slug, workspaceName }: { slug: string; workspaceName: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: () => apiDelete(`/api/workspaces/${slug}`, { confirmName }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      navigate("/", { replace: true });
    },
    onError: () => {
      setServerError("Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.");
    },
  });

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setConfirmName("");
      setServerError(null);
    }
  }

  const nameMatches = confirmName.trim() === workspaceName;

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" className="border-destructive text-destructive hover:bg-destructive/10">
          Удалить воркспейс
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Удалить воркспейс «{workspaceName}»?</AlertDialogTitle>
          <AlertDialogDescription>
            Все контакты, события, кампании и статистика воркспейса будут безвозвратно удалены. Введите название
            воркспейса, чтобы подтвердить.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          value={confirmName}
          onChange={(e) => setConfirmName(e.target.value)}
          placeholder={workspaceName}
          autoComplete="off"
        />
        {serverError ? <p className="text-sm font-medium text-destructive">{serverError}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction
            disabled={!nameMatches || deleteMutation.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(e) => {
              e.preventDefault();
              deleteMutation.mutate();
            }}
          >
            {deleteMutation.isPending ? "Удаляем…" : "Удалить воркспейс"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default DeleteWorkspaceDialog;
