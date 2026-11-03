// Multi-select dropdown for small enum sets (event types and the like). The
// trigger shows the current state in one compact field; the popover keeps a
// checkbox list, and nothing selected means "all", which is why the first row
// clears the selection.
//
// Fluent owns the popover (outside click, positioning inside the viewport); the
// listbox and keyboard model live here so the component stays independent of
// Fluent's single-select Combobox. The listbox itself takes focus, so the arrows
// and Enter work without a search field.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import {
  Button,
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
  comboListboxMaxHeightPx,
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
  /** Trigger text when more than one option is selected. */
  multipleLabel: (count: number) => string;
  disabled?: boolean;
  id?: string;
};

const SURFACE_MAX_HEIGHT_PX = comboListboxMaxHeightPx();

const useStyles = makeStyles({
  trigger: {
    display: "flex",
    justifyContent: "flex-start",
    // Fluent buttons default to semibold; the person combobox beside this one
    // uses regular input text, so match it.
    fontWeight: tokens.fontWeightRegular,
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
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    minWidth: 0,
    gap: tokens.spacingVerticalS,
    maxWidth: "calc(100vw - 2rem)",
    // Same cap as the person combobox listbox: five rows plus its padding.
    maxHeight: `${SURFACE_MAX_HEIGHT_PX}px`,
    padding: tokens.spacingHorizontalS,
    overflowX: "hidden",
  },
  list: {
    display: "flex",
    flex: "1 1 auto",
    flexDirection: "column",
    width: "100%",
    minWidth: 0,
    minHeight: 0,
    gap: "2px",
    maxHeight: "100%",
    overflowY: "auto",
    overflowX: "hidden",
    overscrollBehavior: "contain",
    outlineStyle: "none",
  },
});

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
  const styles = useStyles();
  const generatedId = useId();
  const baseId = id ?? generatedId;
  const listboxId = `${baseId}-listbox`;
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const selected = useMemo(
    () => options.filter((option) => values.includes(option.id)),
    [options, values],
  );

  // The "all" row stays fixed above the list, so keyboard indices are offset by
  // one; `rows` is the single source for navigation.
  const rows = useMemo(
    () => [{ id: "", label: allLabel } as MultiSelectOption, ...options],
    [allLabel, options],
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
    setActive(0);
    // The listbox is the keyboard entry point; focusing it on open also keeps
    // the popover from stealing focus back to the trigger.
    const frame = requestAnimationFrame(() => listRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // Escape closes the popover even when focus drifted out of the listbox (for
  // example after a pointer click on the surface padding).
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

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
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
        // the listbox; only stop the default here.
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
      positioning={{
        position: "below",
        align: "start",
        offset: 4,
        // The popup is exactly as wide as its trigger, like a native select.
        matchTargetSize: "width",
      }}
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
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={label}
          aria-multiselectable="true"
          aria-activedescendant={
            active >= 0 && rows[active] ? optionId(rows[active].id) : undefined
          }
          tabIndex={0}
          className={styles.list}
          onKeyDown={handleKeyDown}
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
                title={row.label}
                onMouseEnter={() => setActive(index)}
                // Keep the keyboard on the listbox: a pointer click must not
                // move focus to the option (or to `body`), otherwise
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
        </div>
      </PopoverSurface>
    </Popover>
  );
}
