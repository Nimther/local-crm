import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useCampaignDirtyState } from "@/features/campaigns/CampaignDirtyStateContext";

const UNSAVED_CHANGES_COPY =
  "Есть несохранённые изменения — сохраните черновик, чтобы отправить, запланировать или отправить тестовое письмо.";

/**
 * D-01/D-02/D-03: the amber unsaved-changes notice, placed next to the
 * actions it blocks. Reads `useCampaignDirtyState()` directly (no props) so
 * `CampaignDetailPage` doesn't need to prop-drill the dirty state down, and
 * so this component can be rendered in a test against a hand-made context
 * value via `CampaignDirtyStateContext.Provider`. Renders `null` when clean
 * -- no empty-but-visible placeholder. Deliberately no discard/undo
 * affordance: D-03 chose a save-only banner, one save path, not two.
 */
export function UnsavedChangesBanner() {
  const { isDirty, isSaving, save } = useCampaignDirtyState();

  if (!isDirty) return null;

  return (
    <Card className="border-amber-200 bg-amber-50">
      <CardContent className="flex items-center justify-between gap-3 p-4 text-sm text-amber-700">
        <p>{UNSAVED_CHANGES_COPY}</p>
        <Button type="button" onClick={save} disabled={isSaving}>
          {isSaving ? "Сохраняем…" : "Сохранить"}
        </Button>
      </CardContent>
    </Card>
  );
}

export default UnsavedChangesBanner;
