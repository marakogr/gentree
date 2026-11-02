// Person filter built on the shared Combobox: the user types a few letters and
// picks a suggestion instead of scrolling a 350-row select.

import { Combobox } from "../ui/combobox";
import type { Person } from "../../api/types";
import { displayName, sortPersons } from "../../features/persons/helpers";

export function PersonFilter({
  persons,
  value,
  onChange,
  placeholder,
  ariaLabel,
  clearLabel,
  emptyLabel,
  noneLabel,
}: {
  persons: Person[];
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
  ariaLabel: string;
  clearLabel: string;
  emptyLabel: string;
  noneLabel: string;
}) {
  const items = [
    { id: "", label: noneLabel },
    ...sortPersons(persons, "birth", "desc").map((person) => ({
      id: person.id,
      label: displayName(person, person.id),
      hint: [person.birth.start?.slice(0, 4), person.death.start?.slice(0, 4)]
        .filter(Boolean)
        .join("–"),
    })),
  ];

  return (
    <Combobox
      items={items}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      ariaLabel={ariaLabel}
      clearLabel={clearLabel}
      emptyLabel={emptyLabel}
    />
  );
}
