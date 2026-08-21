/**
 * TMPL-01/D-01/D-02/D-03 dirty-state comparison -- the located bug's client
 * half. The campaign builder's four editable fields (name, segmentId,
 * templateId, fromSenderId) live in local React state while TestSendPanel
 * and LaunchScheduleActions act on the saved server row; without this
 * module, changing a dropdown and sending before saving silently sends the
 * OLD saved values while the screen shows the NEW ones.
 *
 * One mental model (D-02): any ONE of the four fields differing is enough
 * to be dirty -- there is no partial-dirty state and no per-field
 * enumeration shown to the marketer. What you see is saved, or you cannot
 * send.
 *
 * `fromEmail` is deliberately excluded from `CampaignFormSnapshot`: it is
 * written server-side by the sender resolver, never edited by the
 * marketer, and comparing it would show a false unsaved state the instant
 * a resolution persists a new address with no form edit at all.
 *
 * Pure, framework-free (no React import) so it can be exhaustively unit
 * tested in this workspace's `environment: "node"` vitest lane, mirroring
 * segmentSaveGate.ts's role as the single source of truth more than one
 * consumer reads rather than each re-deriving its own comparison --
 * `CampaignDirtyStateContext.tsx` computes through this module once, and
 * `UnsavedChangesBanner`, `LaunchScheduleActions` and `TestSendPanel` all
 * read the derived value through that context.
 *
 * A form field added to the campaign builder by a later phase is NOT
 * automatically compared -- it must be added to `CampaignFormSnapshot`
 * below, or an unsaved edit to it will silently fail to block a send. This
 * coupling is deliberate, not an oversight.
 */

/** Minimal structural shape -- lets a caller pass the builder's live field values or a saved CampaignResponse directly. */
export interface CampaignFormSnapshot {
  name: string;
  segmentId: string | null;
  templateId: string | null;
  fromSenderId: string | null;
}

/** The inline reason shown next to a blocked action while the form is unsaved. */
export const DIRTY_BLOCK_REASON =
  "Сохраните изменения, чтобы отправить, запланировать или отправить тестовое письмо";

/**
 * True when any of the four compared fields differs between `form` and
 * `saved`. `form.name` is trimmed before comparison, matching what the save
 * mutation actually sends (see CampaignBuilderPage's handleSave), so
 * leading/trailing whitespace alone never reads as dirty.
 */
export function computeIsDirty(form: CampaignFormSnapshot, saved: CampaignFormSnapshot): boolean {
  if (form.name.trim() !== saved.name) return true;
  if (form.segmentId !== saved.segmentId) return true;
  if (form.templateId !== saved.templateId) return true;
  if (form.fromSenderId !== saved.fromSenderId) return true;
  return false;
}

/** The inline block reason when dirty, or null when the form matches the saved row. */
export function computeDirtyBlockReason(
  form: CampaignFormSnapshot,
  saved: CampaignFormSnapshot
): string | null {
  return computeIsDirty(form, saved) ? DIRTY_BLOCK_REASON : null;
}
