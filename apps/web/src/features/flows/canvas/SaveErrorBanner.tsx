import { Button } from "@/components/ui/button";

/**
 * OPS-19/D-13: a persistent inline banner on the canvas whenever the last
 * autosave failed -- never a toast, never auto-dismissing. It disappears
 * only when a save actually succeeds (the caller conditions its render on
 * `saveState === "error"`, the same WR-05 signal the toolbar indicator
 * already reads). Reads as a sibling of `QueryErrorState`'s inline-error
 * idiom (destructive border/text + a Retry control) rather than a fourth
 * error language.
 */
export function SaveErrorBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-4 border-b border-destructive/50 bg-destructive/5 px-4 py-2 text-sm text-destructive"
    >
      <span>Не удалось сохранить изменения холста. Работа не потеряна, но пока не отправлена на сервер.</span>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Повторить
      </Button>
    </div>
  );
}

export default SaveErrorBanner;
