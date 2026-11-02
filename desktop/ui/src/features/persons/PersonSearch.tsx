// Rich person search: a combobox that opens right under the field, with a round
// initials avatar, the full name and a "life years · gender" line. Filtering,
// keyboard navigation, the clear button and outside-click closing all live in
// the shared `Combobox`; this file only shapes the option row.

import { useMemo } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { MediaItem, Person } from "../../api/types";
import { Combobox, type ComboItem } from "../../components/ui/combobox";
import { Field } from "../../components/ui/field";
import { initialsFromName } from "../media/helpers";
import { genderMarker } from "../timeline/gender";
import { displayName, lifeYears, sortPersons } from "./helpers";
import "./persons-search.css";

type Props = {
  id: string;
  label: string;
  persons: Person[];
  /** Primary photo per person id; initials are the fallback. */
  photos?: ReadonlyMap<string, MediaItem>;
  /** Selected person id or `""` for "no root chosen". */
  value: string;
  onChange: (personId: string) => void;
  placeholder: string;
  disabled?: boolean;
  /**
   * Optional first row that clears the selection ("All people"). Filter strips
   * where an empty value already means "everyone" use it instead of leaving the
   * field blank.
   */
  allOptionLabel?: string;
  /** Overrides the clear-button title (`common:filters.clearSearch`). */
  clearLabel?: string;
  /** Overrides the "nothing found" row (`person:noMatches`). */
  emptyLabel?: string;
  /**
   * Render only the combobox, without the visible `Field` label. The
   * accessible name still comes from `aria-label`, so compact filter strips
   * can drop the caption line without losing the label semantics.
   */
  hideLabel?: boolean;
};

export default function PersonSearch({
  id,
  label,
  persons,
  photos,
  value,
  onChange,
  placeholder,
  disabled = false,
  allOptionLabel,
  clearLabel,
  emptyLabel,
  hideLabel = false,
}: Props) {
  const { t } = useTranslation(["person", "enums", "common"]);
  const unknownName = t("person:unknownName");

  // Newest first by default, matching the persons list and every picker.
  const ordered = useMemo(
    () => sortPersons(persons, "birth", "desc"),
    [persons],
  );

  const personsById = useMemo(
    () => new Map(ordered.map((person) => [person.id, person])),
    [ordered],
  );

  // `hint` carries the second line and doubles as searchable text, so typing a
  // year or a gender label narrows the list as well.
  const items = useMemo<ComboItem[]>(() => {
    const people: ComboItem[] = ordered.map((person) => ({
      id: person.id,
      label: displayName(person, unknownName),
      hint: `${lifeYears(person)} \u00b7 ${t(
        `enums:gender.${person.gender}`,
      )}`,
    }));
    return allOptionLabel
      ? [{ id: "", label: allOptionLabel }, ...people]
      : people;
  }, [allOptionLabel, ordered, unknownName, t]);

  const renderOption = (item: ComboItem): ReactNode => {
    const person = personsById.get(item.id);
    if (!person) {
      return <span className="combo-option-label">{item.label}</span>;
    }
    // `genderMarker` provides the existing male/female/neutral Tailwind classes,
    // so no colour literal is duplicated here.
    const photo = photos?.get(person.id);
    return (
      <>
        <span
          className={`person-search-avatar ${genderMarker(person.gender).swatch}`}
          aria-hidden="true"
        >
          <span className="person-search-initials">
            {initialsFromName(item.label)}
          </span>
          {photo ? (
            <img
              src={convertFileSrc(photo.path)}
              alt=""
              loading="lazy"
              draggable={false}
              onError={(event) => {
                event.currentTarget.style.visibility = "hidden";
              }}
            />
          ) : null}
        </span>
        <span className="person-search-body">
          <span className="person-search-name">{item.label}</span>
          {item.hint ? (
            <span className="person-search-meta">{item.hint}</span>
          ) : null}
        </span>
      </>
    );
  };

  const combobox = (
    <Combobox
      id={id}
      items={items}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      ariaLabel={label}
      clearLabel={clearLabel ?? t("common:filters.clearSearch")}
      emptyLabel={emptyLabel ?? t("person:noMatches")}
      renderOption={renderOption}
      disabled={disabled}
    />
  );

  if (hideLabel) {
    return combobox;
  }

  return (
    <Field label={label} htmlFor={id}>
      {combobox}
    </Field>
  );
}
