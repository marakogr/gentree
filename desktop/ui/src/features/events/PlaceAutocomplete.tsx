// Opt-in online address suggestions for a free-text place field (ADR-0016).
//
// The field always stays a text input: suggestions are additive, the stored
// value is the string the user confirms, and historical spellings remain
// possible. While `enabled` is false this renders the plain Fluent `Input` and
// never sends a query.
//
// Privacy: the query is the only thing sent, and only from this component;
// neither the query nor a provider error is logged or shown as a toast.

import { useEffect, useId, useRef, useState } from "react";
import {
  Combobox as FluentCombobox,
  Input,
  Option,
  Text,
} from "@fluentui/react-components";
import { WarningRegular } from "@fluentui/react-icons";
import type {
  OptionOnSelectData,
  SelectionEvents,
} from "@fluentui/react-components";
import { useTranslation } from "react-i18next";
import { placesApi } from "../../api/client";
import type { PlaceGeo, PlaceSuggestion } from "../../api/types";
import {
  COMBOBOX_POSITIONING,
  comboListboxMaxHeightPx,
} from "../../components/ui/helpers";
import { placeQuery, placeSuggestionText } from "./place";
import "./events.css";

/** Quiet period after the last keystroke before the providers are asked. */
const SEARCH_DEBOUNCE_MS = 300;

export type PlaceAutocompleteProps = {
  id?: string;
  value: string;
  /**
   * `point` is the provider's exact object when the user picked a suggestion;
   * `undefined` means a manual edit, which invalidates any stored point.
   */
  onChange: (value: string, point?: PlaceGeo | null) => void;
  /** `false` renders a plain text input and makes no network call. */
  enabled: boolean;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  required?: boolean;
};

export function PlaceAutocomplete({
  id,
  value,
  onChange,
  enabled,
  disabled = false,
  placeholder,
  ariaLabel,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  required = false,
}: PlaceAutocompleteProps) {
  const { t } = useTranslation();
  const generatedId = useId();
  const inputId = id ?? generatedId;

  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // Only the latest request may write to state; a slower earlier answer is
  // dropped instead of replacing the suggestions for a newer query.
  const requestId = useRef(0);
  // Selecting an option still echoes through the combobox's text change; the
  // confirmed point must survive that echo (ADR-0020).
  const selectionPending = useRef(false);
  const lastSelected = useRef<string | null>(null);
  // A Wikidata match keeps the typed historical text; ignore its modern label
  // if the combobox echoes it back.
  const keepLabel = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !open) return;
    const query = placeQuery(value);
    if (query === null) {
      requestId.current += 1;
      setSuggestions([]);
      setLoading(false);
      setFailed(false);
      return;
    }

    const current = (requestId.current += 1);
    setLoading(true);
    setFailed(false);
    const timer = window.setTimeout(() => {
      placesApi.suggest(query).then(
        (items) => {
          if (requestId.current !== current) return;
          setSuggestions(items);
          setLoading(false);
        },
        () => {
          // No global toast: free text keeps working, so a quiet line under
          // the field is enough.
          if (requestId.current !== current) return;
          setSuggestions([]);
          setFailed(true);
          setLoading(false);
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, open, value]);

  const sourceLabel = (source: PlaceSuggestion["source"]) =>
    source === "dadata"
      ? t("event:sourceDadata")
      : source === "wikidata"
        ? t("event:sourceWikidata")
        : t("event:sourcePhoton");

  // Selecting writes the label as free text; closing the dropdown is not a
  // value change, so a half-typed historical place is never erased.
  const handleOptionSelect = (
    _event: SelectionEvents,
    data: OptionOnSelectData,
  ) => {
    const index = data.optionValue === undefined ? -1 : Number(data.optionValue);
    const suggestion = Number.isInteger(index) ? suggestions[index] : undefined;
    if (!suggestion) return;
    // Historical matches keep the typed name; the modern label is stored in the
    // point and shown next to the coordinates. A contextual match uses a modern
    // provider but was still found through the typed historical city.
    const keepsTypedText =
      suggestion.source === "wikidata" || suggestion.historical === true;
    const text = keepsTypedText
      ? value
      : placeSuggestionText(suggestion.label);
    if (keepsTypedText) keepLabel.current = suggestion.label;
    lastSelected.current = text;
    selectionPending.current = true;
    window.setTimeout(() => {
      selectionPending.current = false;
    }, 0);
    onChange(text, suggestion.point ?? null);
  };

  const handleInputChange = (next: string) => {
    if (keepLabel.current !== null) {
      const echoed = next === keepLabel.current;
      keepLabel.current = null;
      if (echoed) return;
    }
    // Ignore the combobox echo of the selection that already carried a point.
    if (selectionPending.current || next === lastSelected.current) {
      selectionPending.current = false;
      return;
    }
    lastSelected.current = null;
    onChange(next);
  };

  if (!enabled) {
    return (
      <Input
        id={inputId}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        required={required}
        onChange={(event) => handleInputChange(event.target.value)}
      />
    );
  }

  return (
    <div className="place-autocomplete">
      <FluentCombobox
        id={inputId}
        className="place-autocomplete-input"
        // Typing is never restricted to the suggested list.
        freeform
        value={value}
        onChange={(event) => handleInputChange(event.target.value)}
        onOptionSelect={handleOptionSelect}
        onOpenChange={(_, data) => {
          setOpen(data.open);
          if (!data.open) {
            // An answer that arrives after the dropdown closed must not
            // resurrect a stale list on the next open.
            requestId.current += 1;
            setLoading(false);
          }
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        required={required}
        disabled={disabled}
        positioning={COMBOBOX_POSITIONING}
        autoComplete="off"
        listbox={{
          className: "place-autocomplete-listbox",
          style: {
            maxHeight: `${comboListboxMaxHeightPx()}px`,
            overflowY: "auto",
          },
          "aria-label": ariaLabel ?? placeholder ?? "",
        }}
      >
        {loading ? (
          <Option key="__place_searching" disabled text={t("event:placeSearching")}>
            {t("event:placeSearching")}
          </Option>
        ) : null}
        {suggestions.map((suggestion, index) => (
          <Option
            key={`${suggestion.source}-${index}`}
            value={String(index)}
            text={suggestion.label}
            title={suggestion.label}
            className="place-autocomplete-option"
          >
            <span className="place-autocomplete-option-text">
              <span>{suggestion.label}</span>
              <span className="place-autocomplete-hint">
                {sourceLabel(suggestion.source)}
                {suggestion.hint.trim() !== "" ? ` · ${suggestion.hint}` : ""}
              </span>
            </span>
          </Option>
        ))}
      </FluentCombobox>
      {failed ? (
        <p
          className="place-autocomplete-unavailable"
          role="status"
          aria-live="polite"
        >
          <WarningRegular fontSize={14} aria-hidden="true" />
          <Text size={200}>{t("event:placeSearchFailed")}</Text>
        </p>
      ) : null}
    </div>
  );
}
