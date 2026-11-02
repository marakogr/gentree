// Pure helpers for the import dialog: the file-type label, drop/pick display
// names, report counts and the preview gate. No DOM, no IPC.

import type { ImportReport } from "../../api/types";

/** Readers the import offers; the type is detected, not chosen by the user. */
export type ImportMode = "at5" | "gedcom";

/** Extensions shown by the native file picker; content decides the reader. */
export const IMPORT_EXTENSIONS = ["at5", "ged", "gedcom"] as const;

/** Last path segment for both Windows and Unix separators. */
export function importFileLabel(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "") return "";
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? trimmed;
}

/** Namespaced i18n key for the detected format badge. */
export function modeLabelKey(mode: ImportMode): string {
  return mode === "at5" ? "import:modeAt5" : "import:modeGedcom";
}

export type ReportCountKey =
  | "persons"
  | "relationships"
  | "events"
  | "media";

export type ReportCount = { key: ReportCountKey; count: number };

/** Fixed display order of the four record counters. */
const COUNT_ORDER: ReportCountKey[] = [
  "persons",
  "relationships",
  "events",
  "media",
];

export function reportCounts(report: ImportReport): ReportCount[] {
  return COUNT_ORDER.map((key) => ({ key, count: report[key] }));
}

/**
 * The import button stays disabled until a successful preview produced a
 * report; `null` means the file has not been checked yet.
 */
export function canImport(report: ImportReport | null): report is ImportReport {
  return report !== null;
}

export type ReportNotes = { warnings: number; issues: number };

/** Warning/issue totals for the compact preview summary. */
export function reportNotes(report: ImportReport): ReportNotes {
  return {
    warnings: report.warnings.length,
    issues: report.issues.length,
  };
}
