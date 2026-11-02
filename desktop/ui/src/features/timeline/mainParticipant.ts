import type { TimelineEvent, TimelineParticipant } from "./types";

const BIRTH_TYPES = new Set(["BIRT", "BIRTH", "BAPTISM"]);
const MARRIAGE_TYPES = new Set(["MARR", "MARRIAGE"]);
const DEATH_TYPES = new Set(["DEAT", "DEATH", "BURIAL"]);

function withRole(
  participants: TimelineParticipant[],
  role: string,
): TimelineParticipant[] {
  return participants.filter((participant) => participant.role === role);
}

/**
 * Participants a family-event card should name.
 *
 * The event type decides the "main" participant: a birth or baptism names the
 * child, a marriage names every spouse (in API order), a death or burial names
 * the deceased and any other type falls back to the first participant. Roles
 * are compared as stored by the API; an event without the expected role falls
 * back to the first participant, and an event without participants returns an
 * empty list - nothing is invented.
 */
export function mainParticipants(event: TimelineEvent): TimelineParticipant[] {
  const participants = event.participants;
  const first = participants[0];
  if (first === undefined) {
    return [];
  }

  if (BIRTH_TYPES.has(event.type)) {
    const children = withRole(participants, "CHILD");
    return children.length > 0 ? children : [first];
  }

  if (MARRIAGE_TYPES.has(event.type)) {
    const spouses = withRole(participants, "SPOUSE");
    return spouses.length > 0 ? spouses : [first];
  }

  if (DEATH_TYPES.has(event.type)) {
    const deceased = withRole(participants, "DECEASED");
    return deceased.length > 0 ? deceased : [first];
  }

  return [first];
}
