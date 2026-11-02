// File-name helpers for the project export dialog. The backend repeats the
// checks and owns the final archive layout; these only seed the save dialog and
// keep the two sides from disagreeing about an obviously bad name.

/** Trimmed project name reduced to characters a ZIP name can carry. */
export function safeExportStem(name: string): string {
  const stem = [...name.trim()]
    .map((character) => (/[\p{L}\p{N}_-]/u.test(character) ? character : "_"))
    .join("")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return stem === "" ? "gentree" : stem;
}

/** Suggested name for the archive itself. */
export function exportFileName(name: string): string {
  return `${safeExportStem(name)}.zip`;
}
