// Shared filter bar: live search, filter chips, one reset action and the
// "found N of M" counter. Used by persons, events, search and timeline.

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
  inline = false,
  children,
}: FilterBarProps) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const panelId = useId();

  const search = (
    <div className="filter-search">
      <SearchBox
        className={styles.search}
        value={query}
        placeholder={queryPlaceholder}
        aria-label={queryLabel}
        contentBefore={<SearchRegular aria-hidden="true" />}
        dismiss={{
          "aria-label": clearLabel,
          title: clearLabel,
          // Fluent keeps the dismiss slot mounted; hide it while the field is
          // empty so no pointless clear button appears on focus.
          style: query === "" ? { display: "none" } : undefined,
        }}
        onChange={(_, data) => onQueryChange(data.value)}
      />
    </div>
  );

  const resetDisabled = activeCount === 0 && query === "" && chips.length === 0;

  const chipsRow = (
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
      <FluentButton
        appearance="transparent"
        size="small"
        onClick={onReset}
        disabled={resetDisabled}
      >
        {resetLabel}
      </FluentButton>
    </div>
  );

  return (
    <div className={inline ? "filter-bar filter-bar-inline" : "filter-bar"}>
      <div className="filter-row">
        {search}

        {inline ? (
          children
        ) : children ? (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((current) => !current)}
          >
            {filtersLabel}
            {activeCount > 0 ? (
              <CounterBadge count={activeCount} size="small" />
            ) : null}
            <ChevronDownRegular aria-hidden="true" />
          </Button>
        ) : null}

        {resultLabel ? (
          <Text size={200} className={styles.result}>
            {resultLabel}
          </Text>
        ) : null}
      </div>

      {chipsRow}

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
