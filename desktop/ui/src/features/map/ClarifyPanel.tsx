import { useEffect, useState } from "react";
import { Button, Text } from "@fluentui/react-components";
import { DismissRegular } from "@fluentui/react-icons";
import { eventsApi, placesApi } from "../../api/client";
import type { PlaceSuggestion } from "../../api/types";
import { ErrorBanner } from "../../components/feedback";
import {
  normalizeError,
  type AppErrorEnvelope,
} from "../../lib/errors";
import type { Translate } from "../../lib/dates";
import { toApiDate } from "../timeline/adapter";
import { formatTimelineDate } from "../timeline/dates";
import { eventTypeLabel } from "../timeline/format";
import { formatPlacePoint, placePrecisionLabelKey } from "../events/placeGeo";
import type { UnresolvedPlace } from "./unresolved";
import "./map.css";

type ClarifyPanelProps = {
  places: UnresolvedPlace[];
  geocoderEnabled: boolean;
  onClose: () => void;
  onApplied: () => void;
  onManual: (place: UnresolvedPlace, eventIds: string[]) => void;
  t: Translate;
  tm: Translate;
};

type ClarifyFindButtonProps = {
  label: string;
  searchingLabel: string;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
};

/**
 * The Find action keeps one box in every state. Its label changes while the
 * provider is queried and Fluent disables the button, so the width must come
 * from the layout, not from the current word (issue #113).
 */
export function ClarifyFindButton({
  label,
  searchingLabel,
  loading,
  disabled,
  onClick,
}: ClarifyFindButtonProps) {
  return (
    <Button
      className="map-clarify-find"
      appearance="secondary"
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? searchingLabel : label}
    </Button>
  );
}

/**
 * Local list of events whose typed place has no point. The network is used only
 * by "Find"; every apply is one explicit, reviewed action (ADR-0020).
 */
