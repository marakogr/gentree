import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Link,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Skeleton,
  SkeletonItem,
  Spinner,
  Subtitle1,
  Subtitle2,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { ArrowSyncRegular } from "@fluentui/react-icons";
import { useTranslation } from "react-i18next";
import { searchApi } from "../../api/client";
import type {
  SearchEntityType,
  SearchItem,
  SearchResponse,
  SourceEntity,
} from "../../api/types";
import { FilterBar, type FilterChipModel } from "../../components/filters/FilterBar";
import { TypeChips } from "../../components/filters/TypeChips";
import { EmptyState } from "../../components/ui/empty";
import { normalizeError, type AppErrorEnvelope } from "../../lib/errors";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { useScrollMemory, useViewState } from "../../lib/useViewState";
import {
  EVENT_SNIPPET_CODES,
  filterGroups,
  isSearchable,
  localizeEventSnippet,
  normalizeQuery,
  QUERY_DEBOUNCE_MS,
  resultCount,
  SEARCH_ENTITY_TYPES,
  SEARCH_TYPE_FILTER,
  searchTypeFilter,
  searchTypeFilters,
  segmentHighlights,
  similarBadgeCount,
  toggleSearchType,
} from "./helpers";
import "./search.css";

const PAGE_LIMIT = 20;

/** The query field is a search string, not a document: keep it short. */
const MAX_QUERY_LENGTH = 100;

type Props = {
  projectId: string;
  onOpenPerson: (personId: string) => void;
  onOpenEvent: (personId: string | null) => void;
};

const useStyles = makeStyles({
  hint: {
    margin: 0,
    color: tokens.colorNeutralForeground2,
  },
  skeleton: {
    display: "grid",
    gap: tokens.spacingVerticalXS,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
  },
  groupTitle: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    margin: 0,
  },
  results: {
    display: "grid",
    gap: tokens.spacingVerticalXS,
    margin: 0,
    padding: 0,
    listStyleType: "none",
  },
  // Fluent Card is a focus group by itself, so the row keeps one native
  // button as its only click and keyboard target.
  card: {
    padding: 0,
    overflow: "hidden",
    backgroundColor: tokens.colorNeutralBackground1,
  },
  result: {
    width: "100%",
    height: "auto",
    minHeight: "unset",
    justifyContent: "flex-start",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    textAlign: "left",
    whiteSpace: "normal",
    lineHeight: tokens.lineHeightBase300,
  },
  resultRow: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
    width: "100%",
  },
  snippet: {
    flex: 1,
    minWidth: 0,
  },
  sourceDetails: {
    display: "grid",
    gap: tokens.spacingVerticalS,
  },
  sourceHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
  },
  sourceTitle: {
    margin: 0,
  },
});

