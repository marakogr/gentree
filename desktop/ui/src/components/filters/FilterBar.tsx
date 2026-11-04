// Shared filter bar: live search, filter chips, one reset action and the
// "found N of M" counter. Used by persons, events, search and timeline.
//
// The bar is composed from generic pieces (search, chips, panel toggle) so a
// screen can reuse one piece without the whole layout.

import { useId, useState, type ReactNode } from "react";
import {
  Button as FluentButton,
  CounterBadge,
  SearchBox,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { ChevronDownRegular, SearchRegular } from "@fluentui/react-icons";
import { Button } from "../ui/button";
import { Chip } from "../ui/chip";
import {
  isFilterResetDisabled,
  showsFilterChips,
  showsFilterPanelToggle,
} from "./filterBarRules";
import "./filters.css";

export type FilterChipModel = {
  id: string;
  label: string;
  removeLabel: string;
  onRemove: () => void;
};

export type FilterBarProps = {
  query: string;
  onQueryChange: (value: string) => void;
  queryPlaceholder: string;
  queryLabel: string;
  clearLabel: string;
  filtersLabel: string;
  activeCount: number;
  chips: FilterChipModel[];
  onReset: () => void;
  resetLabel: string;
  resultLabel?: string;
  loading?: boolean;
  /** Count badge on the filters toggle; off for screens that hide it. */
  showActiveBadge?: boolean;
  /** The "reset filters" action inside the chips row. */
  showReset?: boolean;
  /**
   * Render the filter controls (children) in the same wrapping row as the
   * search field instead of the collapsible panel. Used by the timeline, where
   * every control fits one compact strip.
   */
  inline?: boolean;
  children?: ReactNode;
};

const useStyles = makeStyles({
  // Fluent's SearchBox is inline-flex with a fixed max width; the old input
  // stretched inside `.filter-search`, so keep that behaviour.
  search: {
    width: "100%",
    minWidth: 0,
    maxWidth: "100%",
  },
  result: {
    color: tokens.colorNeutralForeground2,
    whiteSpace: "nowrap",
  },
});

export type FilterSearchProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  clearLabel: string;
};

/** Search field with the shared clear affordance. */
export function FilterSearch({
  value,
  onChange,
  placeholder,
  label,
  clearLabel,
}: FilterSearchProps) {
  const styles = useStyles();
  return (
    <div className="filter-search">
      <SearchBox
        className={styles.search}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        contentBefore={<SearchRegular aria-hidden="true" />}
        dismiss={{
          "aria-label": clearLabel,
          title: clearLabel,
          // Fluent keeps the dismiss slot mounted; hide it while the field is
          // empty so no pointless clear button appears on focus.
          style: value === "" ? { display: "none" } : undefined,
        }}
        onChange={(_, data) => onChange(data.value)}
      />
    </div>
  );
}

export type FilterChipsRowProps = {
  chips: FilterChipModel[];
  showReset: boolean;
  resetDisabled: boolean;
  resetLabel: string;
  onReset: () => void;
};

/** Active filter chips plus the optional reset action. */
export function FilterChipsRow({
  chips,
  showReset,
  resetDisabled,
  resetLabel,
  onReset,
}: FilterChipsRowProps) {
  return (
    <div className="filter-chips">
      {chips.map((chip) => (
        <Chip
          key={chip.id}
          tone="accent"
          onRemove={chip.onRemove}
          removeLabel={chip.removeLabel}
        >
          {chip.label}
        </Chip>
      ))}
      {showReset ? (
        <FluentButton
          appearance="transparent"
          size="small"
          onClick={onReset}
          disabled={resetDisabled}
        >
          {resetLabel}
        </FluentButton>
      ) : null}
    </div>
  );
}

export type FilterPanelToggleProps = {
  open: boolean;
  panelId: string;
  label: string;
  activeCount: number;
  showBadge: boolean;
  onToggle: () => void;
};

/** Button that opens the filter panel and shows its active count. */
export function FilterPanelToggle({
  open,
  panelId,
  label,
  activeCount,
  showBadge,
  onToggle,
}: FilterPanelToggleProps) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-expanded={open}
      aria-controls={panelId}
      onClick={onToggle}
    >
      {label}
      {activeCount > 0 && showBadge ? (
        <CounterBadge count={activeCount} size="small" />
      ) : null}
      <ChevronDownRegular aria-hidden="true" />
    </Button>
  );
}

export function FilterBar({
  query,
  onQueryChange,
  queryPlaceholder,
  queryLabel,
  clearLabel,
  filtersLabel,
  activeCount,
  chips,
  onReset,
  resetLabel,
  resultLabel,
  loading = false,
  showActiveBadge = true,
  showReset = true,
  inline = false,
  children,
}: FilterBarProps) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const panelId = useId();

  const resetDisabled = isFilterResetDisabled(activeCount, query, chips.length);
  const withToggle = showsFilterPanelToggle(Boolean(children), inline);
  const withChips = showsFilterChips(chips.length, showReset);

  return (
    <div className={inline ? "filter-bar filter-bar-inline" : "filter-bar"}>
      <div className="filter-row">
        <FilterSearch
          value={query}
          onChange={onQueryChange}
          placeholder={queryPlaceholder}
          label={queryLabel}
          clearLabel={clearLabel}
        />

        {withToggle ? (
          <FilterPanelToggle
            open={open}
            panelId={panelId}
            label={filtersLabel}
            activeCount={activeCount}
            showBadge={showActiveBadge}
            onToggle={() => setOpen((current) => !current)}
          />
        ) : inline ? (
          children
        ) : null}

        {resultLabel ? (
          <Text size={200} className={styles.result}>
            {resultLabel}
          </Text>
        ) : null}
      </div>

      {withChips ? (
        <FilterChipsRow
          chips={chips}
          showReset={showReset}
          resetDisabled={resetDisabled}
          resetLabel={resetLabel}
          onReset={onReset}
        />
      ) : null}

      {!inline && open && children ? (
        <div className="filter-panel" id={panelId}>
          {children}
        </div>
      ) : null}

      {loading ? (
        <div className="skeleton skeleton-row" aria-hidden="true" />
      ) : null}
    </div>
  );
}
