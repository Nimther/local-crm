import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { computeDirtyBlockReason, computeIsDirty, type CampaignFormSnapshot } from "@/features/campaigns/campaignDirtyState";
import type { CampaignResponse } from "@/features/campaigns/api";

function noop() {
  /* inert default -- see CampaignDirtyStateContext's default value below */
}

/**
 * The single shared unsaved-state value the draft view's three consumers
 * (UnsavedChangesBanner, LaunchScheduleActions, TestSendPanel) all read
 * through `useCampaignDirtyState()`. `publish` is internal plumbing used
 * only by `usePublishCampaignFormState` -- exported on the value because
 * the context object itself must be exported too (see below), not because
 * a consumer is expected to call it directly.
 */
export interface CampaignDirtyStateContextValue {
  isDirty: boolean;
  blockReason: string | null;
  isSaving: boolean;
  save: () => void;
  publish: (snapshot: CampaignFormSnapshot | null, save: () => void, isSaving: boolean) => void;
}

/**
 * Exporting the context object itself (not just a hook) is required: it is
 * how a unit/rendered-markup test seeds a hand-made state via
 * `CampaignDirtyStateContext.Provider`, and how `/campaigns/new` (which
 * mounts `CampaignBuilderPage` with no provider above it) stays byte-
 * identical in behaviour -- the default value below is fully inert.
 */
export const CampaignDirtyStateContext = createContext<CampaignDirtyStateContextValue>({
  isDirty: false,
  blockReason: null,
  isSaving: false,
  save: noop,
  publish: noop,
});

/** Read by the banner and both send-blocking action components. */
export function useCampaignDirtyState(): CampaignDirtyStateContextValue {
  return useContext(CampaignDirtyStateContext);
}

/**
 * Wraps the draft view's embedded builder AND its two sibling action
 * components (`CampaignDetailPage`'s draft branch) so all three consumers
 * compare against the exact same saved row.
 */
export function CampaignDirtyStateProvider({
  saved,
  children,
}: {
  saved: CampaignResponse;
  children: ReactNode;
}) {
  // A null snapshot means the builder has not published yet (has not
  // synced from the server row) -- computed state below reads that as
  // clean, never dirty, so the banner cannot flash true before the
  // builder's own server-row sync effect has landed.
  const [snapshot, setSnapshot] = useState<CampaignFormSnapshot | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // Held in a ref, not state: a re-publish (any field changing) can update
  // which save callback `save()` will invoke without needing `save`'s own
  // identity to change, and without ever holding a closure older than the
  // last field change.
  const saveRef = useRef<() => void>(noop);

  const save = useCallback(() => {
    saveRef.current();
  }, []);

  const publish = useCallback(
    (nextSnapshot: CampaignFormSnapshot | null, nextSave: () => void, nextIsSaving: boolean) => {
      saveRef.current = nextSave;
      setSnapshot(nextSnapshot);
      setIsSaving(nextIsSaving);
    },
    []
  );

  const savedSnapshot: CampaignFormSnapshot = {
    name: saved.name,
    segmentId: saved.segmentId,
    templateId: saved.templateId,
    fromSenderId: saved.fromSenderId,
  };

  const isDirty = snapshot !== null && computeIsDirty(snapshot, savedSnapshot);
  const blockReason = snapshot !== null ? computeDirtyBlockReason(snapshot, savedSnapshot) : null;

  const value = useMemo<CampaignDirtyStateContextValue>(
    () => ({ isDirty, blockReason, isSaving, save, publish }),
    [isDirty, blockReason, isSaving, save, publish]
  );

  return <CampaignDirtyStateContext.Provider value={value}>{children}</CampaignDirtyStateContext.Provider>;
}

/**
 * The builder-side hook: publishes its live field values (plus its save
 * callback and saving flag) up to whichever provider is mounted above it,
 * if any. Outside a provider the default no-op `publish` makes this whole
 * hook inert, which is what keeps `/campaigns/new` (no provider mounted)
 * working exactly as before.
 */
export function usePublishCampaignFormState({
  form,
  save,
  isSaving,
  enabled,
}: {
  form: CampaignFormSnapshot;
  save: () => void;
  isSaving: boolean;
  enabled: boolean;
}) {
  const { publish } = useContext(CampaignDirtyStateContext);

  useEffect(() => {
    // T-20-05-03: this dependency list is EXACTLY the four compared fields
    // plus isSaving/enabled -- deliberately omitting `publish`/`save` (a
    // provider re-render, e.g. isDirty flipping, changes neither and so
    // cannot re-fire this effect; the caller's `save` is read fresh on
    // every fire regardless, so it can never go stale here).
    if (!enabled) {
      publish(null, save, isSaving);
      return;
    }
    publish(form, save, isSaving);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.name, form.segmentId, form.templateId, form.fromSenderId, isSaving, enabled]);
}
