// Mobile-style date field: an editable text input plus a calendar button that
// opens Fluent Popover with 1–3 scrollable columns. The value stays a plain
// civil-date string (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`), so `parseDateInput`,
// precision and qualifier semantics stay outside this component.
//
// Text can be typed by hand (`YYYY-MM-DD` and `DD.MM.YYYY` for DAY); only an
// existing calendar date is committed, so partial or impossible input never
// erases a valid value. Column picks are only committed after an explicit
// click, so an empty field never turns into today's date on its own.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Input,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { CalendarLtrRegular } from "@fluentui/react-icons";
import { useTranslation } from "react-i18next";
import type { DatePrecision } from "../../api/types";
import { daysInMonth, formatDateTyping, parseManualDateInput } from "../../lib/dates";

type Parts = { year: number; month: number; day: number };
type Chosen = { year: boolean; month: boolean; day: boolean };
type PartKey = keyof Parts;

/** One row in a wheel column; 5 rows stay visible inside the popover. */
const COLUMN_MAX_HEIGHT = "220px";
// The column always covers the last millennium plus a drafted earlier year;
// this keeps the DOM near a thousand rows instead of the whole CivilDate range.
const DEFAULT_YEAR = 1000;

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function todayParts(): Parts {
  const now = new Date();
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
  };
}

/**
 * Reads the parts that are already present in the draft. Missing parts stay
 * missing: they are only used as a scroll position, never as a choice.
 */
function parsedParts(value: string): Partial<Parts> {
  const match = /^(\d{1,4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(value.trim());
  if (!match) return {};
  const year = Number(match[1]);
  const month = match[2] === undefined ? undefined : Number(match[2]);
  const day = match[3] === undefined ? undefined : Number(match[3]);
  if (!Number.isInteger(year) || year < 1 || year > 9999) return {};

  // Keep every defensible part: an invalid month must not throw away a good
  // year, otherwise the wheel starts at today instead of the drafted year.
  const parts: Partial<Parts> = { year };
  if (month !== undefined && month >= 1 && month <= 12) parts.month = month;
  if (
    day !== undefined &&
    parts.month !== undefined &&
    day >= 1 &&
    day <= daysInMonth(year, parts.month)
  ) {
    parts.day = day;
  }
  return parts;
}

function chosenFrom(parts: Partial<Parts>): Chosen {
  return {
    year: parts.year !== undefined,
    month: parts.month !== undefined,
    day: parts.day !== undefined,
  };
}

function formatParts(parts: Parts, precision: DatePrecision): string {
  const year = pad(parts.year, 4);
  if (precision === "YEAR") return year;
  const month = `${year}-${pad(parts.month)}`;
  if (precision === "MONTH") return month;
  return `${month}-${pad(parts.day)}`;
}

/**
 * Text shown in the input for a committed value. A value stored under another
 * precision (e.g. a full date after switching DAY → MONTH) is narrowed to the
 * units the current precision shows; the full value is only replaced once the
 * user commits, so nothing is trimmed silently.
 */
function displayValue(value: string, precision: DatePrecision): string {
  const text = value.trim();
  if (text === "") return "";
  const parsed = parseManualDateInput(text, precision);
  if (parsed !== null) return parsed;

  const parts = parsedParts(text);
  if (parts.year === undefined) return text;
  const year = pad(parts.year, 4);
  if (precision === "YEAR") return year;
  if (parts.month === undefined) return text;
  const month = `${year}-${pad(parts.month)}`;
  if (precision === "MONTH") return month;
  return parts.day === undefined ? text : `${month}-${pad(parts.day)}`;
}

function isComplete(chosen: Chosen, precision: DatePrecision): boolean {
  if (precision === "YEAR") return chosen.year;
  if (precision === "MONTH") return chosen.year && chosen.month;
  return chosen.year && chosen.month && chosen.day;
}

/** The rightmost column confirms the picker; earlier columns stay open. */
function lastPart(precision: DatePrecision): PartKey {
  if (precision === "YEAR") return "year";
  if (precision === "MONTH") return "month";
  return "day";
}

const useStyles = makeStyles({
  field: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
  },
  input: {
    flex: 1,
    minWidth: 0,
  },
  calendarButton: {
    flex: "none",
    minWidth: "auto",
  },
  surface: {
    padding: tokens.spacingVerticalS,
    minWidth: "240px",
  },
  columns: {
    display: "flex",
    alignItems: "stretch",
    justifyContent: "center",
    gap: tokens.spacingHorizontalXS,
  },
  column: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    maxHeight: COLUMN_MAX_HEIGHT,
    overflowY: "auto",
    overflowX: "hidden",
    overscrollBehavior: "contain",
    scrollSnapType: "y proximity",
    padding: `0 ${tokens.spacingHorizontalXS}`,
  },
  dayColumn: {
    width: "56px",
  },
  monthColumn: {
    width: "132px",
  },
  yearColumn: {
    width: "80px",
  },
  item: {
    flex: "none",
    appearance: "none",
    border: 0,
    borderRadius: tokens.borderRadiusMedium,
    background: "transparent",
    color: tokens.colorNeutralForeground1,
    fontFamily: tokens.fontFamilyBase,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    minHeight: "36px",
    textAlign: "center",
    whiteSpace: "nowrap",
    cursor: "pointer",
    scrollSnapAlign: "center",
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "-2px",
    },
  },
  itemSelected: {
    // A neutral selected surface plus brand text/ring stays readable in both
    // themes; a brand-filled chip was too bright and left white text on a
    // pale cyan background in the dark theme.
    backgroundColor: tokens.colorNeutralBackground1Selected,
    color: tokens.colorBrandForeground1,
    fontWeight: tokens.fontWeightSemibold,
    boxShadow: `inset 0 0 0 1px ${tokens.colorBrandStroke1}`,
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground1Selected,
    },
  },
});

