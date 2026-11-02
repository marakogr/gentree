// Multi-select chips for event types (and any other small enum set).

import type { ReactNode } from "react";
import { Chip } from "../ui/chip";

export type TypeChipOption = { id: string; label: string; icon?: ReactNode };

export function TypeChips({
  options,
  selected,
  onToggle,
  legend,
}: {
  options: TypeChipOption[];
  selected: string[];
  onToggle: (id: string) => void;
  legend: string;
}) {
  return (
    <fieldset className="filter-fieldset">
      <legend>{legend}</legend>
      <div className="filter-chip-options">
        {options.map((option) => (
          <Chip
            key={option.id}
            selected={selected.includes(option.id)}
            onClick={() => onToggle(option.id)}
          >
            {option.icon}
            {option.label}
          </Chip>
        ))}
      </div>
    </fieldset>
  );
}
