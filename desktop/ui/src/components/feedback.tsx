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

export function FieldError({ code }: { code: string | null }) {
  const { t } = useTranslation();
  if (!code) return null;
  return (
    <p className="field-error" role="alert">
      {t(`errors.${code}`, { defaultValue: t("errors.UNKNOWN") })}
    </p>
  );
}

export function EmptyState({ text }: { text: string }) {
  return <p className="meta">{text}</p>;
}