export default function SearchPage({
  projectId,
  onOpenPerson,
  onOpenEvent,
}: Props) {
  const { t } = useTranslation(["search", "common"]);
  const { state, patch } = useViewState(projectId, "search");
  const styles = useStyles();

  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AppErrorEnvelope | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [rebuilding, setRebuilding] = useState(false);

  const [expandedSource, setExpandedSource] = useState<string | null>(null);
  const expandedRef = useRef<string | null>(null);
  const [sourceDetail, setSourceDetail] = useState<SourceEntity | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState<AppErrorEnvelope | null>(null);

  const selectedTypes = useMemo(
    () => searchTypeFilter(state.filters),
    [state.filters],
  );

  // The input is the persisted query; a pause (or Enter) decides when it is
  // sent. Enter only skips the wait for the current value.
  const debouncedInput = useDebouncedValue(state.query, QUERY_DEBOUNCE_MS);
  const [enteredQuery, setEnteredQuery] = useState<string | null>(null);
  const normalizedInput = normalizeQuery(state.query);
  const query =
    normalizedInput === null
      ? null
      : enteredQuery !== null && enteredQuery === normalizedInput
        ? enteredQuery
        : normalizeQuery(debouncedInput);

  useEffect(() => {
    if (!isSearchable(query ?? "")) {
      setResponse(null);
      setError(null);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    void searchApi
      .query(query ?? "", PAGE_LIMIT)
      .then((result) => {
        if (active) setResponse(result);
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(normalizeError(caught));
          setResponse(null);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, query, refreshToken]);

  const setExpanded = (sourceId: string | null) => {
    expandedRef.current = sourceId;
    setExpandedSource(sourceId);
  };

  useEffect(() => {
    if (expandedSource === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expandedSource]);

  const submit = () => {
    const next = normalizeQuery(state.query);
    if (next === null) return;
    setEnteredQuery(next);
    setRefreshToken((token) => token + 1);
  };

  const rebuild = async () => {
    setRebuilding(true);
    setError(null);
    try {
      await searchApi.rebuild();
      setRefreshToken((token) => token + 1);
    } catch (caught) {
      setError(normalizeError(caught));
    } finally {
      setRebuilding(false);
    }
  };

  const loadSource = async (sourceId: string) => {
    setSourceDetail(null);
    setSourceError(null);
    setSourceLoading(true);
    try {
      const detail = await searchApi.sourceDetails(sourceId);
      if (expandedRef.current === sourceId) setSourceDetail(detail);
    } catch (caught) {
      if (expandedRef.current === sourceId) {
        setSourceError(normalizeError(caught));
      }
    } finally {
      if (expandedRef.current === sourceId) setSourceLoading(false);
    }
  };

  const toggleSource = (sourceId: string) => {
    if (expandedRef.current === sourceId) {
      setExpanded(null);
      return;
    }
    setExpanded(sourceId);
    void loadSource(sourceId);
  };

  const openItem = (item: SearchItem) => {
    if (item.entityType === "person") {
      onOpenPerson(item.entityId);
      return;
    }
    if (item.entityType === "event") {
      onOpenEvent(item.personId ?? null);
      return;
    }
    void toggleSource(item.entityId);
  };

  const setTypes = (types: readonly SearchEntityType[]) => {
    patch({
      filters: { ...state.filters, [SEARCH_TYPE_FILTER]: searchTypeFilters(types) },
    });
  };

  const toggleType = (type: SearchEntityType) => {
    setTypes(toggleSearchType(selectedTypes, type));
  };

  const updateQuery = (value: string) => {
    patch({ query: value.slice(0, MAX_QUERY_LENGTH) });
  };

  const resetFilters = () => {
    setEnteredQuery(null);
    patch({ query: "", filters: {} });
  };

  const resetTypes = () => {
    patch({ filters: { ...state.filters, [SEARCH_TYPE_FILTER]: [] } });
  };

  const saveScroll = useCallback(
    (value: number) => patch({ scrollTop: value }),
    [patch],
  );

  const idle = !isSearchable(query ?? "");
  const groups = filterGroups(response, selectedTypes);
  const shownCount = resultCount(response, selectedTypes);
  const retry = () => setRefreshToken((token) => token + 1);
  const ready = !loading && (idle || response !== null || error !== null);
  const scrollRef = useScrollMemory({
    scrollTop: state.scrollTop,
    onScrollTop: saveScroll,
    ready,
  });

  const typeLabels = (type: SearchEntityType) => t(`search:groups.${type}`);
  const chips: FilterChipModel[] = [];
  const trimmedQuery = state.query.trim();
  if (trimmedQuery !== "") {
    chips.push({
      id: "query",
      label: t("search:chips.query", { value: trimmedQuery }),
      removeLabel: t("search:chips.removeQuery"),
      onRemove: () => updateQuery(""),
    });
  }
  for (const type of selectedTypes) {
    chips.push({
      id: `type:${type}`,
      label: t("search:chips.type", { type: typeLabels(type) }),
      removeLabel: t("search:chips.removeType", { type: typeLabels(type) }),
      onRemove: () => toggleType(type),
    });
  }

  return (
    <section className="panel search-page">
      <div className="card-head">
        <h1 className="page-title">{t("search:title")}</h1>
        <Button
          appearance="subtle"
          size="small"
          disabled={rebuilding}
          aria-busy={rebuilding || undefined}
          icon={
            rebuilding ? (
              <Spinner size="tiny" aria-hidden="true" />
            ) : (
              <ArrowSyncRegular aria-hidden="true" />
            )
          }
          onClick={() => void rebuild()}
          title={t("search:rebuild")}
        >
          {rebuilding ? t("search:rebuilding") : t("search:rebuild")}
        </Button>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div data-tour="search-input">
          <FilterBar
            query={state.query}
            onQueryChange={updateQuery}
            queryPlaceholder={t("search:placeholder")}
            queryLabel={t("search:label")}
            clearLabel={t("search:filters.clearSearch")}
            filtersLabel={t("search:filters.title")}
            activeCount={chips.length}
            chips={chips}
            onReset={resetFilters}
            resetLabel={t("search:filters.reset")}
            resultLabel={
              response !== null
                ? t("search:resultCount", {
                    shown: shownCount,
                    total: response.matchCount,
                  })
                : undefined
            }
            loading={loading}
          >
            <TypeChips
              options={SEARCH_ENTITY_TYPES.map((type) => ({
                id: type,
                label: typeLabels(type),
              }))}
              selected={selectedTypes}
              onToggle={(id) => toggleType(id as SearchEntityType)}
              legend={t("search:filters.typeLegend")}
            />
          </FilterBar>
        </div>
      </form>

      <Text as="p" size={200} className={styles.hint}>
        {t("search:hint")}
      </Text>

      {error ? <SearchErrorBar error={error} onRetry={retry} /> : null}

      {loading ? (
        <div className={styles.skeleton} aria-hidden="true">
          <Skeleton size={32}>
            <SkeletonItem size={32} />
            <SkeletonItem size={32} />
            <SkeletonItem size={32} />
          </Skeleton>
        </div>
      ) : null}

      {ready && idle ? <EmptyState compact text={t("search:idle")} /> : null}

      {ready && !idle && response && response.matchCount === 0 ? (
        <EmptyState compact text={t("search:empty")} />
      ) : null}

      {ready && !idle && response && response.matchCount > 0 && groups.length === 0 ? (
        <EmptyState
          compact
          text={t("search:noTypeResults")}
          actionLabel={t("search:filters.reset")}
          onAction={resetTypes}
        />
      ) : null}

      {ready && !idle && groups.length > 0 ? (
        <div className="search-scroll" ref={scrollRef} data-testid="search-scroll">
          {response ? (
            <Text as="p" size={200} className={styles.hint}>
              {response.truncated
                ? t("search:truncated", { shown: shownCount })
                : t("search:results", { count: shownCount })}
            </Text>
          ) : null}

          {groups.map((group) => (
            <section
              key={group.entityType}
              className="search-group"
              aria-labelledby={`search-group-${group.entityType}`}
            >
              <Subtitle1
                as="h3"
                id={`search-group-${group.entityType}`}
                className={styles.groupTitle}
              >
                {t(`search:groups.${group.entityType}`)}
                <Badge appearance="tint" size="small">
                  {t("search:groupCount", { count: group.count })}
                </Badge>
              </Subtitle1>
              <ul className={styles.results}>
                {group.items.map((item) => {
                  const expanded =
                    item.entityType === "source" &&
                    expandedSource === item.entityId;
                  const similar = similarBadgeCount(item);
                  const similarLabel =
                    similar === null
                      ? null
                      : t("search:similarCount", { count: similar });
                  const openLabel = t("search:openResult", {
                    type: t(`search:groups.${item.entityType}`),
                    snippet: item.snippet || t("search:noSnippet"),
                  });
                  return (
                    <li key={`${item.entityType}:${item.entityId}`}>
                      <Card
                        appearance="outline"
                        size="small"
                        className={styles.card}
                      >
                        <Button
                          appearance="transparent"
                          className={styles.result}
                          aria-expanded={
                            item.entityType === "source" ? expanded : undefined
                          }
                          aria-label={
                            similarLabel === null
                              ? openLabel
                              : `${openLabel} \u2014 ${similarLabel}`
                          }
                          onClick={() => openItem(item)}
                        >
                          <span className={styles.resultRow}>
                            <Snippet item={item} className={styles.snippet} />
                            {similarLabel === null ? null : (
                              <Badge
                                appearance="tint"
                                color="informative"
                                size="small"
                                className="search-similar"
                              >
                                {similarLabel}
                              </Badge>
                            )}
                          </span>
                        </Button>
                      </Card>
                      {expanded ? (
                        <SourceDetails
                          detail={sourceDetail}
                          loading={sourceLoading}
                          error={sourceError}
                          onClose={() => setExpanded(null)}
                          onRetry={() => void loadSource(item.entityId)}
                        />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function Snippet({
  item,
  className,
}: {
  item: SearchItem;
  className?: string;
}) {
  const { t } = useTranslation("enums");
  const labels = Object.fromEntries(
    EVENT_SNIPPET_CODES.map((code) => [
      code,
      t(`eventType.${code.toUpperCase()}`),
    ]),
  );
  const localized =
    item.entityType === "event"
      ? localizeEventSnippet(item.snippet, item.highlights, labels)
      : { text: item.snippet, highlights: item.highlights };
  return (
    <span className={className ? `snippet ${className}` : "snippet"}>
      {segmentHighlights(localized.text, localized.highlights).map(
        (segment, index) =>
          segment.highlighted ? (
            <mark key={index}>{segment.text}</mark>
          ) : (
            <span key={index}>{segment.text}</span>
          ),
      )}
    </span>
  );
}

/** Shared inline error + retry for the result list and the source panel. */
function SearchErrorBar({
  error,
  onRetry,
}: {
  error: AppErrorEnvelope | null;
  onRetry: () => void;
}) {
  const { t } = useTranslation(["search", "common"]);
  if (!error) return null;
  return (
    <MessageBar intent="error">
      <MessageBarBody>
        {t(`errors.${error.code}`, {
          defaultValue: t("errors.UNKNOWN"),
        })}
      </MessageBarBody>
      <MessageBarActions>
        <Button appearance="secondary" size="small" onClick={onRetry}>
          {t("search:retry")}
        </Button>
      </MessageBarActions>
    </MessageBar>
  );
}

function SourceDetails({
  detail,
  loading,
  error,
  onClose,
  onRetry,
}: {
  detail: SourceEntity | null;
  loading: boolean;
  error: AppErrorEnvelope | null;
  onClose: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation(["search", "common"]);
  const styles = useStyles();
  const url = safeHttpUrl(detail?.url ?? null);

  return (
    <Card
      appearance="filled-alternative"
      size="small"
      className={styles.sourceDetails}
    >
      <div className={styles.sourceHead}>
        <Subtitle2 as="h4" className={styles.sourceTitle}>
          {t("search:sourceDetails")}
        </Subtitle2>
        <Button appearance="subtle" size="small" onClick={onClose}>
          {t("common:actions.close")}
        </Button>
      </div>

      {loading ? (
        <Text as="p" size={200} className={styles.hint}>
          {t("common:loading")}
        </Text>
      ) : null}
      <SearchErrorBar error={error} onRetry={onRetry} />

      {detail ? (
        <dl className="facts">
          <dt>{t("search:fields.title")}</dt>
          <dd>{detail.title}</dd>
          <dt>{t("search:fields.author")}</dt>
          <dd>{detail.author ?? "\u2014"}</dd>
          <dt>{t("search:fields.publication")}</dt>
          <dd>{detail.publication ?? "\u2014"}</dd>
          <dt>{t("search:fields.repository")}</dt>
          <dd>{detail.repository ?? "\u2014"}</dd>
          <dt>{t("search:fields.url")}</dt>
          <dd>
            {url ? (
              <Link href={url} target="_blank" rel="noreferrer">
                {detail.url}
              </Link>
            ) : (
              (detail.url ?? "\u2014")
            )}
          </dd>
          <dt>{t("search:fields.notes")}</dt>
          <dd>{detail.notes ?? "\u2014"}</dd>
        </dl>
      ) : null}
    </Card>
  );
}

/** Only http(s) links become anchors; anything else stays literal text. */
function safeHttpUrl(value: string | null): string | null {
  return value && /^https?:\/\//i.test(value) ? value : null;
}
