// Multi-select dropdown for small enum sets (event types and the like). The
// trigger shows the current state in one compact field; the popover keeps a
// checkbox list, and nothing selected means "all", which is why the first row
// clears the selection.
//
// Rebuilt on the shared `DropdownBase`; only the "all" row and the toggle
// semantics stay here.

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { comboListboxMaxHeightPx, type ComboItem } from "../ui/helpers";
import { DropdownBase, type DropdownItem } from "../patterns/dropdown-base";
import { toggleMultiSelect } from "./multiSelectRules";
import "./filters.css";

export type MultiSelectOption = ComboItem & {
  icon?: ReactNode;
};

export type MultiSelectDropdownProps = {
  options: MultiSelectOption[];
  /** Selected ids; an empty list means the "all" row is active. */
  values: string[];
  onChange: (values: string[]) => void;
  /** Accessible name of the trigger and the listbox. */
  label: string;
  /** Label of the row that clears the selection ("All types"). */
  allLabel: string;
  /** Trigger text when more than one option is selected. */
  multipleLabel: (count: number) => string;
  disabled?: boolean;
  id?: string;
};

export function MultiSelectDropdown({
  options,
  values,
  onChange,
  label,
  allLabel,
  multipleLabel,
  disabled = false,
  id,
}: MultiSelectDropdownProps) {
  const [open, setOpen] = useState(false);

  const selected = useMemo(
    () => options.filter((option) => values.includes(option.id)),
    [options, values],
  );

  const items: DropdownItem[] = useMemo(
    () => [
      {
        id: "",
        label: allLabel,
        checked: values.length === 0,
        all: true,
      },
      ...options.map((option) => ({
        id: option.id,
        label: option.label,
        icon: option.icon,
        hint: option.hint,
        checked: values.includes(option.id),
      })),
    ],
    [allLabel, options, values],
  );

  const triggerText =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? selected[0].label
        : multipleLabel(selected.length);

  return (
    <DropdownBase
      id={id}
      label={label}
      disabled={disabled}
      open={open}
      onOpenChange={setOpen}
      triggerText={triggerText}
      triggerTitle={
        selected.length > 0
          ? selected.map((option) => option.label).join(", ")
          : allLabel
      }
      triggerIcon={selected[0]?.icon}
      items={items}
      initialActive={() => 0}
      onSelect={(optionId) => onChange(toggleMultiSelect(values, optionId))}
      closeOnSelect={false}
      multiselectable
      surfaceMaxHeightPx={comboListboxMaxHeightPx()}
      surfaceGap
      listMode="multi"
    />
  );
}
