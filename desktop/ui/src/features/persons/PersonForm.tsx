import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Input, Select, Textarea } from "@fluentui/react-components";
import { personsApi } from "../../api/client";
import type {
  DatePrecision,
  DateQualifier,
  Gender,
  Person,
} from "../../api/types";
import { ErrorBanner } from "../../components/feedback";
import { Button } from "../../components/ui/button";
import { DateWheel } from "../../components/ui/date-wheel";
import { Dialog } from "../../components/ui/dialog";
import { Field } from "../../components/ui/field";
import { useToast } from "../../components/ui/toast";
import {
  fieldErrors,
  normalizeError,
  pickFieldError,
  type AppErrorEnvelope,
  type FieldErrors,
} from "../../lib/errors";
import {
  buildPersonInput,
  capitalizeName,
  draftFromPerson,
  emptyPersonDraft,
  splitGivenPatronymic,
  validatePersonDraft,
  type PersonDraft,
} from "./helpers";

const FORM_ID = "person-form";

const PRECISIONS: DatePrecision[] = ["DAY", "MONTH", "YEAR", "UNKNOWN"];
const QUALIFIERS: DateQualifier[] = ["EXACT", "APPROXIMATE"];

/** Keeps a legacy qualifier (BEFORE/AFTER/RANGE) selectable when editing. */
function qualifierOptions(current: DateQualifier): DateQualifier[] {
  return QUALIFIERS.includes(current) ? QUALIFIERS : [...QUALIFIERS, current];
}
const GENDERS: Gender[] = ["UNKNOWN", "MALE", "FEMALE"];

type FieldKey = "name" | "birth" | "death";

type DateSectionProps = {
  /** Draft key prefix; also the DOM id prefix (`person-birth-*`). */
  idPrefix: "birth" | "death";
  legend: string;
  date: string;
  precision: DatePrecision;
  qualifier: DateQualifier;
  error: string | null;
  disabled: boolean;
  onChangeDate: (value: string) => void;
  onChangePrecision: (value: DatePrecision) => void;
  onChangeQualifier: (value: DateQualifier) => void;
  onTouch: () => void;
};

