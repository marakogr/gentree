// Read-only event card shown next to the events table. It mirrors the person
// card's facts block, keeps editing one click away and opens the event form in
// a full window from the maximize action.

import { Fragment, useEffect, useMemo, useState } from "react";
import { Text } from "@fluentui/react-components";
import {
  ArrowMaximizeRegular,
  DismissRegular,
  EditRegular,
} from "@fluentui/react-icons";
import { useTranslation } from "react-i18next";
import { mediaApi } from "../../api/client";
import type {
  EventEntity,
  MediaItem,
  Person,
  Versioned,
} from "../../api/types";
import { IconButton } from "../../components/ui/icon-button";
import { EMPTY_VALUE } from "../../lib/formatValue";
import { useDateFormatter } from "../../lib/useDateFormatter";
import { mediaLabel } from "../media/helpers";
import { displayName } from "../persons/helpers";
import { eventDetailEntries } from "./fields";
import { eventDateLabel, eventTypeLabel } from "./helpers";
import { EVENT_TYPE_ICONS } from "./typeIcons";
import { useEventConfig } from "./useEventConfig";
import "./events.css";

export type EventCardProps = {
  event: Versioned<EventEntity>;
  persons: readonly Person[];
  onEdit: () => void;
  onExpand: () => void;
  onClose: () => void;
};

export function EventCard({
  event,
  persons,
  onEdit,
  onExpand,
  onClose,
}: EventCardProps) {
  const { t } = useTranslation(["event", "common", "enums", "person"]);
  const formatDate = useDateFormatter();
  const { fieldGroups } = useEventConfig();
  const [files, setFiles] = useState<MediaItem[]>([]);
  const entity = event.entity;
  const TypeIcon = EVENT_TYPE_ICONS[entity.type];
  const typeLabel = eventTypeLabel(entity.type, entity.originalType, t);
  const dateText = eventDateLabel(entity.date, formatDate);
  const details = useMemo(
    () =>
      eventDetailEntries(entity, fieldGroups, (key) =>
        t(`event:fields.${key}`),
      ),
    [entity, fieldGroups, t],
  );
  const personsById = useMemo(
    () => new Map(persons.map((person) => [person.id, person])),
    [persons],
  );
  const owner = personsById.get(entity.personId);
  const participants = (entity.participantIds ?? [])
    .map((id) => personsById.get(id))
    .filter((person): person is Person => person !== undefined);

  useEffect(() => {
    let active = true;
    setFiles([]);
    void mediaApi
      .listForEvent(entity.id)
      .then((items) => {
        if (active) setFiles(items);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [entity.id]);

  const personName = (person: Person) =>
    displayName(person, t("person:unknownName"));

  return (
    <aside className="events-card" aria-label={t("event:detailsTitle")}>
      <header className="events-card-head">
        <span className="events-card-title">
          <TypeIcon fontSize={18} aria-hidden="true" />
          {typeLabel}
        </span>
        <span className="events-card-actions">
          <IconButton label={t("event:editEvent")} onClick={onEdit}>
            <EditRegular />
          </IconButton>
          <IconButton label={t("event:openInWindow")} onClick={onExpand}>
            <ArrowMaximizeRegular />
          </IconButton>
          <IconButton label={t("common:actions.close")} onClick={onClose}>
            <DismissRegular />
          </IconButton>
        </span>
      </header>

      <Text size={200} className="events-card-date">
        {dateText}
      </Text>

      <dl className="facts events-card-facts">
        <dt>{t("event:person")}</dt>
        <dd>{owner ? personName(owner) : EMPTY_VALUE}</dd>

        {participants.length > 0 ? (
          <>
            <dt>{t("event:participants")}</dt>
            <dd>{participants.map(personName).join(", ")}</dd>
          </>
        ) : null}

        <dt>{t("event:place")}</dt>
        <dd>{entity.place?.trim() || EMPTY_VALUE}</dd>

        <dt>{t("event:description")}</dt>
        <dd>{entity.description?.trim() || EMPTY_VALUE}</dd>

        {details.map((entry) => (
          <Fragment key={entry.key}>
            <dt>{entry.label}</dt>
            <dd>{entry.value}</dd>
          </Fragment>
        ))}

        <dt>{t("event:filesTitle")}</dt>
        <dd>
          {files.length === 0 ? (
            EMPTY_VALUE
          ) : (
            <ul className="events-card-files">
              {files.map((item) => (
                <li key={item.id}>{mediaLabel(item)}</li>
              ))}
            </ul>
          )}
        </dd>
      </dl>
    </aside>
  );
}
