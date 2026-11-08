// Shared read-only body of an event: the field set and order used by the
// events-screen card and the timeline drawer. One component keeps them from
// drifting; a caller may add actions around it but never reorders the fields.

import { useEffect, useMemo, useState } from "react";
import {
  CalendarLtrRegular,
  DocumentRegular,
  LocationRegular,
  PeopleRegular,
} from "@fluentui/react-icons";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { mediaApi } from "../../api/client";
import type { EventEntity, MediaItem, Person } from "../../api/types";
import { EMPTY_VALUE } from "../../lib/formatValue";
import { useDateFormatter } from "../../lib/useDateFormatter";
import { isImageMedia, mediaLabel } from "../media/helpers";
import { displayName } from "../persons/helpers";
import { resolveEventFields } from "./fields";
import { eventDateLabel } from "./helpers";
import { useEventConfig } from "./useEventConfig";
import "./events.css";

export type EventReadBodyProps = {
  event: EventEntity;
  persons: readonly Person[];
  /**
   * Makes participant names buttons. The events card leaves it unset; the
   * timeline drawer uses it to open the person profile.
   */
  onOpenPerson?: (personId: string) => void;
};

/**
 * Owner (subject) display name, or the localized type when the person cannot
 * be resolved. Shared with the card and the drawer so the title cannot drift.
 */
export function eventOwnerLabel(
  event: EventEntity,
  persons: readonly Person[],
  fallback: string,
  unknownName: string,
): string {
  const owner = persons.find((person) => person.id === event.personId);
  return owner === undefined ? fallback : displayName(owner, unknownName);
}

/** Co-participants in stored order; the owner is never repeated. */
export function eventCoParticipants(
  event: EventEntity,
  persons: readonly Person[],
): Person[] {
  const byId = new Map(persons.map((person) => [person.id, person]));
  return (event.participantIds ?? [])
    .filter((id) => id !== event.personId)
    .map((id) => byId.get(id))
    .filter((person): person is Person => person !== undefined);
}

export function EventReadBody({
  event,
  persons,
  onOpenPerson,
}: EventReadBodyProps) {
  const { t } = useTranslation(["event", "common", "enums", "person"]);
  const formatDate = useDateFormatter();
  const { fieldGroups } = useEventConfig();
  const [files, setFiles] = useState<MediaItem[]>([]);

  const dateText = eventDateLabel(event.date, formatDate);
  const details = useMemo(() => {
    const specs = resolveEventFields(
      event.type,
      event.originalType,
      fieldGroups,
      (key) => t(`event:fields.${key}`),
    );
    const rows = specs.map((spec) => ({
      key: spec.key,
      label: spec.label,
      value: (event.details?.[spec.key] ?? "").trim() || EMPTY_VALUE,
    }));
    const known = new Set(specs.map((spec) => spec.key));
    for (const [key, raw] of Object.entries(event.details ?? {})) {
      if (known.has(key)) continue;
      const value = raw.trim();
      if (value !== "") rows.push({ key, label: key, value });
    }
    return rows;
  }, [event, fieldGroups, t]);

  const participants = useMemo(
    () => eventCoParticipants(event, persons),
    [event, persons],
  );
  const personName = (person: Person) =>
    displayName(person, t("person:unknownName"));

  useEffect(() => {
    let active = true;
    setFiles([]);
    void mediaApi
      .listForEvent(event.id)
      .then((items) => {
        if (active) setFiles(items);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [event.id]);

  const images = files.filter(isImageMedia);
  const documents = files.filter((item) => !isImageMedia(item));

  return (
    <dl className="events-card-list">
      <div className="events-card-row" data-field="date">
        <CalendarLtrRegular
          className="events-card-icon"
          fontSize={16}
          aria-hidden="true"
        />
        <div>
          <dt>{t("event:date")}</dt>
          <dd>{dateText}</dd>
        </div>
      </div>

      <div className="events-card-row" data-field="precision">
        <div>
          <dt>{t("event:precision")}</dt>
          <dd>{t(`enums:datePrecision.${event.date.precision}`)}</dd>
        </div>
      </div>

      <div className="events-card-row" data-field="place">
        <LocationRegular
          className="events-card-icon"
          fontSize={16}
          aria-hidden="true"
        />
        <div>
          <dt>{t("event:place")}</dt>
          <dd className="events-card-break">
            {event.place?.trim() || EMPTY_VALUE}
          </dd>
        </div>
      </div>

      <div className="events-card-row" data-field="participants">
        <PeopleRegular
          className="events-card-icon"
          fontSize={16}
          aria-hidden="true"
        />
        <div>
          <dt>{t("event:participants")}</dt>
          <dd>
            {participants.length === 0
              ? EMPTY_VALUE
              : participants.map((person, index) => (
                  <span key={person.id}>
                    {index > 0 ? ", " : null}
                    {onOpenPerson === undefined ? (
                      personName(person)
                    ) : (
                      <button
                        type="button"
                        className="events-person-link"
                        onClick={() => onOpenPerson(person.id)}
                      >
                        {personName(person)}
                      </button>
                    )}
                  </span>
                ))}
          </dd>
        </div>
      </div>

      <div className="events-card-row" data-field="description">
        <div>
          <dt>{t("event:description")}</dt>
          <dd className="events-card-description">
            {event.description?.trim() || EMPTY_VALUE}
          </dd>
        </div>
      </div>

      {details.map((entry) => (
        <div
          className="events-card-row"
          data-field={`detail:${entry.key}`}
          key={entry.key}
        >
          <div>
            <dt>{entry.label}</dt>
            <dd>{entry.value}</dd>
          </div>
        </div>
      ))}

      <div
        className="events-card-row events-card-separator"
        data-field="files"
      >
        <DocumentRegular
          className="events-card-icon"
          fontSize={16}
          aria-hidden="true"
        />
        <div>
          <dt>{t("event:filesTitle")}</dt>
          <dd>
            {files.length === 0 ? (
              EMPTY_VALUE
            ) : (
              <div className="person-media">
                {images.length > 0 ? (
                  <ul className="person-media-grid">
                    {images.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          className="events-card-thumb"
                          title={mediaLabel(item)}
                          aria-label={mediaLabel(item)}
                          onClick={() => {
                            void mediaApi.open(item.id).catch(() => undefined);
                          }}
                        >
                          <img
                            src={convertFileSrc(item.path)}
                            alt={mediaLabel(item)}
                            loading="lazy"
                          />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {documents.length > 0 ? (
                  <ul className="plain person-media-files">
                    {documents.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          className="person-media-file events-card-file"
                          onClick={() => {
                            void mediaApi.open(item.id).catch(() => undefined);
                          }}
                        >
                          <DocumentRegular aria-hidden="true" />
                          <span className="person-media-file-name">
                            {mediaLabel(item)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}
          </dd>
        </div>
      </div>
    </dl>
  );
}