/** Birth/death block: date input (wheel or text), precision and qualifier. */
function DateSection({
  idPrefix,
  legend,
  date,
  precision,
  qualifier,
  error,
  disabled,
  onChangeDate,
  onChangePrecision,
  onChangeQualifier,
  onTouch,
}: DateSectionProps) {
  const { t } = useTranslation(["person", "common", "enums"]);
  const dateId = `person-${idPrefix}-date`;
  const dateHint = (value: DatePrecision) => t(`person:dateHint.${value}`);

  return (
    <fieldset className="person-form-section">
      <legend>{legend}</legend>
      <div className="person-date-row">
        <Field label={t("person:date")} htmlFor={dateId} error={error}>
          {precision === "UNKNOWN" ? (
            <Input
              id={dateId}
              value={date}
              placeholder={dateHint("UNKNOWN")}
              disabled={disabled}
              autoComplete="off"
              onBlur={onTouch}
              onChange={(event) => onChangeDate(event.target.value)}
            />
          ) : (
            <DateWheel
              id={dateId}
              value={date}
              precision={precision}
              placeholder={dateHint(precision)}
              ariaLabel={t("person:date")}
              disabled={disabled}
              onChange={onChangeDate}
              onBlur={onTouch}
            />
          )}
        </Field>

        <Field
          label={t("common:fields.precision")}
          htmlFor={`person-${idPrefix}-precision`}
        >
          <Select
            id={`person-${idPrefix}-precision`}
            value={precision}
            disabled={disabled}
            onChange={(event) => {
              onChangePrecision(event.target.value as DatePrecision);
              onTouch();
            }}
          >
            {PRECISIONS.map((value) => (
              <option key={value} value={value}>
                {t(`enums:datePrecision.${value}`)}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label={t("person:qualifier")}
          htmlFor={`person-${idPrefix}-qualifier`}
        >
          <Select
            id={`person-${idPrefix}-qualifier`}
            value={qualifier}
            disabled={disabled || precision === "UNKNOWN"}
            onChange={(event) =>
              onChangeQualifier(event.target.value as DateQualifier)
            }
          >
            {qualifierOptions(qualifier).map((value) => (
              <option key={value} value={value}>
                {t(`enums:dateQualifier.${value}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </fieldset>
  );
}

type Props = {
  initial: Person | null;
  version: string | null;
  /** Applied only when creating, e.g. a parent slot that knows the gender. */
  prefill?: Partial<PersonDraft>;
  onSaved: (person: Person) => void;
  onCancel: () => void;
  onReload: () => void;
};

export default function PersonForm({
  initial,
  version,
  prefill,
  onSaved,
  onCancel,
  onReload,
}: Props) {
  const { t } = useTranslation(["person", "common", "enums"]);
  const toast = useToast();
  const [draft, setDraft] = useState<PersonDraft>(() =>
    initial ? draftFromPerson(initial) : { ...emptyPersonDraft(), ...prefill },
  );
  const [touched, setTouched] = useState<Partial<Record<FieldKey, boolean>>>({});
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<AppErrorEnvelope | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  const draftErrors = validatePersonDraft(draft);
  const nameMissing = draftErrors.name === "NAME_REQUIRED";

  const update = (patch: Partial<PersonDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const touch = (field: FieldKey) => {
    setTouched((current) =>
      current[field] ? current : { ...current, [field]: true },
    );
  };

  const serverCode = (fields: string[]): string | null =>
    pickFieldError(serverErrors, ...fields);

  const fieldError = (field: FieldKey, serverField: string[]): string | null => {
    if (touched[field] && draftErrors[field]) {
      return field === "name"
        ? t("person:nameRequired")
        : t("person:dateInvalid");
    }
    const code = serverCode(serverField);
    return code
      ? t(`common:errors.${code}`, { defaultValue: t("common:errors.UNKNOWN") })
      : null;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched({ name: true, birth: true, death: true });
    setError(null);
    setStale(false);
    if (Object.keys(draftErrors).length > 0) return;

    const built = buildPersonInput(draft, initial ?? undefined);
    if (!built.ok) return;

    setBusy(true);
    try {
      const saved =
        initial && version
          ? await personsApi.update(built.person, version)
          : await personsApi.create(built.person);
      toast.success(t("person:saved"));
      onSaved(saved.entity);
    } catch (caught) {
      const normalized = normalizeError(caught);
      if (normalized.code === "STALE_WRITE") {
        setStale(true);
      } else {
        setError(normalized);
        setServerErrors(fieldErrors(normalized));
      }
    } finally {
      setBusy(false);
    }
  };

  const canSplitName =
    draft.patronymic.trim() === "" &&
    draft.given.trim().split(/\s+/).filter(Boolean).length > 1;

  return (
    <Dialog
      open
      title={initial ? t("person:edit") : t("person:new")}
      description={t("person:formHint")}
      onClose={onCancel}
      busy={busy}
      size="lg"
      initialFocusRef={firstFieldRef}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            type="submit"
            form={FORM_ID}
            variant="primary"
            loading={busy}
            disabled={nameMissing}
            disabledReason={nameMissing ? t("person:nameRequired") : undefined}
          >
            {t("common:actions.save")}
          </Button>
        </>
      }
    >
      <form
        id={FORM_ID}
        className="person-form"
        onSubmit={submit}
        aria-busy={busy || undefined}
      >
        {stale ? (
          <div className="error-block" role="alert">
            <p className="error">{t("common:errors.STALE_WRITE")}</p>
            <p className="meta">{t("person:conflict")}</p>
            <Button variant="secondary" size="sm" onClick={onReload}>
              {t("common:actions.reload")}
            </Button>
          </div>
        ) : null}
        <ErrorBanner error={error} />

        <div className="person-form-grid">
          <Field label={t("person:surname")} htmlFor="person-surname">
            <Input
              ref={firstFieldRef}
              id="person-surname"
              value={draft.surname}
              disabled={busy}
              autoComplete="off"
              onBlur={(event) => {
                update({ surname: capitalizeName(event.target.value) });
                touch("name");
              }}
              onChange={(event) => update({ surname: event.target.value })}
            />
          </Field>

          <Field
            label={t("person:given")}
            htmlFor="person-given"
            error={fieldError("name", ["name", "given"])}
          >
            <Input
              id="person-given"
              value={draft.given}
              disabled={busy}
              autoComplete="off"
              onBlur={(event) => {
                update({ given: capitalizeName(event.target.value) });
                touch("name");
              }}
              onChange={(event) => update({ given: event.target.value })}
            />
          </Field>

          <Field label={t("person:patronymic")} htmlFor="person-patronymic">
            <Input
              id="person-patronymic"
              value={draft.patronymic}
              disabled={busy}
              autoComplete="off"
              onBlur={(event) =>
                update({ patronymic: capitalizeName(event.target.value) })
              }
              onChange={(event) => update({ patronymic: event.target.value })}
            />
          </Field>

          <Field
            label={t("person:birthSurname")}
            htmlFor="person-birth-surname"
            hint={t("person:birthSurnameHint")}
          >
            <Input
              id="person-birth-surname"
              value={draft.birthSurname}
              disabled={busy}
              autoComplete="off"
              onBlur={(event) =>
                update({ birthSurname: capitalizeName(event.target.value) })
              }
              onChange={(event) =>
                update({ birthSurname: event.target.value })
              }
            />
          </Field>

          <Field label={t("person:gender")} htmlFor="person-gender">
            <Select
              id="person-gender"
              value={draft.gender}
              disabled={busy}
              onChange={(event) =>
                update({ gender: event.target.value as Gender })
              }
            >
              {GENDERS.map((gender) => (
                <option key={gender} value={gender}>
                  {t(`enums:gender.${gender}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {canSplitName ? (
          <button
            type="button"
            className="link person-form-split-name"
            onClick={() => {
              const split = splitGivenPatronymic(
                draft.given,
                draft.patronymic,
              );
              update({
                given: split.given,
                patronymic: split.patronymic,
              });
            }}
          >
            {t("person:splitName")}
          </button>
        ) : null}

        <DateSection
          idPrefix="birth"
          legend={t("person:birth")}
          date={draft.birthDate}
          precision={draft.birthPrecision}
          qualifier={draft.birthQualifier}
          error={fieldError("birth", ["date", "birth"])}
          disabled={busy}
          onChangeDate={(birthDate) => update({ birthDate })}
          onChangePrecision={(birthPrecision) => update({ birthPrecision })}
          onChangeQualifier={(birthQualifier) => update({ birthQualifier })}
          onTouch={() => touch("birth")}
        />

        <DateSection
          idPrefix="death"
          legend={t("person:death")}
          date={draft.deathDate}
          precision={draft.deathPrecision}
          qualifier={draft.deathQualifier}
          error={fieldError("death", ["date", "death"])}
          disabled={busy}
          onChangeDate={(deathDate) => update({ deathDate })}
          onChangePrecision={(deathPrecision) => update({ deathPrecision })}
          onChangeQualifier={(deathQualifier) => update({ deathQualifier })}
          onTouch={() => touch("death")}
        />


        <Field label={t("person:notes")} htmlFor="person-notes">
          <Textarea
            id="person-notes"
            value={draft.notes}
            disabled={busy}
            rows={3}
            onChange={(event) => update({ notes: event.target.value })}
          />
        </Field>
      </form>
    </Dialog>
  );
}
