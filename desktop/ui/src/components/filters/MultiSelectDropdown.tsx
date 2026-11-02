// Searchable multi-select dropdown for small enum sets (event types and the
// like). The trigger shows the current state in one compact field, the popover
// keeps a search input and a checkbox list; nothing selected means "all", which
// is why the first row clears the selection.
//
// Fluent owns the popover (outside click, positioning inside the viewport); the
// listbox and keyboard model live here so the component stays independent of
// Fluent's single-select Combobox.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import {
  Button,
  Input,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  CheckmarkRegular,
  ChevronDownRegular,
  DismissRegular,
} from "@fluentui/react-icons";
import {
  filterComboItems,
  moveActiveIndex,
  type ComboItem,
} from "../ui/helpers";
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
  searchPlaceholder: string;
  emptyLabel: string;
  /** Trigger text when more than one option is selected. */
  multipleLabel: (count: number) => string;
  disabled?: boolean;
  id?: string;
};

const SURFACE_MAX_HEIGHT_PX = 320;

const useStyles = makeStyles({
  trigger: {
    display: "flex",
    justifyContent: "flex-start",
    minWidth: 0,
    maxWidth: "100%",
    overflow: "hidden",
  },
  triggerLabel: {
    flex: "1 1 auto",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  surface: {
    display: "grid",
    gap: tokens.spacingVerticalS,
    width: "20rem",
    maxWidth: "min(20rem, calc(100vw - 2rem))",
    maxHeight: `${SURFACE_MAX_HEIGHT_PX}px`,
    padding: tokens.spacingHorizontalS,
  },
  search: {
    width: "100%",
  },
  list: {
    display: "grid",
    gap: "2px",
    maxHeight: "16rem",
    overflowY: "auto",
    overscrollBehavior: "contain",
  },
});

export function MultiSelectDropdown({
  options,
  values,
  onChange,
  label,
  allLabel,
  searchPlaceholder,
  emptyLabel,
  multipleLabel,
  disabled = false,
  id,
}: MultiSelectDropdownProps) {
  const styles = useStyles();
  const generatedId = useId();
  const baseId = id ?? generatedId;
  const listboxId = `${baseId}-listbox`;
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);

  const selected = useMemo(
    () => options.filter((option) => values.includes(option.id)),
    [options, values],
  );

  const filtered = useMemo(
    () => filterComboItems(options, query),
    [options, query],
  );

  // The "all" row stays fixed above the filtered list, so keyboard indices are
  // offset by one; `rows` is the single source for navigation.
  const rows = useMemo(
    () => [
      { id: "", label: allLabel } as MultiSelectOption,
      ...filtered,
    ],
    [allLabel, filtered],
  );

  const isChecked = (optionId: string): boolean =>
    optionId === "" ? values.length === 0 : values.includes(optionId);

  const toggle = (optionId: string) => {
    onChange(toggleMultiSelect(values, optionId));
  };

  const optionId = (optionIdValue: string) =>
    `${baseId}-option-${optionIdValue === "" ? "all" : optionIdValue}`;

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    // The search field is the keyboard entry point; focusing it on open also
    // keeps the popover from stealing focus back to the trigger.
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // Escape closes the popover even when focus drifted out of the search field
  // (for example after a pointer click on the surface padding).
  useEffect(() => {
    if (!open) return;
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [open]);

  useEffect(() => {
    if (!open || active < 0) return;
    const row = document.getElementById(optionId(rows[active]?.id ?? ""));
    row?.scrollIntoView({ block: "nearest" });
    // `optionId` is derived from stable ids; the row list is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, open, rows]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive((index) => moveActiveIndex(index, 1, rows.length));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive((index) => moveActiveIndex(index, -1, rows.length));
        break;
      case "Home":
        event.preventDefault();
        setActive(rows.length > 0 ? 0 : -1);
        break;
      case "End":
        event.preventDefault();
        setActive(rows.length > 0 ? rows.length - 1 : -1);
        break;
      case "Enter": {
        if (active < 0) break;
        const row = rows[active];
        if (!row) break;
        event.preventDefault();
        toggle(row.id);
        break;
      }
      case "Escape":
        // Handled by the document listener, which also covers focus that left
        // the search field; only stop the default here.
        event.preventDefault();
        break;
      case "Tab":
        // Tabbing out is a normal exit; close instead of leaving an orphaned
        // popover behind the next field.
        setOpen(false);
        break;
      default:
        break;
    }
  };

  const triggerText =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? selected[0].label
        : multipleLabel(selected.length);

  return (
    <Popover
      open={open}
      onOpenChange={(_, data) => setOpen(data.open)}
      positioning={{ position: "below", align: "start", offset: 4 }}
      withArrow={false}
    >
      <PopoverTrigger disableButtonEnhancement>
        <Button
          ref={triggerRef}
          id={baseId}
          type="button"
          appearance="outline"
          size="medium"
          className={styles.trigger}
          disabled={disabled}
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={open}
          title={
            selected.length > 0
              ? selected.map((option) => option.label).join(", ")
              : allLabel
          }
        >
          {selected[0]?.icon ? (
            <span className="multi-select-trigger-icon" aria-hidden="true">
              {selected[0].icon}
            </span>
          ) : null}
          <span className={styles.triggerLabel}>{triggerText}</span>
          <ChevronDownRegular
            className="multi-select-trigger-chevron"
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>
      <PopoverSurface className={styles.surface} role="presentation">
        <Input
          ref={inputRef}
          className={styles.search}
          value={query}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          role="combobox"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            active >= 0 && rows[active] ? optionId(rows[active].id) : undefined
          }
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            const next = event.target.value;
            setQuery(next);
            // Typing narrows the list: the keyboard focus moves to the first
            // real match, not the fixed "all" row, so Enter does not silently
            // clear the selection.
            if (next.trim() === "") {
              setActive(0);
            } else {
              setActive(filterComboItems(options, next).length > 0 ? 1 : 0);
            }
          }}
          onKeyDown={handleKeyDown}
        />
        <div
          id={listboxId}
          role="listbox"
          aria-label={label}
          aria-multiselectable="true"
          className={styles.list}
        >
          {rows.map((row, index) => {
            const checked = isChecked(row.id);
            return (
              <div
                key={row.id === "" ? "__all" : row.id}
                id={optionId(row.id)}
                role="option"
                aria-selected={checked}
                data-active={index === active ? "true" : undefined}
                className="multi-select-option"
                onMouseEnter={() => setActive(index)}
                // Keep the keyboard on the search field: a pointer click must
                // not move focus to the option (or to `body`), otherwise
                // Escape/arrows stop working after the first mouse pick.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => toggle(row.id)}
              >
                <span className="multi-select-check" aria-hidden="true">
                  {checked ? (
                    <CheckmarkRegular fontSize={14} />
                  ) : row.id === "" ? (
                    <DismissRegular fontSize={14} />
                  ) : null}
                </span>
                {row.icon ? (
                  <span className="multi-select-icon" aria-hidden="true">
                    {row.icon}
                  </span>
                ) : null}
                <span className="multi-select-label">{row.label}</span>
                {row.hint ? (
                  <span className="multi-select-hint">{row.hint}</span>
                ) : null}
              </div>
            );
          })}
          {filtered.length === 0 ? (
            <div className="multi-select-empty">{emptyLabel}</div>
          ) : null}
        </div>
      </PopoverSurface>
    </Popover>
  );
}
