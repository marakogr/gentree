// One async-action wrapper for screens that show a busy flag and a localized
// error banner: `run` clears the previous error, normalizes the rejection and
// always releases `busy`.

import { useCallback, useState } from "react";
import { normalizeError, type AppErrorEnvelope } from "./errors";

export type AsyncAction = {
  busy: boolean;
  error: AppErrorEnvelope | null;
  setError: (error: AppErrorEnvelope | null) => void;
  run: (action: () => Promise<void>) => Promise<void>;
};

export function useAsyncAction(): AsyncAction {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppErrorEnvelope | null>(null);

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(normalizeError(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, error, setError, run };
}
