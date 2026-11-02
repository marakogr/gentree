// Gender presentation for birth markers. Pure mapping: the component turns the
// icon key into a lucide component and uses the class strings as-is.

import type { Gender } from "../../api/types";

export type GenderMarkerIcon = "mars" | "venus" | "neutral";
export type GenderMarkerTone = "male" | "female" | "unknown";

export type GenderMarkerMeta = {
  icon: GenderMarkerIcon;
  tone: GenderMarkerTone;
  /** Filled marker background. */
  swatch: string;
  ring: string;
  /** Soft interval band behind month/year birth events. */
  interval: string;
  /** Type label in the hover card. */
  text: string;
};

const MALE: GenderMarkerMeta = {
  icon: "mars",
  tone: "male",
  swatch: "bg-sky-600 text-white dark:bg-sky-400 dark:text-sky-950",
  ring: "ring-sky-500/40",
  interval: "bg-sky-500/20 dark:bg-sky-400/20",
  text: "text-sky-700 dark:text-sky-300",
};

const FEMALE: GenderMarkerMeta = {
  icon: "venus",
  tone: "female",
  swatch: "bg-pink-600 text-white dark:bg-pink-400 dark:text-pink-950",
  ring: "ring-pink-500/40",
  interval: "bg-pink-500/20 dark:bg-pink-400/20",
  text: "text-pink-700 dark:text-pink-300",
};

const UNKNOWN: GenderMarkerMeta = {
  icon: "neutral",
  tone: "unknown",
  swatch: "bg-slate-600 text-white dark:bg-slate-400 dark:text-slate-950",
  ring: "ring-slate-500/40",
  interval: "bg-slate-500/20 dark:bg-slate-300/20",
  text: "text-slate-700 dark:text-slate-300",
};

/** Male -> Mars/blue, female -> Venus/pink, everything else -> neutral. */
export function genderMarker(
  gender: Gender | null | undefined,
): GenderMarkerMeta {
  if (gender === "MALE") return MALE;
  if (gender === "FEMALE") return FEMALE;
  return UNKNOWN;
}

/** `timeline:gender.<key>` for the marker's accessible name. */
export function genderLabelKey(gender: Gender | null | undefined): string {
  if (gender === "MALE") return "gender.male";
  if (gender === "FEMALE") return "gender.female";
  return "gender.unknown";
}