export function ClarifyPanel({
  places,
  geocoderEnabled,
  onClose,
  onApplied,
  onManual,
  t,
  tm,
}: ClarifyPanelProps) {
  const [selected, setSelected] = useState<UnresolvedPlace | null>(null);
  const [candidates, setCandidates] = useState<PlaceSuggestion[]>([]);
  const [chosen, setChosen] = useState<PlaceSuggestion | null>(null);
  const [eventIds, setEventIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<AppErrorEnvelope | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // After a successful apply the parent reloads; keep the panel on the same
  // text, with the remaining events checked.
  useEffect(() => {
    if (!selected) return;
    const next = places.find((place) => place.key === selected.key) ?? null;
    if (next === null) {
      setSelected(null);
      setCandidates([]);
      setChosen(null);
      return;
    }
    setSelected(next);
    setEventIds(new Set(next.entries.map((entry) => entry.event.id)));
  }, [places]); // eslint-disable-line react-hooks/exhaustive-deps

  const resetDetail = () => {
    setCandidates([]);
    setChosen(null);
    setError(null);
    setMessage(null);
  };

  const open = (place: UnresolvedPlace) => {
    setSelected(place);
    setEventIds(new Set(place.entries.map((entry) => entry.event.id)));
    resetDetail();
  };

  const find = async () => {
    if (!selected) return;
    setLoading(true);
    setError(null);
    resetDetail();
    try {
      const items = await placesApi.suggest(selected.label);
      setCandidates(items);
      setChosen(items.find((item) => item.point) ?? null);
    } catch (caught) {
      setError(normalizeError(caught));
    } finally {
      setLoading(false);
    }
  };

  const apply = async () => {
    if (!selected || !chosen?.point) return;
    setApplying(true);
    setError(null);
    setMessage(null);
    try {
      const result = await eventsApi.applyPlaceGeo({
        eventIds: [...eventIds],
        expectedPlace: selected.label,
        point: chosen.point,
      });
      setMessage(
        result.applied > 0
          ? t("clarifyApplied", {
              applied: result.applied,
              skipped: result.skipped,
            })
          : t("clarifyNothingChanged"),
      );
      onApplied();
    } catch (caught) {
      setError(normalizeError(caught));
    } finally {
      setApplying(false);
    }
  };

  const toggle = (id: string, checked: boolean) => {
    setEventIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  return (
    <aside className="map-side-panel map-clarify" aria-label={t("clarifyTitle")}>
      <header className="map-side-head">
        <div>
          <Text weight="semibold">{t("clarifyTitle")}</Text>
          <Text size={200} className="map-muted">
            {selected ? selected.label : t("clarifyHint")}
          </Text>
        </div>
        <Button
          appearance="subtle"
          icon={<DismissRegular />}
          aria-label={t("close")}
          onClick={onClose}
        />
      </header>

      {selected === null ? (
        places.length === 0 ? (
          <p className="map-clarify-empty">{t("clarifyEmpty")}</p>
        ) : (
          <ul className="map-unresolved-list">
            {places.map((place) => (
              <li key={place.key}>
                <button
                  type="button"
                  className="map-unresolved-row"
                  onClick={() => open(place)}
                >
                  <span className="map-unresolved-label">{place.label}</span>
                  <span className="map-unresolved-count">
                    {t("event:count", { count: place.entries.length })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : (
        <>
          <div className="map-clarify-head">
            <Button appearance="subtle" size="small" onClick={() => setSelected(null)}>
              {t("clarifyBack")}
            </Button>
            <Text size={200} className="map-muted">
              {t("event:count", { count: selected.entries.length })}
            </Text>
          </div>
          <div className="map-clarify-body">
            {geocoderEnabled ? (
              <ClarifyFindButton
                label={t("clarifyFind")}
                searchingLabel={t("clarifySearching")}
                loading={loading}
                disabled={applying}
                onClick={() => void find()}
              />
            ) : (
              <Text size={200}>{t("clarifyGeocoderOff")}</Text>
            )}

            <ErrorBanner error={error} />

            {loading ? null : candidates.length > 0 ? (
              <ul className="map-candidate-list">
                {candidates.map((candidate, index) => (
                  <li key={`${candidate.source}-${index}`}>
                    <button
                      type="button"
                      className={
                        chosen === candidate
                          ? "map-candidate map-candidate-selected"
                          : "map-candidate"
                      }
                      onClick={() => setChosen(candidate)}
                      disabled={!candidate.point}
                    >
                      <span className="map-candidate-label">{candidate.label}</span>
                      <span className="map-candidate-meta">
                        {candidate.point
                          ? t(placePrecisionLabelKey(candidate.point.precision))
                          : t("clarifyNoPoint")}
                        {candidate.hint ? ` · ${candidate.hint}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : geocoderEnabled ? (
              <Text size={200} className="map-muted">
                {t("clarifyNoCandidates")}
              </Text>
            ) : null}

            {chosen?.point ? (
              <Text size={200} className="map-muted">
                {t("clarifyPoint", {
                  coords: formatPlacePoint(chosen.point),
                })}
              </Text>
            ) : null}

            <div className="map-clarify-events">
              <div className="map-clarify-events-head">
                <Text weight="semibold">{t("clarifyEvents")}</Text>
                <button
                  type="button"
                  className="map-link-button"
                  onClick={() =>
                    setEventIds(
                      new Set(selected.entries.map((entry) => entry.event.id)),
                    )
                  }
                >
                  {t("clarifySelectAll")}
                </button>
                <button
                  type="button"
                  className="map-link-button"
                  onClick={() => setEventIds(new Set())}
                >
                  {t("clarifySelectNone")}
                </button>
              </div>
              <ul className="map-clarify-event-list">
                {selected.entries.map((entry) => (
                  <li key={entry.event.id}>
                    <label className="map-clarify-event">
                      <input
                        type="checkbox"
                        checked={eventIds.has(entry.event.id)}
                        onChange={(event) =>
                          toggle(entry.event.id, event.target.checked)
                        }
                      />
                      <span className="map-clarify-event-date">
                        {formatTimelineDate(toApiDate(entry.event.date), tm)}
                      </span>
                      <span className="map-clarify-event-person">
                        {entry.personName}
                      </span>
                      <span className="map-clarify-event-type">
                        {eventTypeLabel(entry.event.type, tm)}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>

            {message ? (
              <Text size={200} className="map-clarify-message">
                {message}
              </Text>
            ) : null}

            <div className="map-clarify-actions">
              <Button
                appearance="primary"
                onClick={() => void apply()}
                disabled={!chosen?.point || eventIds.size === 0 || applying}
              >
                {t("clarifyApply")}
              </Button>
              <Button
                appearance="secondary"
                onClick={() => onManual(selected, [...eventIds])}
                disabled={eventIds.size === 0 || applying}
              >
                {t("clarifyManual")}
              </Button>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
