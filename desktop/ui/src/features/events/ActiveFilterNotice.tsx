// Always-visible reminder that the shared event filter is narrowing the list.
// The person/type/year values and the search text are shared by the Events, Map
// and Timeline screens and survive tab switches, so a stored filter can hide
// every event while its control is wrapped out of sight - the timeline has no
// search field and no year slider at all. The notice names what is active,
// including the year range, and offers one reset action (issue #107).

import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { Chip } from "../../components/ui/chip";
import "../../components/filters/filters.css";

export type ActiveFilterNoticeProps = {
  /** Person, type and year filters currently narrowing the list. */
  activeCount: number;
  fromYear?: string;
  toYear?: string;
  /** Shared search text; only a screen without its own search field needs it. */
  query?: string;
  /** Show the search chip. Off by default: a visible search field is its own indicator. */
  showQuery?: boolean;
  onReset?: () => void;
  /** `data-testid` of the notice; screens may override it. */
  testId?: string;
};

export function ActiveFilterNotice({
  activeCount,
  fromYear = "",
  toYear = "",
  query = "",
  showQuery = false,
  onReset,
  testId = "event-filters-active",
}: ActiveFilterNoticeProps) {
  const { t } = useTranslation("event");
  const search = showQuery ? query.trim() : "";
  if (onReset === undefined || (activeCount <= 0 && search === "")) {
    return null;
  }

  const from = fromYear.trim();
  const to = toYear.trim();
  const yearText =
    from !== "" && to !== ""
      ? t("filtersActiveYears", { from, to })
      : from !== ""
        ? t("chipYearFrom", { year: from })
        : to !== ""
          ? t("chipYearTo", { year: to })
          : "";

  return (
    <div className="event-filter-active" role="status" data-testid={testId}>
      {activeCount > 0 ? (
        <Chip tone="accent">{t("filtersActive", { count: activeCount })}</Chip>
      ) : null}
      {search !== "" ? (
        <Chip>{t("filtersActiveSearch", { query: search })}</Chip>
      ) : null}
      {yearText !== "" ? (
        <span className="event-filter-active-years">{yearText}</span>
      ) : null}
      <Button variant="secondary" size="sm" onClick={onReset}>
        {t("resetFilters")}
      </Button>
    </div>
  );
}
