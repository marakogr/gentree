import { makeStyles, tokens } from "@fluentui/react-components";
import {
  ArrowSyncRegular,
  BookOpenRegular,
  CalendarLtrRegular,
  DismissRegular,
  EditRegular,
  LocationRegular,
  PeopleRegular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { eventsApi, personsApi } from "../../api/client";
import type { EventEntity, Person, Versioned } from "../../api/types";
import { ErrorBanner } from "../../components/feedback";
import type { Translate } from "../../lib/dates";
import { normalizeError, type AppErrorEnvelope } from "../../lib/errors";
import { cn } from "../../lib/utils";
import EventForm from "../events/EventForm";
import { formatTimelineDate } from "./dates";
import {
  eventTypeLabel,
  participantName,
  participantRoleLabel,
  sourceCountLabel,
} from "./format";
import { useTimelineTranslate } from "./i18n";
import type { TimelineEvent } from "./types";

// Fluent tokens only: the popover keeps its responsive-sheet layout, the theme
// decides the surface, text and accent colours.
const useStyles = makeStyles({
  surface: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow16,
    // The responsive sheet loses its elevation once it docks beside the line.
    "@media (min-width: 768px)": {
      boxShadow: "none",
    },
  },
  kicker: {
    color: tokens.colorBrandForegroundInverted,
  },
  muted: {
    color: tokens.colorNeutralForeground2,
  },
  quietButton: {
    color: tokens.colorNeutralForeground1,
    backgroundColor: "transparent",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    ":hover": {
      backgroundColor: tokens.colorSubtleBackgroundHover,
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "2px",
    },
  },
  iconButton: {
    color: tokens.colorNeutralForeground2,
    backgroundColor: "transparent",
    ":hover": {
      backgroundColor: tokens.colorSubtleBackgroundHover,
      color: tokens.colorNeutralForeground1,
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "2px",
    },
  },
  saved: {
    color: tokens.colorStatusSuccessForeground1,
    backgroundColor: tokens.colorStatusSuccessBackground1,
    border: `1px solid ${tokens.colorStatusSuccessBorder1}`,
  },
  separator: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  link: {
    color: tokens.colorNeutralForeground1,
    ":hover": {
      color: tokens.colorBrandForegroundInverted,
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "2px",
    },
  },
});

interface EventPopoverProps {
  event: TimelineEvent;
  personId: string;
  onClose: () => void;
  onOpenPerson: (personId: string) => void;
  /** Optional: open the same event in the Events tab. */
  onOpenEvent?: (eventId: string) => void;
  /** Called after a successful inline edit so the line can refresh. */
  onSaved?: () => void;
}

/**
 * Event details with inline editing.
 *
 * The line read model has no event version, so "Edit" loads the stored event
 * (`event_list` for the owning person) and hands it to `EventForm`. A failed
 * load keeps the popover in read mode and shows the error; a failed save keeps
 * the form draft.
 */
