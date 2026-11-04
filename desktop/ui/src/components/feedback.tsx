import { useTranslation } from "react-i18next";
import type { AppErrorEnvelope } from "../api/types";

export function ErrorBanner({ error }: { error: AppErrorEnvelope | null }) {
  const { t } = useTranslation();
  if (!error) return null;
  return (
    <p className="error" role="alert">
      {t(`errors.${error.code}`, { defaultValue: t("errors.UNKNOWN") })}
    </p>
  );
}
