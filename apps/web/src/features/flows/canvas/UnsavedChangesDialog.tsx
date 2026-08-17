import type { Blocker } from "react-router";

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

/**
 * OPS-19/D-13: the in-app navigation guard's confirmation dialog, built on
 * the existing `alert-dialog` primitive (no new dialog component). Stay
 * resets the blocker -- the pending navigation is cancelled and the canvas
 * is left exactly as it was. Discard proceeds with the navigation the
 * marketer originally triggered; it never attempts a further save (the
 * abandoned draft is whatever the server last accepted).
 */
export function UnsavedChangesDialog({ blocker }: { blocker: Blocker }) {
  const open = blocker.state === "blocked";

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && blocker.state === "blocked") blocker.reset();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Есть несохранённые изменения</AlertDialogTitle>
          <AlertDialogDescription>
            Если вы продолжите, последние изменения холста будут потеряны и не будут отправлены на сохранение
            заново.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => blocker.state === "blocked" && blocker.reset()}>
            Остаться
          </AlertDialogCancel>
          <AlertDialogAction onClick={() => blocker.state === "blocked" && blocker.proceed()}>
            Уйти без сохранения
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default UnsavedChangesDialog;
