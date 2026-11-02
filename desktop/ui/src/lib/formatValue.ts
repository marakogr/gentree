// One placeholder for every empty value in the UI: em dash, never "-" or a
// localised sentence like "unknown date".

export const EMPTY_VALUE = "\u2014";

/** Returns the em dash for null/blank values, the trimmed value otherwise. */
export function dash(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? EMPTY_VALUE : trimmed;
}

/** "1935 – …" style lifespan; both sides fall back to the em dash. */
export function lifespan(
  birthYear: string | null | undefined,
  deathYear: string | null | undefined,
  dashValue: string = EMPTY_VALUE,
): string {
  const birth = birthYear?.trim() ?? "";
  const death = deathYear?.trim() ?? "";
  if (birth === "" && death === "") return dashValue;
  return `${birth === "" ? dashValue : birth} \u2013 ${death === "" ? dashValue : death}`;
}
