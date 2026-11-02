// Read model shared by the line view. Mirrors the shape `line.ts` was ported
// from on the web; the adapter fills it from the desktop event rows.

import type { DatePrecision, DateQualifier, Gender } from "../../api/types";

export type ApiDate = {
  start: string | null;
  end: string | null;
  precision: DatePrecision;
  qualifier: DateQualifier;
  original: string | null;
};

export type TimelineParticipant = {
  personId: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
  /** Optional; the adapter fills it from the backend or the persons list. */
  gender?: Gender;
};

export type TimelineEvent = {
  id: string;
  type: string;
  title: string | null;
  description: string | null;
  place: string | null;
  date: ApiDate | null;
  participants: TimelineParticipant[];
  mediaIds: string[];
  /** Desktop-only: citations attached to the event (safe to ignore in line). */
  sourceIds?: string[];
};

export type TimelinePerson = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  maidenName: string | null;
  gender: Gender;
  birthDate: ApiDate | null;
  deathDate: ApiDate | null;
  deceased: boolean;
  mediaIds: string[];
};
