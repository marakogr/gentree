// Project-name rules shared by create and inline rename. The backend owns the
// final verdict (`VALIDATION_ERROR` on the `name` field with `params.rule`);
// these helpers only avoid a round trip and map the error to an i18n key.

import type { AppErrorEnvelope } from "../../api/types";

/** Mirrors `PROJECT_NAME_MAX_LEN` in `crates/core/src/project.rs`. */
export const PROJECT_NAME_MAX_LENGTH = 200;

export type ProjectNameCheck =
  | { ok: true; name: string }
  | { ok: false; errorKey: string };

/** Trims the draft and rejects blank/over-long names before the IPC call. */
export function checkProjectName(raw: string): ProjectNameCheck {
  const name = raw.trim();
  if (name === "") {
    return { ok: false, errorKey: "project:nameRequired" };
  }
  // Rust counts characters, not UTF-16 units.
  if ([...name].length > PROJECT_NAME_MAX_LENGTH) {
    return { ok: false, errorKey: "project:nameTooLong" };
  }
  return { ok: true, name };
}

/**
 * i18n key for a failed rename/create. Validation failures carry
 * `params.rule` (`required` / `maxLength` / `duplicate`); anything else falls
 * back to the shared `common:errors.<CODE>` dictionary.
 */
export function renameErrorKey(error: AppErrorEnvelope): string {
  if (error.code === "VALIDATION_ERROR") {
    switch (error.params?.rule) {
      case "required":
        return "project:nameRequired";
      case "maxLength":
        return "project:nameTooLong";
      case "duplicate":
        return "project:nameDuplicate";
      default:
        return "project:nameInvalid";
    }
  }
  if (error.code === "PROJECT_LOCKED") {
    return "project:nameReadOnly";
  }
  return `common:errors.${error.code}`;
}
