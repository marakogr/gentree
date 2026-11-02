import { useMemo, useState, type FormEvent } from "react";
import {
  AddRegular,
  InfoRegular,
  LinkRegular,
  PersonAddRegular,
} from "@fluentui/react-icons";
import { useTranslation } from "react-i18next";
import {
  Input,
  Radio,
  RadioGroup,
  Select,
  Textarea,
} from "@fluentui/react-components";
import { eventsApi } from "../../api/client";
import type {
  DatePrecision,
  DateQualifier,
  EventEntity,
  EventType,
  Person,
  Versioned,
} from "../../api/types";
import { ErrorBanner } from "../../components/feedback";
import { Button } from "../../components/ui/button";
import { Combobox } from "../../components/ui/combobox";
import { DateWheel } from "../../components/ui/date-wheel";
import { Dialog } from "../../components/ui/dialog";
import { Field } from "../../components/ui/field";
import {
  fieldErrors,
  normalizeError,
  pickFieldError,
  type AppErrorEnvelope,
  type FieldErrors,
} from "../../lib/errors";
import { useDateFormatter } from "../../lib/useDateFormatter";
import { displayName } from "../persons/helpers";
import {
  CUSTOM_EVENT_TYPE_PREFIX,
  EVENT_TYPES,
  buildEventInput,
  draftFromEvent,
  emptyEventDraft,
  eventDateLabel,
  eventTypeLabel,
  eventTypeSelectionValue,
  isEventDraftDirty,
  parseDraftDateValue,
  readEventTypeSelection,
  type EventDraft,
} from "./helpers";
import { resolveEventFields, retainDetailsForTypeChange } from "./fields";
import { layoutEventFields } from "./fieldLayout";
import {
  dateModeKeys,
  isPairedEventType,
  personPlaceholderKey,
  personRoleKey,
  placePlaceholderKey,
} from "./eventRoles";
import { supportsDateRange } from "./datePeriod";
import { useEventConfig } from "./useEventConfig";
import { PlaceAutocomplete } from "./PlaceAutocomplete";
import { formatPlacePoint, placePrecisionLabelKey } from "./placeGeo";
import EventFiles from "./EventFiles";
import "./events.css";

const FORM_ID = "event-form";

const PRECISIONS: readonly DatePrecision[] = [
  "DAY",
  "MONTH",
  "YEAR",
  "UNKNOWN",
];

/** Offered qualifiers; a stored legacy qualifier is appended while editing. */
const QUALIFIERS: readonly DateQualifier[] = ["EXACT", "APPROXIMATE"];

/** Request to create an event of another type for the same person. */
export type RelatedEventRequest = { type: EventType; personId: string };

type Props = {
  initial: EventEntity | null;
  version: string | null;
  persons: readonly { entity: Person }[];
  defaultPersonId?: string;
  /** Type of a new event, e.g. a burial created from a death event. */
  defaultType?: EventType;
  onSaved: (saved: Versioned<EventEntity>) => void;
  onCancel: () => void;
  onReload: () => void;
  /** Called when the event's stored files change (attach/detach/caption). */
  onFilesChanged?: () => void;
  /** Called after a successful delete, so the parent closes the form. */
  onDeleted?: (id: string) => void;
  /** Wired by the shell later; hidden while absent. */
  onRequestNewPerson?: () => void;
  /** Opens creation of a related event; unavailable while editing is dirty. */
  onCreateRelated?: (request: RelatedEventRequest) => void;
};

