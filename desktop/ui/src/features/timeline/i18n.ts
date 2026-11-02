import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { Translate } from "../../lib/dates";

/** `t` bound to the `timeline` namespace, shaped for pure helper modules. */
export function useTimelineTranslate(): Translate {
  const { t } = useTranslation("timeline");
  return useCallback(
    (key, options) => String(t(key, options ?? {})),
    [t],
  );
}
