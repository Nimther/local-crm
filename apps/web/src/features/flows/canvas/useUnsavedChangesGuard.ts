import { useEffect } from "react";
import { useBlocker, type Blocker } from "react-router";

/**
 * OPS-19/D-13: guards both directions a marketer can lose unsaved canvas
 * work -- in-app navigation (React Router's data-router `useBlocker`, the
 * hard prerequisite migrated by plan 15-03/RESEARCH.md Pitfall 1) and tab
 * close/reload (the browser's native `beforeunload` prompt).
 *
 * The blocker predicate only fires when `hasUnsavedChanges` is true AND the
 * target pathname differs from the current one -- an in-place search-param
 * update (e.g. selecting a node, switching a query param) on the SAME route
 * must never open the dialog.
 *
 * The `beforeunload` listener is registered only while there are unsaved
 * changes and is removed the instant that flips false (or on unmount) --
 * per RESEARCH.md Pattern 2/D-13, a listener that outlives the dirty state
 * would turn every subsequent tab close into a spurious prompt.
 */
export function useUnsavedChangesGuard(hasUnsavedChanges: boolean): Blocker {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => hasUnsavedChanges && currentLocation.pathname !== nextLocation.pathname
  );

  useEffect(() => {
    if (!hasUnsavedChanges) return;

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      // Chrome requires returnValue to be set for the native prompt to appear.
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges]);

  return blocker;
}

export default useUnsavedChangesGuard;
