// One icon per built-in event type, shared by the events table and the event
// card so the two never drift apart.

import {
  BriefcaseRegular,
  HatGraduationRegular,
  HeartBrokenRegular,
  HeartRegular,
  HomeRegular,
  LeafThreeRegular,
  LinkDismissRegular,
  PersonRegular,
  QuestionCircleRegular,
  type FluentIcon,
} from "@fluentui/react-icons";
import type { EventType } from "../../api/types";

export const EVENT_TYPE_ICONS: Record<EventType, FluentIcon> = {
  BIRTH: PersonRegular,
  DEATH: HeartBrokenRegular,
  MARRIAGE: HeartRegular,
  DIVORCE: LinkDismissRegular,
  BURIAL: LeafThreeRegular,
  RESIDENCE: HomeRegular,
  OCCUPATION: BriefcaseRegular,
  EDUCATION: HatGraduationRegular,
  OTHER: QuestionCircleRegular,
};
