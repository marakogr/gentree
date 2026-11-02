// Live search without a "Find" button: the caller keeps the raw input value in
// sync with the field and applies the debounced copy to queries.

import { useEffect, useState } from "react";

/**
 * Returns `value` only after it stayed unchanged for `delay` ms. The initial
 * value is returned immediately, so a restored query does not flash empty.
 */
export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (delay <= 0) {
      setDebounced(value);
      return undefined;
    }
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
