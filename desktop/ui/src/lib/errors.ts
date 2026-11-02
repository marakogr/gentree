// Error envelope helpers: the UI renders `errors.<code>` and never
// `error.message` (ADR-0014).

import type { AppErrorEnvelope } from "../api/types";

export type { AppErrorEnvelope } from "../api/types";

export type FieldErrors = Record<string, string>;

export function isAppError(value: unknown): value is AppErrorEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

/** Tauri rejects with the serialized `AppError`; anything else is UNKNOWN. */
export function normalizeError(value: unknown): AppErrorEnvelope {
  if (isAppError(value)) return value;
  return {
    code: "UNKNOWN",
    message: value instanceof Error ? value.message : String(value),
  };
}

export function errorKey(code: string): string {
  return `errors.${code}`;
}

/** `params.field` names the offending form field, so the error stays local. */
export function fieldErrors(error: AppErrorEnvelope): FieldErrors {
  const field = error.params?.field?.trim();
  if (!field) return {};
  return { [field]: error.code };
}

/** First error code among `fields` (e.g. "given" or Rust's "name"). */
export function pickFieldError(
  errors: FieldErrors,
  ...fields: string[]
): string | null {
  for (const field of fields) {
    const code = errors[field];
    if (code) return code;
  }
  return null;
}
