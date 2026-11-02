// Localized labels for the line view. Every user-visible string lives in the
// `timeline` namespace; unknown event/role codes are shown verbatim.

import type { Translate } from "../../lib/dates";
import type { TimelineParticipant } from "./types";

const EVENT_TYPE_KEYS: Record<string, string> = {
  BIRTH: "BIRTH",
  BIRT: "BIRTH",
  DEATH: "DEATH",
  DEAT: "DEATH",
  MARRIAGE: "MARRIAGE",
  MARR: "MARRIAGE",
  DIVORCE: "DIVORCE",
  DIV: "DIVORCE",
  BURIAL: "BURIAL",
  BURI: "BURIAL",
  CREM: "CREMATION",
  ENGA: "ENGAGEMENT",
  BAPTISM: "BAPTISM",
  BAPM: "BAPTISM",
  CHR: "BAPTISM",
  ADOP: "ADOPTION",
  RESIDENCE: "RESIDENCE",
  RESI: "RESIDENCE",
  MOVED: "MOVED",
  EMIGRATION: "EMIGRATION",
  OCCUPATION: "OCCUPATION",
  OCCU: "OCCUPATION",
  EDUCATION: "EDUCATION",
  GRAD: "GRADUATION",
  MILITARY: "MILITARY",
  RETI: "RETIREMENT",
  WILL: "WILL",
  PROB: "PROBATE",
  OTHER: "OTHER",
  EVEN: "OTHER",
};

const PARTICIPANT_ROLE_KEYS: Record<string, string> = {
  SUBJECT: "SUBJECT",
  SPOUSE: "SPOUSE",
  PARTNER: "PARTNER",
  FATHER: "FATHER",
  MOTHER: "MOTHER",
  PARENT: "PARENT",
  CHILD: "CHILD",
  SON: "SON",
  DAUGHTER: "DAUGHTER",
  SIBLING: "SIBLING",
  WITNESS: "WITNESS",
  OFFICIANT: "OFFICIANT",
  GODPARENT: "GODPARENT",
  DECEASED: "DECEASED",
  OTHER: "OTHER",
};

/** Event type code -> localized label; unknown codes are shown verbatim. */
export function eventTypeLabel(type: string, t: Translate): string {
  const key = EVENT_TYPE_KEYS[type];
  return key === undefined ? type : t(`eventType.${key}`);
}

/** Participant role code -> localized label; unknown codes stay verbatim. */
export function participantRoleLabel(role: string, t: Translate): string {
  const key = PARTICIPANT_ROLE_KEYS[role];
  return key === undefined ? role : t(`participantRole.${key}`);
}

/** First name + last name as stored in the line participant. */
export function participantName(
  participant: TimelineParticipant,
  t: Translate,
): string {
  const parts = [participant.firstName, participant.lastName].filter(
    (part): part is string => part !== null && part.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(" ") : t("unnamedPerson");
}

/** Citation count wording; no content is implied to be loaded. */
export function sourceCountLabel(count: number, t: Translate): string {
  return count === 0 ? t("sources.none") : t("sources.count", { count });
}