export function EventPopover({
  event,
  personId,
  onClose,
  onOpenPerson,
  onOpenEvent,
  onSaved,
}: EventPopoverProps) {
  const t = useTimelineTranslate();
  const styles = useStyles();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [fullEvent, setFullEvent] = useState<Versioned<EventEntity> | null>(null);
  const [persons, setPersons] = useState<Versioned<Person>[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<AppErrorEnvelope | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  useEffect(() => {
    setEditing(false);
    setFullEvent(null);
    setLoadError(null);
    setSavedMessage(null);
  }, [event.id]);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [event.id]);

  useEffect(() => {
    const handleKeyDown = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key !== "Escape") {
        return;
      }
      if (editing) {
        setEditing(false);
        setFullEvent(null);
        setLoadError(null);
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [editing, onClose]);

  const beginEditing = useCallback(() => {
    setSavedMessage(null);
    setEditing(true);
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const [rows, page] = await Promise.all([
          eventsApi.list({ personId }),
          personsApi.list({ limit: 1000, sort: "name" }),
        ]);
        const found = rows.find((row) => row.entity.id === event.id) ?? null;
        if (found === null) {
          setLoadError({ code: "NOT_FOUND" });
        } else {
          setFullEvent(found);
          setPersons(page.items);
        }
      } catch (caught: unknown) {
        setLoadError(normalizeError(caught));
      } finally {
        setLoading(false);
      }
    })();
  }, [event.id, personId]);

  const title = event.title?.trim() || eventTypeLabel(event.type, t);
  const sourceCount = event.sourceIds?.length ?? event.mediaIds.length;

  return (
    <section
      className={cn(
        styles.surface,
        "fixed inset-x-4 bottom-4 z-50 max-h-[70vh] overflow-y-auto rounded-lg p-4 md:static md:inset-auto md:z-auto md:max-h-none md:overflow-visible",
      )}
      aria-labelledby="event-popover-heading"
      role="dialog"
      aria-modal="false"
      data-testid="event-popover"
      data-layout="responsive-sheet"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span
            className={cn(
              styles.kicker,
              "text-[11px] font-medium uppercase tracking-wide",
            )}
          >
            {eventTypeLabel(event.type, t)}
          </span>
          <h3
            id="event-popover-heading"
            ref={headingRef}
            tabIndex={-1}
            className="mt-1 break-words text-[17px] font-semibold leading-snug focus:outline-none"
          >
            {title}
          </h3>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          {!editing && onOpenEvent !== undefined && (
            <button
              type="button"
              data-testid="event-open-in-events"
              className={cn(
                styles.quietButton,
                "inline-flex h-8 items-center gap-1 rounded-md px-2 py-0 text-[12px]",
              )}
              onClick={() => onOpenEvent(event.id)}
            >
              <CalendarLtrRegular fontSize={12} aria-hidden="true" />
              {t("popover.openInEvents")}
            </button>
          )}
          {!editing && (
            <button
              type="button"
              className={cn(
                styles.quietButton,
                "inline-flex h-8 items-center gap-1 rounded-md px-2 py-0 text-[12px]",
              )}
              onClick={beginEditing}
            >
              <EditRegular fontSize={12} aria-hidden="true" />
              {t("popover.edit")}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={t("popover.close")}
            className={cn(
              styles.iconButton,
              "inline-flex size-7 shrink-0 items-center justify-center rounded-md p-0",
            )}
          >
            <DismissRegular fontSize={16} aria-hidden="true" />
          </button>
        </div>
      </div>

      <p
        aria-live="polite"
        data-testid="event-save-status"
        className={
          savedMessage === null
            ? "sr-only"
            : cn(
                styles.saved,
                "mt-2 rounded-md px-2 py-1 text-xs",
              )
        }
      >
        {savedMessage ?? ""}
      </p>

      {editing ? (
        <div className={cn(styles.separator, "mt-3 pt-3")}>
          {loading && (
            <p
              role="status"
              className={cn(
                styles.muted,
                "flex items-center gap-2 text-sm",
              )}
            >
              <ArrowSyncRegular
                fontSize={16}
                className="animate-spin"
                aria-hidden="true"
              />
              {t("popover.loading")}
            </p>
          )}
          <ErrorBanner error={loadError} />
          {!loading && loadError !== null && (
            <button
              type="button"
              className={cn(
                styles.quietButton,
                "mt-2 inline-flex h-7 items-center gap-1 rounded-md px-2 py-0 text-[11px]",
              )}
              onClick={beginEditing}
            >
              {t("popover.retry")}
            </button>
          )}
          {fullEvent !== null && (
            <EventForm
              initial={fullEvent.entity}
              version={fullEvent.version}
              persons={persons}
              defaultPersonId={personId}
              onSaved={() => {
                setFullEvent(null);
                setEditing(false);
                setSavedMessage(t("popover.saved"));
                onSaved?.();
              }}
              onCancel={() => {
                setFullEvent(null);
                setEditing(false);
              }}
              onReload={() => {
                setEditing(false);
                setFullEvent(null);
                onSaved?.();
              }}
            />
          )}
        </div>
      ) : (
        <dl className="mt-3 space-y-2.5 text-sm">
          <div className="flex gap-2">
            <CalendarLtrRegular
              fontSize={16}
              className={cn(styles.muted, "mt-0.5 shrink-0")}
              aria-hidden="true"
            />
            <div>
              <dt className={styles.muted}>{t("popover.date")}</dt>
              <dd>{formatTimelineDate(event.date, t)}</dd>
            </div>
          </div>

          {event.place !== null && event.place.trim().length > 0 && (
            <div className="flex gap-2">
              <LocationRegular
                fontSize={16}
                className={cn(styles.muted, "mt-0.5 shrink-0")}
                aria-hidden="true"
              />
              <div>
                <dt className={styles.muted}>{t("popover.place")}</dt>
                <dd className="break-words">{event.place}</dd>
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <PeopleRegular
              fontSize={16}
              className={cn(styles.muted, "mt-0.5 shrink-0")}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <dt className={styles.muted}>
                {t("popover.participants")}
              </dt>
              <dd>
                <ParticipantList
                  event={event}
                  t={t}
                  onOpenPerson={onOpenPerson}
                />
              </dd>
            </div>
          </div>

          {event.description !== null && event.description.trim().length > 0 && (
            <div>
              <dt className={styles.muted}>
                {t("popover.description")}
              </dt>
              <dd className="mt-0.5 whitespace-pre-wrap break-words leading-relaxed">
                {event.description}
              </dd>
            </div>
          )}
        </dl>
      )}

      <div
        className={cn(
          styles.separator,
          "mt-3 flex items-start gap-2 pt-3 text-[13px]",
        )}
      >
        <BookOpenRegular
          fontSize={16}
          className={cn(styles.muted, "mt-0.5 shrink-0")}
          aria-hidden="true"
        />
        <div>
          <p>{sourceCountLabel(sourceCount, t)}</p>
          <p className={cn(styles.muted, "mt-1 text-[12px] leading-relaxed")}>
            {sourceCount > 0 ? t("popover.sourcesHint") : t("popover.noSources")}
          </p>
        </div>
      </div>
    </section>
  );
}

function ParticipantList({
  event,
  t,
  onOpenPerson,
}: {
  event: TimelineEvent;
  t: Translate;
  onOpenPerson: (personId: string) => void;
}) {
  const styles = useStyles();
  if (event.participants.length === 0) {
    return <p>{t("popover.noParticipants")}</p>;
  }
  return (
    <ul className="space-y-1">
      {event.participants.map((participant) => (
        <li
          key={`${participant.personId}:${participant.role}`}
          className="flex flex-wrap items-baseline gap-x-1.5"
        >
          <button
            type="button"
            onClick={() => onOpenPerson(participant.personId)}
            className={cn(
              styles.link,
              "p-0 break-words text-left underline-offset-2 hover:underline",
            )}
          >
            {participantName(participant, t)}
          </button>
          <span className={cn(styles.muted, "text-[11px]")}>
            {participantRoleLabel(participant.role, t)}
          </span>
        </li>
      ))}
    </ul>
  );
}