export type DateWheelProps = {
  /** Draft value: `YYYY`, `YYYY-MM`, `YYYY-MM-DD` or an empty string. */
  value: string;
  precision: DatePrecision;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Fired when the popover closes, so forms can mark the field touched. */
  onBlur?: () => void;
  disabled?: boolean;
  id?: string;
  /** Accessible name of the popover and the trigger. */
  ariaLabel?: string;
  /** Wired by `Field`; optional for standalone usage. */
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  required?: boolean;
};

export function DateWheel({
  value,
  precision,
  onChange,
  placeholder,
  onBlur,
  disabled = false,
  id,
  ariaLabel,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  required = false,
}: DateWheelProps) {
  const { t, i18n } = useTranslation(["common", "enums"]);
  const styles = useStyles();

  const [open, setOpen] = useState(false);
  const [parts, setParts] = useState<Parts>(() => ({
    ...todayParts(),
    ...parsedParts(value),
  }));
  const [chosen, setChosen] = useState<Chosen>(() =>
    chosenFrom(parsedParts(value)),
  );
  const [text, setText] = useState(() => displayValue(value, precision));
  const [invalid, setInvalid] = useState(false);

  const inputFocusedRef = useRef(false);
  const yearColumnRef = useRef<HTMLDivElement | null>(null);
  const monthColumnRef = useRef<HTMLDivElement | null>(null);
  const dayColumnRef = useRef<HTMLDivElement | null>(null);

  // Keep the text in sync with the committed value (wheel pick, reset, edit)
  // without overwriting what the user is currently typing.
  useEffect(() => {
    if (inputFocusedRef.current) return;
    setText(displayValue(value, precision));
    setInvalid(false);
  }, [value, precision]);

  const monthNames = useMemo(() => {
    const format = new Intl.DateTimeFormat(i18n.language || "ru", {
      month: "long",
      timeZone: "UTC",
    });
    return Array.from({ length: 12 }, (_, index) => {
      const name = format.format(new Date(Date.UTC(2000, index, 1)));
      return name.charAt(0).toUpperCase() + name.slice(1);
    });
  }, [i18n.language]);

  const years = useMemo(() => {
    const currentYear = new Date().getFullYear();
    const start = Math.min(DEFAULT_YEAR, parts.year);
    const end = Math.max(currentYear + 20, parts.year);
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }, [parts.year]);

  const days = useMemo(
    () =>
      Array.from(
        { length: daysInMonth(parts.year, parts.month) },
        (_, index) => index + 1,
      ),
    [parts.year, parts.month],
  );

  const showMonth = precision === "DAY" || precision === "MONTH";
  const showDay = precision === "DAY";

  // Re-centre every wheel once the popover is mounted. Later clicks already
  // happen inside a scrolled column, so no further jump is needed.
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const columns = [
        showMonth ? monthColumnRef.current : null,
        showDay ? dayColumnRef.current : null,
        yearColumnRef.current,
      ];
      for (const column of columns) {
        column
          ?.querySelector<HTMLElement>('[data-selected="true"]')
          ?.scrollIntoView({ block: "center", inline: "nearest" });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, precision, showDay, showMonth]);

  if (precision === "UNKNOWN") return null;

  const close = () => {
    setOpen(false);
    onBlur?.();
  };

  /**
   * Applies typed text. Only an existing calendar date is committed; invalid or
   * partial text stays visible (flagged) and leaves the committed value intact.
   */
  const commitText = (raw: string) => {
    const parsed = parseManualDateInput(raw, precision);
    if (parsed === null) {
      if (raw.trim() === "") {
        // An empty field means "no date" only when there was none; it never
        // erases an already valid value.
        setText(displayValue(value, precision));
        setInvalid(false);
      } else {
        setInvalid(true);
      }
      return;
    }
    setInvalid(false);
    setText(parsed);
    if (parsed !== value) onChange(parsed);
  };

  const handleInputBlur = () => {
    inputFocusedRef.current = false;
    commitText(text);
    onBlur?.();
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      const parsed = parsedParts(value);
      setParts({ ...todayParts(), ...parsed });
      setChosen(chosenFrom(parsed));
      setOpen(true);
      return;
    }
    if (open) close();
  };

  const select = (part: PartKey, next: number) => {
    const wasComplete = isComplete(chosen, precision);
    const merged: Parts = { ...parts, [part]: next };
    // February 29 → 28 when the year/month changes; never keep an invalid day.
    merged.day = Math.min(merged.day, daysInMonth(merged.year, merged.month));
    const nextChosen: Chosen = { ...chosen, [part]: true };

    setParts(merged);
    setChosen(nextChosen);
    setInvalid(false);

    if (!isComplete(nextChosen, precision)) return;
    const formatted = formatParts(merged, precision);
    setText(formatted);
    onChange(formatted);
    // Close when this click completed an empty/partial picker. An already
    // complete value stays open until the confirming column (day/month/year)
    // is clicked, so the user can adjust several parts in one visit.
    if (!wasComplete || part === lastPart(precision)) close();
  };

  const renderWheelItem = (part: PartKey, next: number, label: string) => {
    const selected = parts[part] === next;
    return (
      <button
        key={`${part}:${next}`}
        type="button"
        role="option"
        aria-selected={selected}
        data-selected={selected ? "true" : undefined}
        className={mergeClasses(styles.item, selected && styles.itemSelected)}
        onClick={() => select(part, next)}
      >
        {label}
      </button>
    );
  };

  return (
    <div className={styles.field}>
      <Input
        id={id}
        className={styles.input}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        autoComplete="off"
        spellCheck={false}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={invalid ? true : ariaInvalid}
        onFocus={() => {
          inputFocusedRef.current = true;
        }}
        onChange={(event) => {
          // Insert the separators while typing: the user never has to type a
          // dash, and pasted digits land in the canonical shape.
          setText(formatDateTyping(event.target.value, precision));
          setInvalid(false);
        }}
        onBlur={handleInputBlur}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            // Commit instead of submitting the surrounding form.
            event.preventDefault();
            commitText(text);
          } else if (event.key === "Escape") {
            setText(displayValue(value, precision));
            setInvalid(false);
          }
        }}
      />
      <Popover
        open={open}
        trapFocus
        onOpenChange={(_, data) => handleOpenChange(data.open)}
      >
        <PopoverTrigger disableButtonEnhancement>
          <Button
            type="button"
            className={styles.calendarButton}
            appearance="outline"
            disabled={disabled}
            aria-label={ariaLabel ?? t("common:fields.date")}
            icon={<CalendarLtrRegular />}
          />
        </PopoverTrigger>
        <PopoverSurface
          className={styles.surface}
          role="dialog"
          aria-label={ariaLabel ?? t("enums:datePrecision.DAY")}
        >
          <div className={styles.columns}>
            {showDay ? (
              <div
                ref={dayColumnRef}
                className={mergeClasses(styles.column, styles.dayColumn)}
                role="listbox"
                aria-label={t("enums:datePrecision.DAY")}
              >
                {days.map((day) => renderWheelItem("day", day, String(day)))}
              </div>
            ) : null}

            {showMonth ? (
              <div
                ref={monthColumnRef}
                className={mergeClasses(styles.column, styles.monthColumn)}
                role="listbox"
                aria-label={t("enums:datePrecision.MONTH")}
              >
                {monthNames.map((month, index) =>
                  renderWheelItem("month", index + 1, month),
                )}
              </div>
            ) : null}

            <div
              ref={yearColumnRef}
              className={mergeClasses(styles.column, styles.yearColumn)}
              role="listbox"
              aria-label={t("enums:datePrecision.YEAR")}
            >
              {years.map((year) => renderWheelItem("year", year, String(year)))}
            </div>
          </div>
        </PopoverSurface>
      </Popover>
    </div>
  );
}
