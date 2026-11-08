// Read-only event card shown next to the events table. Its read mode mirrors
// the timeline popover through the shared `EventReadBody`: a type kicker, a
// title, text actions and icon-labelled rows. The pencil opens the event form
// for editing.

import { DismissRegular, EditRegular } from "@fluentui/react-icons";
import { useTranslation } from "react-i18next";
import type { EventEntity, Person, Versioned } from "../../api/types";
import { IconButton } from "../../components/ui/icon-button";
import { EventReadBody, eventOwnerLabel } from "./EventReadBody";
import { eventTypeLabel } from "./helpers";
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
  const entity = event.entity;
  const typeLabel = eventTypeLabel(entity.type, entity.originalType, t);
  const title = eventOwnerLabel(
    entity,
    persons,
    typeLabel,
    t("person:unknownName"),
  );

  return (
    <aside className="events-card" aria-label={typeLabel}>
      <div className="events-card-head">
        <div className="events-card-titles">
          <span className="events-card-kicker">{typeLabel}</span>
          <h3 className="events-card-title">{title}</h3>
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

      <EventReadBody event={entity} persons={persons} />
    </aside>
  );
}
