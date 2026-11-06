// The «person» column of the events table. It shows the event owner only:
// participants belong to the event card, not to this cell. A missing owner
// renders the neutral empty value.

import { EMPTY_VALUE } from "../../lib/formatValue";

export type EventPersonCellProps = {
  /** Owner id, or `null` when the event has no owner. */
  ownerId: string | null;
  /** Display name resolved by the page for `ownerId`. */
  name: string;
  /** Opens the owner when the shell can navigate to a person. */
  onOpenPerson?: (personId: string) => void;
};

export function EventPersonCell({
  ownerId,
  name,
  onOpenPerson,
}: EventPersonCellProps) {
  if (ownerId === null) {
    return <span className="events-person-static">{EMPTY_VALUE}</span>;
  }
  if (!onOpenPerson) {
    return <span className="events-person-static">{name}</span>;
  }
  return (
    <span className="events-person-links">
      <button
        type="button"
        className="events-person-link"
        onClick={(event) => {
          event.stopPropagation();
          onOpenPerson(ownerId);
        }}
      >
        {name}
      </button>
    </span>
  );
}