export default function EventForm({
  initial,
  version,
  persons,
  defaultPersonId,
  defaultType,
  onSaved,
  onCancel,
  onReload,
  onFilesChanged,
  onDeleted,
  onRequestNewPerson,
  onCreateRelated,
}: Props) {
  const { t } = useTranslation(["event", "common", "enums", "person"]);
  const formatDate = useDateFormatter();

  const [draft, setDraft] = useState<EventDraft>(() => {
    if (initial) return draftFromEvent(initial);
    const preselected =
      defaultPersonId && defaultPersonId !== ""
        ? defaultPersonId
        : persons.length === 1
          ? persons[0].entity.id
          : "";
    return emptyEventDraft(preselected, defaultType ?? "BIRTH");
  });
  // The qualifier the user chose before switching to a period. A RANGE date
  // must carry `RANGE`, but returning to a single date restores the choice
  // instead of silently resetting it to EXACT.
  const [singleQualifier, setSingleQualifier] = useState<DateQualifier>(() =>
    draft.qualifier === "RANGE" ? "EXACT" : draft.qualifier,
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<AppErrorEnvelope | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [touchedDate, setTouchedDate] = useState(false);
  const [touchedPerson, setTouchedPerson] = useState(false);
  const [touchedSpouse, setTouchedSpouse] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  // Deletion stays inside this dialog: opening a second modal over the form
  // would hide the form and its unsaved state under two overlays.
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Custom type names and detail-field groups live in the global config; the
  // form reads them itself so the events screen does not pass config down. A
  // missing settings backend leaves built-in types and keys usable.
  const { customTypes, fieldGroups, geocoderEnabled, historicalEnabled } =
    useEventConfig();

  const update = (patch: Partial<EventDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const fieldLabel = (key: string) => t(`event:fields.${key}`);
  const fieldSpecs = useMemo(
    () =>
      resolveEventFields(
        draft.eventType,
        draft.originalType,
        fieldGroups,
        (key) => t(`event:fields.${key}`),
      ),
    // `t` changes with the language, so localized built-in labels refresh.
    [draft.eventType, draft.originalType, fieldGroups, t],
  );
  const fieldCells = useMemo(
    () => layoutEventFields(draft.eventType, fieldSpecs),
    [draft.eventType, fieldSpecs],
  );

  // Stored keys the current type does not describe (another config, a removed
  // key, a legacy import). They stay editable and are saved back unchanged.
  const extraEntries = useMemo(() => {
    const known = new Set(fieldSpecs.map((spec) => spec.key));
    return Object.entries(draft.details).filter(([key]) => !known.has(key));
  }, [draft.details, fieldSpecs]);

  const updateDetail = (key: string, value: string) => {
    setDraft((current) => ({
      ...current,
      details: { ...current.details, [key]: value },
    }));
  };

  const changeType = (selection: string) => {
    const next = readEventTypeSelection(selection, customTypes);
    const nextKeys = resolveEventFields(
      next.eventType,
      next.originalType,
      fieldGroups,
      fieldLabel,
    ).map((spec) => spec.key);
    const details = retainDetailsForTypeChange(
      fieldSpecs.map((spec) => spec.key),
      nextKeys,
      draft.details,
    );
    // A type without a period never keeps the period mode (and its RANGE
    // qualifier) active, so the saved date cannot silently change shape.
    const leaveRange = !supportsDateRange(next.eventType);
    // Education reads as "graduation year"; an empty date starts at year
    // precision so the label and the control agree. A filled date is untouched.
    const blankDate = draft.date.trim() === "" && draft.dateEnd.trim() === "";
    update({
      ...next,
      details,
      ...(leaveRange && draft.dateMode === "range"
        ? {
            dateMode: "single" as const,
            qualifier: singleQualifier,
          }
        : {}),
      ...(next.eventType === "EDUCATION" && blankDate
        ? { precision: "YEAR" as const }
        : {}),
    });
  };

  const personItems = useMemo(() => {
    const items = persons.map((item) => ({
      id: item.entity.id,
      label: displayName(item.entity, t("person:unknownName")),
    }));
    // A person outside the fetched page must still show its id in the field
    // instead of an empty combobox while editing.
    if (
      draft.personId !== "" &&
      !items.some((item) => item.id === draft.personId)
    ) {
      items.push({
        id: draft.personId,
        label: t("person:unknownName"),
      });
    }
    return items;
  }, [persons, draft.personId, t]);

  const spouseItems = useMemo(() => {
    const items = personItems.filter((item) => item.id !== draft.personId);
    if (
      draft.spouseId !== "" &&
      !items.some((item) => item.id === draft.spouseId)
    ) {
      const source = personItems.find((item) => item.id === draft.spouseId);
      items.push(source ?? { id: draft.spouseId, label: t("person:unknownName") });
    }
    return items;
  }, [personItems, draft.personId, draft.spouseId, t]);

  const qualifierOptions = useMemo(() => {
    const options: DateQualifier[] = [...QUALIFIERS];
    if (!options.includes(draft.qualifier)) options.push(draft.qualifier);
    return options;
  }, [draft.qualifier]);

  // Period mode is only meaningful for a range-capable type and a known
  // precision; everything else falls back to the historical single field.
  const rangeAvailable =
    supportsDateRange(draft.eventType) && draft.precision !== "UNKNOWN";
  const dateMode: "single" | "range" =
    rangeAvailable && draft.dateMode === "range" ? "range" : "single";
  const modeKeys = dateModeKeys(draft.eventType);

  const formatPlaceholder =
    draft.precision === "MONTH"
      ? t("event:datePlaceholderMonth")
      : draft.precision === "YEAR"
        ? t("event:datePlaceholderYear")
        : draft.precision === "UNKNOWN"
          ? t("event:datePlaceholderUnknown")
          : t("event:datePlaceholder");
  const datePlaceholder =
    draft.precision === "UNKNOWN"
      ? t("event:datePlaceholderUnknown")
      : t("event:datePlaceholderEmpty");

  const dateResult = parseDraftDateValue({ ...draft, dateMode });
  const dateValid = dateResult.ok;
  const dateError = dateResult.ok
    ? null
    : dateResult.reason === "incomplete"
      ? t("event:errors.dateIncomplete")
      : dateResult.reason === "order"
        ? t("event:errors.dateOrder")
        : t("event:errors.dateFormat", { format: formatPlaceholder });

  const paired = isPairedEventType(draft.eventType);
  const personMissing = draft.personId === "";
  // Only a new paired event (or editing one that already has a second
  // participant) requires both people. A legacy one-participant marriage or
  // divorce stays editable without a forced second person.
  const secondRequired =
    paired && (!initial || (initial.participantIds ?? []).length > 0);
  const secondMissing =
    secondRequired &&
    (draft.spouseId === "" || draft.spouseId === draft.personId);
  const noPersons = persons.length === 0;
  const submitDisabled =
    noPersons || personMissing || secondMissing || !dateValid;
  const disabledReason = noPersons
    ? t("event:noPersons")
    : personMissing
      ? t("event:errors.personRequired")
      : secondMissing
        ? t("event:errors.participantRequired")
        : dateError ?? undefined;

  const personServerError = pickFieldError(errors, "personId", "person");
  const spouseServerError = pickFieldError(
    errors,
    "participantIds",
    "participant",
  );
  const dateServerError = pickFieldError(errors, "date");
  const placeServerError = pickFieldError(errors, "place");

  const serverFieldMessage = (code: string) =>
    t(`common:errors.${code}`, { defaultValue: t("common:errors.UNKNOWN") });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    setError(null);
    setStale(false);

    const built = buildEventInput(draft, initial ?? undefined);
    if (!built.ok) {
      const next: FieldErrors = {};
      if (built.fields.date) next.date = "VALIDATION_ERROR";
      if (built.fields.personId) next.personId = "VALIDATION_ERROR";
      if (built.fields.participantIds) {
        next.participantIds = "VALIDATION_ERROR";
      }
      setErrors(next);
      return;
    }

    setErrors({});
    setBusy(true);
    try {
      const saved =
        initial && version
          ? await eventsApi.update(built.event, version)
          : await eventsApi.create(built.event);
      onSaved(saved);
    } catch (caught) {
      const normalized = normalizeError(caught);
      if (normalized.code === "STALE_WRITE") {
        setStale(true);
      } else {
        setError(normalized);
        setErrors(fieldErrors(normalized));
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!initial || !version) return;
    setBusy(true);
    setError(null);
    setStale(false);
    try {
      await eventsApi.delete(initial.id, version);
      if (onDeleted) onDeleted(initial.id);
      else onCancel();
    } catch (caught) {
      const normalized = normalizeError(caught);
      if (normalized.code === "STALE_WRITE") {
        // Return to the editable form so the stale banner is visible there.
        setStale(true);
        setConfirmDelete(false);
      } else {
        setError(normalized);
      }
    } finally {
      setBusy(false);
    }
  };

  const dateFieldError =
    touchedDate || submitted
      ? (dateError ?? (dateServerError ? serverFieldMessage(dateServerError) : null))
      : dateServerError
        ? serverFieldMessage(dateServerError)
        : null;

  const dirty = initial ? isEventDraftDirty(draft, initial) : false;
  const typeLabel = eventTypeLabel(
    draft.eventType,
    draft.originalType,
    t,
  );
  const title = initial
    ? t("event:titleEdit", { type: typeLabel })
    : t("event:titleNew", { type: typeLabel });
  const primaryRole = t(`event:${personRoleKey(draft.eventType)}`);
  const primaryPlaceholder = t(
    `event:${personPlaceholderKey(draft.eventType)}`,
  );
  const secondaryRole = t(`event:${personRoleKey(draft.eventType, "secondary")}`);
  const topPlaceholderKey = placePlaceholderKey(draft.eventType);
  const placeLabel =
    draft.eventType === "RESIDENCE"
      ? t("event:placePlaceholderCity")
      : t("event:place");
  const placePlaceholder = topPlaceholderKey
    ? t(`event:${topPlaceholderKey}`)
    : t("event:place");
  // A point is only meaningful for a non-empty place. Without one the event is
  // saved but stays off the map (ADR-0020). A historical name keeps its typed
  // text; the provider's modern label is shown next to the coordinates.
  const modernPlaceName = draft.placeGeo?.label?.trim() ?? "";
  const placeHint = draft.placeGeo
    ? `${t("event:placePointChosen", {
        coords: formatPlacePoint(draft.placeGeo),
        precision: t(placePrecisionLabelKey(draft.placeGeo.precision)),
      })}${
        modernPlaceName !== "" && modernPlaceName !== draft.place.trim()
          ? ` · ${t("event:placeModernName", { name: modernPlaceName })}`
          : ""
      }`
    : draft.place.trim() !== ""
      ? t("event:placePointMissing")
      : undefined;

  const setDateMode = (next: "single" | "range") => {
    setTouchedDate(true);
    if (next === "range") {
      if (draft.qualifier !== "RANGE") setSingleQualifier(draft.qualifier);
      update({ dateMode: "range", qualifier: "RANGE" });
      return;
    }
    update({ dateMode: "single", qualifier: singleQualifier });
  };

  const footer = confirmDelete ? (
    <>
      <Button
        variant="secondary"
        onClick={() => setConfirmDelete(false)}
        disabled={busy}
      >
        {t("common:actions.cancel")}
      </Button>
      <Button
        variant="danger"
        loading={busy}
        onClick={() => void remove()}
      >
        {t("common:actions.delete")}
      </Button>
    </>
  ) : initial ? (
    <div className="events-dialog-footer">
      <Button
        variant="ghost"
        className="events-delete-link"
        style={{ color: "var(--destructive)" }}
        disabled={busy}
        onClick={() => {
          setError(null);
          setStale(false);
          setConfirmDelete(true);
        }}
      >
        {t("event:deleteEvent")}
      </Button>
      <div className="events-dialog-footer-actions">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          {t("common:actions.cancel")}
        </Button>
        <Button
          type="submit"
          form={FORM_ID}
          variant="primary"
          loading={busy}
          disabled={submitDisabled}
          disabledReason={disabledReason}
        >
          {t("common:actions.save")}
        </Button>
      </div>
    </div>
  ) : (
    <>
      <Button variant="secondary" onClick={onCancel} disabled={busy}>
        {t("common:actions.cancel")}
      </Button>
      <Button
        type="submit"
        form={FORM_ID}
        variant="primary"
        loading={busy}
        disabled={submitDisabled}
        disabledReason={disabledReason}
      >
        {t("common:actions.create")}
      </Button>
    </>
  );

  return (
    <Dialog
      open
      title={confirmDelete ? t("event:deleteTitle") : title}
      onClose={() => {
        if (confirmDelete) setConfirmDelete(false);
        else onCancel();
      }}
      busy={busy}
      size="lg"
      footer={footer}
    >
      {confirmDelete ? (
        <p className="meta">
          {t("event:deleteBody", {
            type: typeLabel,
            date: initial ? eventDateLabel(initial.date, formatDate) : "",
          })}
        </p>
      ) : (
        <form
          id={FORM_ID}
          className="events-dialog-form"
          onSubmit={submit}
          aria-busy={busy || undefined}
          noValidate
        >
          {stale ? (
            <div className="error-block" role="alert">
              <p className="error">{t("common:errors.STALE_WRITE")}</p>
              <p className="meta">{t("event:conflict")}</p>
              <Button size="sm" onClick={onReload} disabled={busy}>
                {t("common:actions.reload")}
              </Button>
            </div>
          ) : null}

          <ErrorBanner error={error} />

          {noPersons ? (
            <div className="events-dialog-note">
              <InfoRegular aria-hidden="true" />
              <div>
                <p>{t("event:noPersonsHint")}</p>
                {onRequestNewPerson ? (
                  <div className="events-dialog-note-actions">
                    <Button size="sm" onClick={onRequestNewPerson}>
                      <PersonAddRegular fontSize={16} aria-hidden="true" />
                      {t("event:createPerson")}
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="events-form-grid">
            <div className="events-form-span">
              <Field
                label={primaryRole}
                htmlFor="event-person"
                required
                error={
                  (touchedPerson || submitted) && personMissing
                    ? t("event:errors.personRequired")
                    : personServerError
                      ? serverFieldMessage(personServerError)
                      : null
                }
              >
                <Combobox
                  id="event-person"
                  items={personItems}
                  value={draft.personId}
                  onChange={(personId) => {
                    setTouchedPerson(true);
                    update({
                      personId,
                      ...(draft.spouseId === personId ? { spouseId: "" } : {}),
                    });
                  }}
                  placeholder={primaryPlaceholder}
                  ariaLabel={primaryRole}
                  clearLabel={t("event:clearPerson")}
                  emptyLabel={t("event:noPersonMatches")}
                  disabled={busy || noPersons}
                />
              </Field>
            </div>

            {paired ? (
              <>
                <div className="events-form-span">
                  <Field
                    label={secondaryRole}
                    htmlFor="event-spouse"
                    required={secondRequired}
                    error={
                      (touchedSpouse || submitted) && secondMissing
                        ? t("event:errors.participantRequired")
                        : spouseServerError
                          ? serverFieldMessage(spouseServerError)
                          : null
                    }
                  >
                    <Combobox
                      id="event-spouse"
                      items={spouseItems}
                      value={draft.spouseId}
                      onChange={(spouseId) => {
                        setTouchedSpouse(true);
                        update({ spouseId });
                      }}
                      placeholder={t("event:personPlaceholderSpouse")}
                      ariaLabel={secondaryRole}
                      clearLabel={t("event:clearSpouse")}
                      emptyLabel={t("event:noPersonMatches")}
                      disabled={busy || spouseItems.length === 0}
                    />
                  </Field>
                </div>
                <div className="events-form-span">
                  <p className="events-link-badge">
                    <LinkRegular aria-hidden="true" />
                    <span>{t("event:participantsLinked")}</span>
                  </p>
                </div>
              </>
            ) : null}

            <Field label={t("event:type")} htmlFor="event-type">
              <Select
                id="event-type"
                value={eventTypeSelectionValue(
                  draft.eventType,
                  draft.originalType,
                  customTypes,
                )}
                disabled={busy}
                onChange={(event) => changeType(event.target.value)}
              >
                {EVENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`enums:eventType.${type}`)}
                  </option>
                ))}
                {customTypes.map((name) => (
                  <option
                    key={`${CUSTOM_EVENT_TYPE_PREFIX}${name}`}
                    value={`${CUSTOM_EVENT_TYPE_PREFIX}${name}`}
                  >
                    {name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label={placeLabel}
              htmlFor="event-place"
              error={placeServerError ? serverFieldMessage(placeServerError) : null}
              hint={placeHint}
            >
              <PlaceAutocomplete
                id="event-place"
                value={draft.place}
                enabled={geocoderEnabled || historicalEnabled}
                disabled={busy}
                placeholder={placePlaceholder}
                ariaLabel={placeLabel}
                onChange={(place, point) =>
                  update({ place, placeGeo: point ?? null })
                }
              />
            </Field>

            <div
              className="events-date-card"
              role="group"
              aria-label={t("event:dateGroup")}
            >
              {modeKeys !== null && draft.precision !== "UNKNOWN" ? (
                <div className="events-date-head">
                  <RadioGroup
                    layout="horizontal"
                    value={dateMode}
                    disabled={busy}
                    aria-label={t("event:dateModeLabel")}
                    onChange={(_event, data) =>
                      setDateMode(data.value as "single" | "range")
                    }
                  >
                    <Radio
                      value="single"
                      label={t(`event:${modeKeys.single}`)}
                    />
                    <Radio
                      value="range"
                      label={t(`event:${modeKeys.range}`)}
                    />
                  </RadioGroup>
                </div>
              ) : null}

              <div
                className={
                  dateMode === "range"
                    ? "events-date-grid events-date-grid-range"
                    : "events-date-grid"
                }
              >
                {dateMode === "range" ? (
                  <>
                    <Field
                      label={t("event:from")}
                      htmlFor="event-date"
                      error={dateFieldError}
                    >
                      <DateWheel
                        id="event-date"
                        value={draft.date}
                        precision={draft.precision}
                        placeholder={datePlaceholder}
                        ariaLabel={t("event:from")}
                        disabled={busy}
                        onChange={(date) => update({ date })}
                        onBlur={() => setTouchedDate(true)}
                      />
                    </Field>
                    <Field label={t("event:to")} htmlFor="event-date-end">
                      <DateWheel
                        id="event-date-end"
                        value={draft.dateEnd}
                        precision={draft.precision}
                        placeholder={datePlaceholder}
                        ariaLabel={t("event:to")}
                        disabled={busy}
                        onChange={(dateEnd) => update({ dateEnd })}
                        onBlur={() => setTouchedDate(true)}
                      />
                    </Field>
                  </>
                ) : (
                  <Field
                    label={t("event:date")}
                    htmlFor="event-date"
                    error={dateFieldError}
                    hint={
                      draft.precision === "UNKNOWN"
                        ? draft.dateEnd.trim() !== ""
                          ? t("event:dateRangeUnknownHint")
                          : t("event:dateUnknownHint")
                        : undefined
                    }
                  >
                    {draft.precision === "UNKNOWN" ? (
                      <Input
                        id="event-date"
                        value={draft.date}
                        placeholder={datePlaceholder}
                        disabled={busy}
                        autoComplete="off"
                        onChange={(event) => update({ date: event.target.value })}
                        onBlur={() => setTouchedDate(true)}
                      />
                    ) : (
                      <DateWheel
                        id="event-date"
                        value={draft.date}
                        precision={draft.precision}
                        placeholder={datePlaceholder}
                        ariaLabel={t("event:date")}
                        disabled={busy}
                        onChange={(date) => update({ date })}
                        onBlur={() => setTouchedDate(true)}
                      />
                    )}
                  </Field>
                )}

                <Field label={t("event:precision")} htmlFor="event-precision">
                  <Select
                    id="event-precision"
                    value={draft.precision}
                    disabled={busy}
                    onChange={(event) => {
                      const precision = event.target.value as DatePrecision;
                      setTouchedDate(true);
                      update({
                        precision,
                        // An unknown date carries free text only; a period
                        // cannot be stored under it (ADR-0010).
                        ...(precision === "UNKNOWN"
                          ? {
                              dateMode: "single" as const,
                              qualifier: singleQualifier,
                            }
                          : {}),
                      });
                    }}
                  >
                    {PRECISIONS.map((precision) => (
                      <option key={precision} value={precision}>
                        {t(`enums:datePrecision.${precision}`)}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field
                  label={t("event:qualifier")}
                  htmlFor="event-qualifier"
                  hint={
                    draft.precision === "UNKNOWN"
                      ? t("event:qualifierUnknownHint")
                      : dateMode === "range"
                        ? t("event:dateRangeQualifier")
                        : undefined
                  }
                >
                  <Select
                    id="event-qualifier"
                    value={draft.qualifier}
                    disabled={
                      busy ||
                      draft.precision === "UNKNOWN" ||
                      dateMode === "range"
                    }
                    onChange={(event) => {
                      const qualifier = event.target.value as DateQualifier;
                      if (dateMode === "single") setSingleQualifier(qualifier);
                      update({ qualifier });
                    }}
                  >
                    {qualifierOptions.map((qualifier) => (
                      <option key={qualifier} value={qualifier}>
                        {t(`enums:dateQualifier.${qualifier}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            </div>

            {fieldCells.length > 0 || extraEntries.length > 0 ? (
              <div className="events-form-span events-form-details">
                <h3 className="events-form-details-title">
                  {t("event:detailsTitle")}
                </h3>
                <div className="events-detail-grid">
                  {fieldCells.map((cell) => (
                    <div
                      key={cell.key}
                      className={
                        cell.span === 2 ? "events-detail-span" : undefined
                      }
                    >
                      <Field
                        label={cell.label}
                        htmlFor={`event-detail-${cell.key}`}
                      >
                        {cell.key === "address" ? (
                          <Input
                            id={`event-detail-${cell.key}`}
                            value={draft.details[cell.key] ?? ""}
                            disabled={busy}
                            placeholder={t("event:placeholderAddress")}
                            onChange={(event) =>
                              updateDetail(cell.key, event.target.value)
                            }
                          />
                        ) : cell.multiline ? (
                          <Textarea
                            id={`event-detail-${cell.key}`}
                            value={draft.details[cell.key] ?? ""}
                            rows={2}
                            disabled={busy}
                            onChange={(event) =>
                              updateDetail(cell.key, event.target.value)
                            }
                          />
                        ) : (
                          <Input
                            id={`event-detail-${cell.key}`}
                            value={draft.details[cell.key] ?? ""}
                            disabled={busy}
                            onChange={(event) =>
                              updateDetail(cell.key, event.target.value)
                            }
                          />
                        )}
                      </Field>
                    </div>
                  ))}
                  {extraEntries.map(([key, value], index) => (
                    <Field
                      key={key}
                      label={key}
                      htmlFor={`event-detail-extra-${index}`}
                    >
                      <Input
                        id={`event-detail-extra-${index}`}
                        value={value}
                        disabled={busy}
                        onChange={(event) =>
                          updateDetail(key, event.target.value)
                        }
                      />
                    </Field>
                  ))}
                </div>
                {extraEntries.length > 0 ? (
                  <p className="events-form-details-hint">
                    {t("event:detailsExtraHint")}
                  </p>
                ) : null}

                {initial !== null &&
                draft.eventType === "DEATH" &&
                onCreateRelated ? (
                  <div className="events-related">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || dirty}
                      disabledReason={
                        dirty ? t("event:addBurialNeedsSave") : undefined
                      }
                      onClick={() =>
                        onCreateRelated({
                          type: "BURIAL",
                          personId: draft.personId,
                        })
                      }
                    >
                      <AddRegular fontSize={16} aria-hidden="true" />
                      {t("event:addBurial")}
                    </Button>
                    {dirty ? (
                      <p className="field-hint">
                        {t("event:addBurialNeedsSave")}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="events-form-span">
              <Field label={t("common:fields.notes")} htmlFor="event-note">
                <Textarea
                  id="event-note"
                  value={draft.description}
                  disabled={busy}
                  rows={3}
                  onChange={(event) => update({ description: event.target.value })}
                />
              </Field>
            </div>
          </div>

          {initial ? (
            <EventFiles
              eventId={initial.id}
              disabled={busy}
              onChanged={onFilesChanged}
            />
          ) : (
            <p className="meta event-files-after-save">
              {t("event:filesAfterSave")}
            </p>
          )}
        </form>
      )}
    </Dialog>
  );
}
