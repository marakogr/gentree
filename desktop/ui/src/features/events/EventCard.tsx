// Read-only event card shown next to the events table. Its read mode mirrors
// the timeline popover: a type kicker, a title, text actions and icon-labelled
// rows. The pencil opens the event form for editing.

import { useEffect, useMemo, useState } from "react";
import {
  BookOpenRegular,
  CalendarLtrRegular,
  DismissRegular,
  DocumentRegular,
  EditRegular,
  LocationRegular,
  PeopleRegular,
} from "@fluentui/react-icons";
import { convertFileSrc } from "@tauri-apps/api/core";
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
import { isImageMedia, mediaLabel } from "../media/helpers";
import { displayName } from "../persons/helpers";
import { resolveEventFields } from "./fields";
import { eventDateLabel, eventTypeLabel } from "./helpers";
import { useEventConfig } from "./useEventConfig";
import "./events.css";

export type EventCardProps = {
  event: Versioned<EventEntity>;
  persons: readonly Person[];
  onEdit: () => void;
  onClose: () => void;
};

export function EventCard({
  event,
  persons,
  onEdit,
  onClose,
}: EventCardProps) {
  const { t } = useTranslation(["event", "common", "enums", "person"]);
  const formatDate = useDateFormatter();
  const { fieldGroups } = useEventConfig();
  const [files, setFiles] = useState<MediaItem[]>([]);
  const entity = event.entity;
  const typeLabel = eventTypeLabel(entity.type, entity.originalType, t);
  const dateText = eventDateLabel(entity.date, formatDate);
  const details = useMemo(() => {
    const specs = resolveEventFields(
      entity.type,
      entity.originalType,
      fieldGroups,
      (key) => t(`event:fields.${key}`),
    );
    const rows = specs.map((spec) => ({
      key: spec.key,
      label: spec.label,
      value: (entity.details?.[spec.key] ?? "").trim() || EMPTY_VALUE,
    }));
    const known = new Set(specs.map((spec) => spec.key));
    for (const [key, raw] of Object.entries(entity.details ?? {})) {
      if (known.has(key)) continue;
      const value = raw.trim();
      if (value !== "") rows.push({ key, label: key, value });
    }
    return rows;
  }, [entity, fieldGroups, t]);
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

  const images = files.filter(isImageMedia);
  const documents = files.filter((item) => !isImageMedia(item));

  return (
    <aside className="events-card" aria-label={typeLabel}>
      <div className="events-card-head">
        <div className="events-card-titles">
          <span className="events-card-kicker">{typeLabel}</span>
          <h3 className="events-card-title">
            {owner ? personName(owner) : typeLabel}
          </h3>
        </div>
        <div className="events-card-actions">
          <IconButton label={t("common:actions.edit")} onClick={onEdit}>
            <EditRegular fontSize={16} aria-hidden="true" />
          </IconButton>
          <IconButton
            className="events-card-close"
            label={t("common:actions.close")}
            onClick={onClose}
          >
            <DismissRegular aria-hidden="true" />
          </IconButton>
        </div>
      </div>

      <dl className="events-card-list">
        <div className="events-card-row">
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

        <div className="events-card-row">
          <div>
            <dt>{t("event:precision")}</dt>
            <dd>{t(`enums:datePrecision.${entity.date.precision}`)}</dd>
          </div>
        </div>

        <div className="events-card-row">
          <LocationRegular
            className="events-card-icon"
            fontSize={16}
            aria-hidden="true"
          />
          <div>
            <dt>{t("event:place")}</dt>
            <dd className="events-card-break">
              {entity.place?.trim() || EMPTY_VALUE}
            </dd>
          </div>
        </div>

        <div className="events-card-row">
          <PeopleRegular
            className="events-card-icon"
            fontSize={16}
            aria-hidden="true"
          />
          <div>
            <dt>{t("event:participants")}</dt>
            <dd>
              {participants.length > 0
                ? participants.map(personName).join(", ")
                : EMPTY_VALUE}
            </dd>
          </div>
        </div>

        <div className="events-card-row">
          <div>
            <dt>{t("event:description")}</dt>
            <dd className="events-card-description">
              {entity.description?.trim() || EMPTY_VALUE}
            </dd>
          </div>
        </div>

        {details.map((entry) => (
          <div className="events-card-row" key={entry.key}>
            <div>
              <dt>{entry.label}</dt>
              <dd>{entry.value}</dd>
            </div>
          </div>
        ))}

        <div className="events-card-row events-card-separator">
          <BookOpenRegular
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
    </aside>
  );
}
