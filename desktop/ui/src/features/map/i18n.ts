import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { Translate } from "../../lib/dates";

/** Map screen strings; `event:count` resolves from the event namespace. */
export function useMapTranslate(): Translate {
  const { t } = useTranslation(["map", "event"]);
  return useCallback(
    (key, options) => String(t(key, options ?? {})),
    [t],
  );
}
