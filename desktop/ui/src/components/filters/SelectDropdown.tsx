// Single-select dropdown for small enum sets. Same shell as the multi-select
// picker (button trigger, popover listbox, arrow/Enter/Escape keys) but a click
// replaces the value and closes the popover.

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import {
  Button,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { CheckmarkRegular, ChevronDownRegular } from "@fluentui/react-icons";
import { moveActiveIndex, type ComboItem } from "../ui/helpers";
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

const useStyles = makeStyles({
  trigger: {
    display: "flex",
    justifyContent: "flex-start",
    // Fluent buttons default to semibold; the neighbouring fields use regular
    // input text, so match them.
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
    padding: tokens.spacingHorizontalS,
    maxWidth: "calc(100vw - 2rem)",
    maxHeight: `${SURFACE_MAX_HEIGHT_PX}px`,
    overflowX: "hidden",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    minWidth: 0,
    gap: "2px",
    maxHeight: "16rem",
    overflowY: "auto",
    overflowX: "hidden",
    overscrollBehavior: "contain",
    outlineStyle: "none",
  },
});

export function SelectDropdown({
  options,
  value,
  onChange,
  label,
  placeholder,
  disabled = false,
  id,
}: SelectDropdownProps) {
  const styles = useStyles();
  const generatedId = useId();
  const baseId = id ?? generatedId;
  const listboxId = `${baseId}-listbox`;
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const selected = options.find((option) => option.id === value);
  const selectedIndex = options.findIndex((option) => option.id === value);

  const optionId = (optionValue: string) => `${baseId}-option-${optionValue}`;

  useEffect(() => {
    if (!open) return;
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    const frame = requestAnimationFrame(() => listRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, selectedIndex]);

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
    const row = document.getElementById(optionId(options[active]?.id ?? ""));
    row?.scrollIntoView({ block: "nearest" });
    // `optionId` is derived from stable ids; the option list is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, open, options]);

  const choose = (optionValue: string) => {
    onChange(optionValue);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive((index) => moveActiveIndex(index, 1, options.length));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive((index) => moveActiveIndex(index, -1, options.length));
        break;
      case "Home":
        event.preventDefault();
        setActive(options.length > 0 ? 0 : -1);
        break;
      case "End":
        event.preventDefault();
        setActive(options.length > 0 ? options.length - 1 : -1);
        break;
      case "Enter": {
        const option = options[active];
        if (!option) break;
        event.preventDefault();
        choose(option.id);
        break;
      }
      case "Escape":
        event.preventDefault();
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(_, data) => setOpen(data.open)}
      positioning={{
        position: "below",
        align: "start",
        offset: 4,
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
          title={selected?.label ?? placeholder ?? label}
        >
          {selected?.icon ? (
            <span className="multi-select-trigger-icon" aria-hidden="true">
              {selected.icon}
            </span>
          ) : null}
          <span className={styles.triggerLabel}>
            {selected?.label ?? placeholder ?? label}
          </span>
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
          aria-activedescendant={
            active >= 0 && options[active]
              ? optionId(options[active].id)
              : undefined
          }
          tabIndex={0}
          className={styles.list}
          onKeyDown={handleKeyDown}
        >
          {options.map((option, index) => {
            const checked = option.id === value;
            return (
              <div
                key={option.id}
                id={optionId(option.id)}
                role="option"
                aria-selected={checked}
                data-active={index === active ? "true" : undefined}
                className="multi-select-option"
                title={option.label}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option.id)}
              >
                <span className="multi-select-check" aria-hidden="true">
                  {checked ? <CheckmarkRegular fontSize={14} /> : null}
                </span>
                {option.icon ? (
                  <span className="multi-select-icon" aria-hidden="true">
                    {option.icon}
                  </span>
                ) : null}
                <span className="multi-select-label">{option.label}</span>
              </div>
            );
          })}
        </div>
      </PopoverSurface>
    </Popover>
  );
}
