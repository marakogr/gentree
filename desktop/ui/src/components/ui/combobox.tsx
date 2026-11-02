// Searchable single-select combobox on top of Fluent UI v9.
//
// Fluent owns the interaction (keyboard, outside click, active option, ARIA)
// while this file keeps the public API unchanged: `value` is the selected item
// id and `onChange` receives an id, never the typed text.
//
// Filtering stays ours: `filterComboItems` folds the Cyrillic yo letter and
// compares case-insensitively against both `label` and `hint`, which Fluent's
// built-in `useComboboxFilter` does not do.

import { useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Combobox as FluentCombobox,
  Option,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import type {
  OptionOnSelectData,
  SelectionEvents,
} from "@fluentui/react-components";
import {
  COMBOBOX_OPTION_HEIGHT_PX,
  COMBOBOX_POSITIONING,
  comboListboxMaxHeightPx,
  filterComboItems,
} from "./helpers";
import type { ComboItem } from "./helpers";

export type { ComboItem } from "./helpers";

export type ComboboxProps = {
  items: ComboItem[];
  /** Selected item id or `""` when nothing is selected. */
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
  ariaLabel: string;
  /** When provided, the Fluent clear button is shown. */
  clearLabel?: string;
  /** Shown when the filter matches nothing. */
  emptyLabel?: string;
  /**
   * Rich option body (avatar, two-line text, …). It replaces the default
   * label/hint markup; Fluent keeps keyboard, filtering and outside-click
   * behaviour. Keep it DOM-light: no nested interactive elements.
   */
  renderOption?: (item: ComboItem) => ReactNode;
  disabled?: boolean;
  id?: string;
  /** Wired by `Field`; optional for standalone usage. */
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  required?: boolean;
};

const useStyles = makeStyles({
  // Fluent's root is an inline grid with `min-width: 250px`; the previous
  // input stretched to the field width, so we keep that behaviour.
  root: {
    width: "100%",
    minWidth: 0,
  },
  optionText: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    minWidth: 0,
    maxWidth: "100%",
    overflow: "hidden",
  },
  // One fixed-height row per person: five full rows fit, nothing wraps the
  // popup taller than the five-row limit.
  optionLabel: {
    display: "block",
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  hint: {
    display: "block",
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
  // Rich rows (avatar + text) need a wider gap than the Fluent default.
  richOption: {
    columnGap: tokens.spacingHorizontalS,
  },
  // Compact rows are shorter than rich ones; the exact height keeps exactly
  // five full rows inside the listbox and stops long names from widening or
  // growing the popup.
  optionRow: {
    height: `${COMBOBOX_OPTION_HEIGHT_PX}px`,
    minHeight: `${COMBOBOX_OPTION_HEIGHT_PX}px`,
    maxHeight: `${COMBOBOX_OPTION_HEIGHT_PX}px`,
    overflow: "hidden",
  },
  // Long lists used to grow over the whole window. Fluent still anchors the
  // listbox to the input and scrolls the active option into view. The inline
  // maxHeight in the slot below is the hard cap; the class is the fallback.
  listbox: {
    maxHeight: `${comboListboxMaxHeightPx()}px`,
    overflowY: "auto",
    overflowX: "hidden",
    overscrollBehavior: "contain",
  },
});

export function Combobox({
  items,
  value,
  onChange,
  placeholder,
  ariaLabel,
  clearLabel,
  emptyLabel,
  renderOption,
  disabled = false,
  id,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  required = false,
}: ComboboxProps) {
  const styles = useStyles();
  const generatedId = useId();
  const inputId = id ?? generatedId;

  // `null` means "not filtering": the input shows the selected label.
  // A string (including `""`) is the live filter text.
  const [query, setQuery] = useState<string | null>(null);

  const selected = items.find((item) => item.id === value) ?? null;
  const filtered = useMemo(
    () => (query === null ? items : filterComboItems(items, query)),
    [items, query],
  );

  const handleOptionSelect = (
    event: SelectionEvents,
    data: OptionOnSelectData,
  ) => {
    if (data.optionValue === undefined) {
      // Fluent also drops the selection while typing, as soon as the text no
      // longer matches an option. Only the explicit clear button changes a
      // value: its click is the only non-`change` event without an option.
      if (event.type === "change") return;
      setQuery(null);
      onChange("");
      return;
    }
    setQuery(null);
    onChange(data.optionValue);
  };

  return (
    <FluentCombobox
      className={styles.root}
      id={inputId}
      value={query ?? selected?.label ?? ""}
      onChange={(event) => setQuery(event.target.value)}
      onOptionSelect={handleOptionSelect}
      onOpenChange={(_, data) => {
        // Previous behaviour: opening clears the input and lists everything,
        // closing restores the label of the selected item.
        setQuery(data.open ? "" : null);
      }}
      selectedOptions={value === "" ? [] : [value]}
      clearable={clearLabel !== undefined}
      clearIcon={clearLabel ? { title: clearLabel } : undefined}
      placeholder={placeholder}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      aria-invalid={ariaInvalid}
      required={required}
      disabled={disabled}
      positioning={COMBOBOX_POSITIONING}
      // WebView2 may still show its "saved information" dropdown despite the
      // window-level switch; the attribute covers the other webviews.
      autoComplete="off"
      listbox={{
        className: styles.listbox,
        style: {
          maxHeight: `${comboListboxMaxHeightPx()}px`,
          overflowY: "auto",
        },
        "aria-label": ariaLabel,
      }}
    >
      {filtered.map((item) => (
        <Option
          key={item.id}
          value={item.id}
          text={item.label}
          title={item.label}
          className={mergeClasses(
            styles.optionRow,
            renderOption ? styles.richOption : undefined,
          )}
        >
          {renderOption ? (
            renderOption(item)
          ) : (
            <span className={styles.optionText}>
              <span className={styles.optionLabel}>{item.label}</span>
              {item.hint ? (
                <span className={styles.hint}>{item.hint}</span>
              ) : null}
            </span>
          )}
        </Option>
      ))}
      {filtered.length === 0 && emptyLabel ? (
        <Option key="__empty" disabled text={emptyLabel}>
          {emptyLabel}
        </Option>
      ) : null}
    </FluentCombobox>
  );
}
