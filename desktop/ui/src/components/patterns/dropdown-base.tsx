// Shared trigger, popover and listbox shell for the single- and multi-select
// dropdowns. The listbox keyboard model is pure (`listbox.ts`); this component
// wires it to DOM focus, pointer capture and ARIA.

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
import { CheckmarkRegular, ChevronDownRegular, DismissRegular } from "@fluentui/react-icons";
import { listboxKeyAction, optionElementId } from "./listbox";
import "../../components/filters/filters.css";

export type DropdownItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  checked: boolean;
  /** The multi-select "all" row; unchecked rows show a dismiss glyph. */
  all?: boolean;
};

export type DropdownBaseProps = {
  label: string;
  disabled?: boolean;
  id?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerText: string;
  triggerTitle?: string;
  triggerIcon?: ReactNode;
  items: readonly DropdownItem[];
  /** Highlighted row when the popover opens. */
  initialActive: () => number;
  onSelect: (id: string) => void;
  /** Single-select closes on pick; multi-select keeps the popover open. */
  closeOnSelect?: boolean;
  multiselectable?: boolean;
  surfaceMaxHeightPx: number;
  /** Multi-select keeps a small gap between the surface and its list. */
  surfaceGap?: boolean;
  listMode?: "single" | "multi";
};

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
    overflowX: "hidden",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    minWidth: 0,
    gap: "2px",
    overflowY: "auto",
    overflowX: "hidden",
    overscrollBehavior: "contain",
    outlineStyle: "none",
  },
});

export function DropdownBase({
  label,
  disabled = false,
  id,
  open,
  onOpenChange,
  triggerText,
  triggerTitle,
  triggerIcon,
  items,
  initialActive,
  onSelect,
  closeOnSelect = true,
  multiselectable = false,
  surfaceMaxHeightPx,
  surfaceGap = false,
  listMode = "single",
}: DropdownBaseProps) {
  const styles = useStyles();
  const generatedId = useId();
  const baseId = id ?? generatedId;
  const listboxId = `${baseId}-listbox`;
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const initialActiveRef = useRef(initialActive);
  initialActiveRef.current = initialActive;

  const [active, setActive] = useState(-1);

  useEffect(() => {
    if (!open) return undefined;
    setActive(initialActiveRef.current());
    const frame = requestAnimationFrame(() => listRef.current?.focus());
    return () => cancelAnimationFrame(frame);
    // `items` changes while the popover is open must not reset the highlight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onOpenChange(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open || active < 0) return;
    const row = document.getElementById(
      optionElementId(baseId, items[active]?.id ?? ""),
    );
    row?.scrollIntoView({ block: "nearest" });
    // Derived ids are stable; the item list is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, open, items]);

  const choose = (index: number) => {
    const item = items[index];
    if (!item) return;
    onSelect(item.id);
    if (closeOnSelect) {
      onOpenChange(false);
      triggerRef.current?.focus();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const action = listboxKeyAction(event.key, active, items.length);
    switch (action.type) {
      case "move":
        event.preventDefault();
        setActive(action.index);
        break;
      case "activate":
        event.preventDefault();
        choose(action.index);
        break;
      case "close":
        event.preventDefault();
        onOpenChange(false);
        if (action.restoreFocus) triggerRef.current?.focus();
        break;
      default:
        break;
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(_event, data) => onOpenChange(data.open)}
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
          title={triggerTitle ?? triggerText}
        >
          {triggerIcon ? (
            <span className="multi-select-trigger-icon" aria-hidden="true">
              {triggerIcon}
            </span>
          ) : null}
          <span className={styles.triggerLabel}>{triggerText}</span>
          <ChevronDownRegular
            className="multi-select-trigger-chevron"
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>
      <PopoverSurface
        className={styles.surface}
        role="presentation"
        style={{
          gap: surfaceGap ? tokens.spacingVerticalS : undefined,
          maxHeight: `${surfaceMaxHeightPx}px`,
        }}
      >
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={label}
          aria-multiselectable={multiselectable ? "true" : undefined}
          aria-activedescendant={
            active >= 0 && items[active]
              ? optionElementId(baseId, items[active].id)
              : undefined
          }
          tabIndex={0}
          className={styles.list}
          style={
            listMode === "multi"
              ? {
                  flex: "1 1 auto",
                  minHeight: 0,
                  maxHeight: "100%",
                }
              : { maxHeight: "16rem" }
          }
          onKeyDown={handleKeyDown}
        >
          {items.map((item, index) => (
            <div
              key={item.id === "" ? "__all" : item.id}
              id={optionElementId(baseId, item.id)}
              role="option"
              aria-selected={item.checked}
              data-active={index === active ? "true" : undefined}
              className="multi-select-option"
              title={item.label}
              onMouseEnter={() => setActive(index)}
              // Keep the keyboard on the listbox: a pointer click must not move
              // focus to the option (or to `body`), otherwise Escape/arrows
              // stop working after the first mouse pick.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
            >
              <span className="multi-select-check" aria-hidden="true">
                {item.checked ? (
                  <CheckmarkRegular fontSize={14} />
                ) : item.all ? (
                  <DismissRegular fontSize={14} />
                ) : null}
              </span>
              {item.icon ? (
                <span className="multi-select-icon" aria-hidden="true">
                  {item.icon}
                </span>
              ) : null}
              <span className="multi-select-label">{item.label}</span>
              {item.hint ? (
                <span className="multi-select-hint">{item.hint}</span>
              ) : null}
            </div>
          ))}
        </div>
      </PopoverSurface>
    </Popover>
  );
}
