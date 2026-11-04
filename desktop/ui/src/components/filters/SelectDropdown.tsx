// Single-select dropdown for small enum sets. Rebuilt on the shared
// `DropdownBase` (trigger, popover, listbox, ARIA and keyboard); a click
// replaces the value and closes the popover.

import { useState } from "react";
import type { ReactNode } from "react";
import type { ComboItem } from "../ui/helpers";
import { DropdownBase, type DropdownItem } from "../patterns/dropdown-base";
import "./filters.css";

export type SelectOption = ComboItem & {
  icon?: ReactNode;
};

export type SelectDropdownProps = {
  options: SelectOption[];
  value: string;
  onChange: (id: string) => void;
  /** Accessible name of the trigger and the listbox. */
  label: string;
  /** Trigger text when the value matches no option. */
  placeholder?: string;
  disabled?: boolean;
  id?: string;
};

const SURFACE_MAX_HEIGHT_PX = 320;

export function SelectDropdown({
  options,
  value,
  onChange,
  label,
  placeholder,
  disabled = false,
  id,
}: SelectDropdownProps) {
  const [open, setOpen] = useState(false);

  const selected = options.find((option) => option.id === value);
  const selectedIndex = options.findIndex((option) => option.id === value);
  const items: DropdownItem[] = options.map((option) => ({
    id: option.id,
    label: option.label,
    icon: option.icon,
    hint: option.hint,
    checked: option.id === value,
  }));

  return (
    <DropdownBase
      id={id}
      label={label}
      disabled={disabled}
      open={open}
      onOpenChange={setOpen}
      triggerText={selected?.label ?? placeholder ?? label}
      triggerTitle={selected?.label ?? placeholder ?? label}
      triggerIcon={selected?.icon}
      items={items}
      initialActive={() => (selectedIndex >= 0 ? selectedIndex : 0)}
      onSelect={onChange}
      closeOnSelect
      surfaceMaxHeightPx={SURFACE_MAX_HEIGHT_PX}
      listMode="single"
    />
  );
}
