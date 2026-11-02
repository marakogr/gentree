import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { DateValue } from "../api/types";
import { formatDateValue } from "./dates";

/** Locale-aware DateValue formatter bound to the `common` namespace keys. */
export function useDateFormatter(): (value: DateValue) => string {
  const { t, i18n } = useTranslation();
  return useCallback(
    (value: DateValue) =>
      formatDateValue(value, i18n.language, (key, options) =>
        String(t(key, { ns: "common", ...(options ?? {}) })),
      ),
    [t, i18n.language],
  );
}
