import { useEffect, useState } from "react";

/**
 * Simple trailing debounce -- no debounce utility exists in the codebase yet,
 * keep local to this feature (same convention as ContactsListPage's own copy,
 * 300ms per 03-RESEARCH.md Assumption A1).
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

export default useDebouncedValue;
