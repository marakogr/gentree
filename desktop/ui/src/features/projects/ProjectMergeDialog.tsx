import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Input,
  MessageBar,
  MessageBarBody,
  Radio,
  RadioGroup,
  Select,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { projectsApi } from "../../api/client";
import type {
  MergeAction,
  MergeEvent,
  MergeEventMatch,
  MergeFieldPolicy,
  MergeMatchConfidence,
  MergePerson,
  MergePersonMatch,
  MergePreview,
  MergeSide,
  MergeWarning,
  ProjectInfo,
} from "../../api/types";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Field } from "../../components/ui/field";
import { useToast } from "../../components/ui/toast";
import { useDateFormatter } from "../../lib/useDateFormatter";
import { normalizeError, type AppErrorEnvelope } from "../../lib/errors";
import { eventTypeLabel } from "../events/helpers";
import { lifeYears } from "../persons/helpers";
import {
  buildMergeDecisions,
  defaultEventChoice,
  defaultMergeDraft,
  defaultPersonChoice,
  detailKey,
  fieldPolicies,
  mergePersonLabel,
  type MergeDraft,
  type MergeEventChoice,
  type MergePersonChoice,
} from "./merge";

type Props = {
  open: boolean;
  projects: ProjectInfo[];
  current?: ProjectInfo | null;
  /** Preselects a pair, e.g. from the projects selection bar. */
  initialPair?: { leftId: string; rightId: string } | null;
  onClose: () => void;
  /** The merged project is already open in the backend. */
  onOpened: (project: ProjectInfo) => void;
};

const CONFIDENCE_COLOR: Record<
  MergeMatchConfidence,
  "success" | "warning" | "severe"
> = {
  High: "success",
  Medium: "warning",
  Ambiguous: "severe",
};

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  selectRow: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: tokens.spacingHorizontalM,
  },
  inline: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  preview: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    maxHeight: "60vh",
    overflowY: "auto",
    paddingRight: tokens.spacingHorizontalXS,
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  personHead: {
    display: "grid",
    gridTemplateColumns: "1fr auto 1fr auto",
    alignItems: "start",
    gap: tokens.spacingHorizontalM,
  },
  personSide: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
    minWidth: 0,
  },
  arrow: {
    color: tokens.colorNeutralForeground3,
    alignSelf: "center",
  },
  caption: {
    color: tokens.colorNeutralForeground3,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  muted: {
    color: tokens.colorNeutralForeground3,
  },
  evidence: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalXS,
  },
  evidenceChip: {
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
  },
  compareRow: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    paddingTop: tokens.spacingVerticalS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  compareValues: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: tokens.spacingHorizontalM,
  },
  compareValue: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
    minWidth: 0,
  },
  longText: {
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  eventCard: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  eventHead: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  warningList: {
    margin: 0,
    paddingLeft: tokens.spacingHorizontalL,
  },
  peopleList: {
    margin: 0,
    paddingLeft: tokens.spacingHorizontalL,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
  },
  empty: {
    color: tokens.colorNeutralForeground2,
  },
});

/**
 * Two-step wizard for merging two existing projects into a brand-new one
 * (ADR-0017). Nothing is written before the explicit "Merge" click: the
 * preview is a suggestion list and every pair carries its own decision.
 */
export function ProjectMergeDialog({
  open,
  projects,
  current,
  initialPair,
  onClose,
  onOpened,
}: Props) {
  const { t } = useTranslation(["project", "common", "event", "enums"]);
  const styles = useStyles();
  const toast = useToast();
  const formatDate = useDateFormatter();

  const [leftId, setLeftId] = useState("");
  const [rightId, setRightId] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [draft, setDraft] = useState<MergeDraft | null>(null);
  const [error, setError] = useState<AppErrorEnvelope | null>(null);
  const [building, setBuilding] = useState(false);
  const [applying, setApplying] = useState(false);
  const requestRef = useRef(0);

  // Every open starts from a clean suggestion list; the preview belongs to the
  // selected pair and is dropped as soon as that pair changes. A caller-provided
  // pair wins over the current project so the row menu can open both sides.
  useEffect(() => {
    if (!open) return;
    const presetLeft =
      initialPair &&
      projects.some((project) => project.projectId === initialPair.leftId)
        ? initialPair.leftId
        : null;
    const presetRight =
      initialPair &&
      initialPair.rightId !== presetLeft &&
      projects.some((project) => project.projectId === initialPair.rightId)
        ? initialPair.rightId
        : null;
    const currentInList = current
      ? projects.find((project) => project.projectId === current.projectId)
      : undefined;
    const left =
      projects.find((project) => project.projectId === presetLeft) ??
      currentInList ??
      projects[0] ??
      null;
    const right =
      projects.find((project) => project.projectId === presetRight) ??
      projects.find((project) => project.projectId !== left?.projectId) ??
      null;

    setLeftId(left?.projectId ?? "");
    setRightId(right?.projectId ?? "");
    setName(left && right ? `${left.name} + ${right.name}` : "");
    setNameEdited(false);
    setPreview(null);
    setDraft(null);
    setError(null);
    setBuilding(false);
    setApplying(false);
    requestRef.current += 1;
  }, [open, current, projects, initialPair]);

  const busy = building || applying;
  const sameProject = leftId !== "" && leftId === rightId;
  const fewProjects = projects.length < 2;
  const canBuild =
    !fewProjects && !busy && leftId !== "" && rightId !== "" && !sameProject;
  const canApply =
    preview !== null &&
    draft !== null &&
    !busy &&
    !fewProjects &&
    !sameProject &&
    name.trim() !== "";

  const clearPreview = () => {
    requestRef.current += 1;
    setPreview(null);
    setDraft(null);
    setError(null);
    setBuilding(false);
  };

  const defaultName = (left: string, right: string) => {
    const leftProject = projects.find((project) => project.projectId === left);
    const rightProject = projects.find((project) => project.projectId === right);
    return leftProject && rightProject
      ? `${leftProject.name} + ${rightProject.name}`
      : "";
  };

  const changeLeft = (value: string) => {
    let nextRight = rightId;
    if (value === rightId) {
      nextRight =
        projects.find((project) => project.projectId !== value)?.projectId ??
        "";
      setRightId(nextRight);
    }
    setLeftId(value);
    if (!nameEdited) setName(defaultName(value, nextRight));
    clearPreview();
  };

  const changeRight = (value: string) => {
    let nextLeft = leftId;
    if (value === leftId) {
      nextLeft =
        projects.find((project) => project.projectId !== value)?.projectId ??
        "";
      setLeftId(nextLeft);
    }
    setRightId(value);
    if (!nameEdited) setName(defaultName(nextLeft, value));
    clearPreview();
  };

  const build = () => {
    if (!canBuild) return;
    const token = requestRef.current + 1;
    requestRef.current = token;
    setBuilding(true);
    setError(null);
    setPreview(null);
    setDraft(null);

    void projectsApi
      .mergePreview(leftId, rightId)
      .then((result) => {
        if (token !== requestRef.current) return;
        setPreview(result);
        setDraft(defaultMergeDraft(result));
      })
      .catch((caught) => {
        if (token === requestRef.current) setError(normalizeError(caught));
      })
      .finally(() => {
        if (token === requestRef.current) setBuilding(false);
      });
  };

  const apply = () => {
    if (!preview || !draft || !canApply) return;
    setApplying(true);
    setError(null);

    void projectsApi
      .mergeApply({
        leftProjectId: leftId,
        rightProjectId: rightId,
        name: name.trim(),
        decisions: buildMergeDecisions(preview, draft),
      })
      .then((result) => {
        // Report counts go into the success toast; a separate info toast is
        // reserved for warnings, so the merge never looks cleaner than it is.
        const report = result.report;
        const parts = [
          report.mergedPeople > 0
            ? t("project:merge.report.mergedPeople", {
                value: report.mergedPeople,
              })
            : null,
          report.mergedEvents > 0
            ? t("project:merge.report.mergedEvents", {
                value: report.mergedEvents,
              })
            : null,
          report.keptBothPeople > 0
            ? t("project:merge.report.keptBothPeople", {
                value: report.keptBothPeople,
              })
            : null,
          report.keptBothEvents > 0
            ? t("project:merge.report.keptBothEvents", {
                value: report.keptBothEvents,
              })
            : null,
          report.unmatchedRightPeople > 0
            ? t("project:merge.report.unmatchedRightPeople", {
                value: report.unmatchedRightPeople,
              })
            : null,
        ].filter((part): part is string => part !== null);
        const applied = t("project:merge.applied", {
          name: result.project.name,
        });

        toast.success(
          parts.length > 0 ? `${applied} ${parts.join(" · ")}` : applied,
        );
        if (result.report.warnings.length > 0) {
          toast.info(
            t("project:merge.appliedWarnings", {
              value: result.report.warnings.length,
            }),
          );
        }
        onClose();
        onOpened(result.project);
      })
      .catch((caught) => setError(normalizeError(caught)))
      .finally(() => setApplying(false));
  };

  const updatePersonChoice = (
    id: string,
    patch: Partial<MergePersonChoice>,
  ) => {
    setDraft((current) => {
      if (!current) return current;
      const match = preview?.matches.find((row) => row.id === id);
      const fallback = match ? defaultPersonChoice(match) : null;
      const choice = current.persons[id] ?? fallback;
      if (!choice) return current;
      const fields = { ...choice.fields };
      if (patch.base && match) {
        // A new base card must actually become the base for the differing
        // fields too; otherwise the previous Left policies would keep winning.
        for (const field of match.fieldDiffs) fields[field] = patch.base;
      }
      return {
        ...current,
        persons: {
          ...current.persons,
          [id]: { ...choice, ...patch, fields },
        },
      };
    });
  };

  const updatePersonField = (
    id: string,
    field: string,
    policy: MergeFieldPolicy,
  ) => {
    setDraft((current) => {
      if (!current) return current;
      const match = preview?.matches.find((row) => row.id === id);
      const fallback = match ? defaultPersonChoice(match) : null;
      const choice = current.persons[id] ?? fallback;
      if (!choice) return current;
      return {
        ...current,
        persons: {
          ...current.persons,
          [id]: { ...choice, fields: { ...choice.fields, [field]: policy } },
        },
      };
    });
  };

  const updateEventChoice = (
    id: string,
    patch: Partial<MergeEventChoice>,
  ) => {
    setDraft((current) => {
      if (!current) return current;
      const match = preview?.matches
        .flatMap((person) => person.eventMatches)
        .find((row) => row.id === id);
      const fallback = match ? defaultEventChoice(match) : null;
      const choice = current.events[id] ?? fallback;
      if (!choice) return current;
      const fields = { ...choice.fields };
      if (patch.base && match) {
        for (const field of match.fieldDiffs) fields[field] = patch.base;
      }
      return {
        ...current,
        events: {
          ...current.events,
          [id]: { ...choice, ...patch, fields },
        },
      };
    });
  };

  const updateEventField = (
    id: string,
    field: string,
    policy: MergeFieldPolicy,
  ) => {
    setDraft((current) => {
      if (!current) return current;
      const match = preview?.matches
        .flatMap((person) => person.eventMatches)
        .find((row) => row.id === id);
      const fallback = match ? defaultEventChoice(match) : null;
      const choice = current.events[id] ?? fallback;
      if (!choice) return current;
      return {
        ...current,
        events: {
          ...current.events,
          [id]: { ...choice, fields: { ...choice.fields, [field]: policy } },
        },
      };
    });
  };

  const errorText = error
    ? t(`common:errors.${error.code}`, {
        defaultValue: t("common:errors.UNKNOWN"),
      })
    : null;

  return (
    <Dialog
      open={open}
      size="lg"
      title={t("project:merge.title")}
      description={t("project:merge.hint")}
      onClose={() => {
        if (!busy) onClose();
      }}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            variant="primary"
            loading={applying}
            disabled={!canApply}
            disabledReason={
              applying
                ? t("project:merge.applying")
                : name.trim() === ""
                  ? t("project:merge.nameRequired")
                  : undefined
            }
            onClick={apply}
          >
            {applying ? t("project:merge.applying") : t("project:merge.apply")}
          </Button>
        </>
      }
    >
      <div className={styles.root}>
        {fewProjects ? (
          <MessageBar intent="info">
            <MessageBarBody>{t("project:merge.needTwoProjects")}</MessageBarBody>
          </MessageBar>
        ) : null}

        <section className={styles.section}>
          <div className={styles.selectRow}>
            <Field
              label={t("project:merge.leftProject")}
              htmlFor="merge-left-project"
            >
              <Select
                id="merge-left-project"
                value={leftId}
                disabled={busy || fewProjects}
                onChange={(_event, data) => changeLeft(data.value)}
              >
                {projects.map((project) => (
                  <option
                    key={project.projectId}
                    value={project.projectId}
                    disabled={project.projectId === rightId}
                  >
                    {project.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label={t("project:merge.rightProject")}
              htmlFor="merge-right-project"
            >
              <Select
                id="merge-right-project"
                value={rightId}
                disabled={busy || fewProjects}
                onChange={(_event, data) => changeRight(data.value)}
              >
                {projects.map((project) => (
                  <option
                    key={project.projectId}
                    value={project.projectId}
                    disabled={project.projectId === leftId}
                  >
                    {project.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label={t("project:merge.name")} htmlFor="merge-project-name">
            <Input
              id="merge-project-name"
              value={name}
              disabled={applying}
              autoComplete="off"
              onChange={(_event, data) => {
                setName(data.value);
                setNameEdited(true);
              }}
            />
          </Field>

          {sameProject ? (
            <MessageBar intent="error">
              <MessageBarBody>
                {t("project:merge.sameProject")}
              </MessageBarBody>
            </MessageBar>
          ) : null}

          <div className={styles.inline}>
            <Button
              variant="secondary"
              loading={building}
              disabled={!canBuild}
              onClick={build}
            >
              {building
                ? t("project:merge.loading")
                : t("project:merge.build")}
            </Button>
          </div>
        </section>

        {errorText ? (
          <MessageBar intent="error">
            <MessageBarBody>{errorText}</MessageBarBody>
          </MessageBar>
        ) : null}

        {building ? (
          <div className={styles.inline}>
            <Spinner size="small" label={t("project:merge.loading")} />
          </div>
        ) : null}

        {preview && draft ? (
          <div className={styles.preview}>
            <PreviewSummary preview={preview} />

            {preview.warnings.length > 0 ? (
              <WarningList warnings={preview.warnings} />
            ) : null}

            {preview.matches.length === 0 ? (
              <div className={styles.section}>
                <Text weight="semibold">
                  {t("project:merge.emptyMatches")}
                </Text>
                <Text size={300} className={styles.empty}>
                  {t("project:merge.emptyMatchesHint")}
                </Text>
              </div>
            ) : (
              preview.matches.map((match) => (
                <PersonCard
                  key={match.id}
                  match={match}
                  choice={draft.persons[match.id] ?? defaultPersonChoice(match)}
                  eventChoices={draft.events}
                  formatDate={formatDate}
                  onChoice={(patch) => updatePersonChoice(match.id, patch)}
                  onField={(field, policy) =>
                    updatePersonField(match.id, field, policy)
                  }
                  onEventChoice={updateEventChoice}
                  onEventField={updateEventField}
                />
              ))
            )}

            {preview.unmatchedRight.length > 0 ? (
              <UnmatchedPeople people={preview.unmatchedRight} />
            ) : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function PreviewSummary({ preview }: { preview: MergePreview }) {
  const { t } = useTranslation(["project"]);
  const styles = useStyles();
  const { counts } = preview;
  const items = [
    t("project:merge.counts.leftPeople", { value: counts.leftPeople }),
    t("project:merge.counts.rightPeople", { value: counts.rightPeople }),
    t("project:merge.counts.matchedPeople", { value: counts.matchedPeople }),
    t("project:merge.counts.leftEvents", { value: counts.leftEvents }),
    t("project:merge.counts.rightEvents", { value: counts.rightEvents }),
    t("project:merge.counts.matchedEvents", { value: counts.matchedEvents }),
    counts.ambiguousPeople > 0
      ? t("project:merge.counts.ambiguousPeople", {
          value: counts.ambiguousPeople,
        })
      : null,
  ].filter((item): item is string => item !== null);

  return (
    <div className={styles.evidence} aria-label={t("project:merge.title")}>
      {items.map((item) => (
        <Badge key={item} appearance="tint" color="subtle" size="small">
          {item}
        </Badge>
      ))}
    </div>
  );
}

function WarningList({ warnings }: { warnings: MergeWarning[] }) {
  const { t } = useTranslation(["project"]);
  const styles = useStyles();

  return (
    <MessageBar intent="warning">
      <MessageBarBody>
        <Text weight="semibold">{t("project:merge.warningsTitle")}</Text>
        <ul className={styles.warningList}>
          {warnings.map((warning, index) => (
            <li key={`${warning.code}-${index}`}>
              {t(`project:merge.warnings.${warning.code}`, {
                defaultValue: warning.code,
              })}
            </li>
          ))}
        </ul>
      </MessageBarBody>
    </MessageBar>
  );
}

type PersonCardProps = {
  match: MergePersonMatch;
  choice: MergePersonChoice;
  eventChoices: Record<string, MergeEventChoice>;
  formatDate: (value: MergePerson["birth"]) => string;
  onChoice: (patch: Partial<MergePersonChoice>) => void;
  onField: (field: string, policy: MergeFieldPolicy) => void;
  onEventChoice: (
    eventId: string,
    patch: Partial<MergeEventChoice>,
  ) => void;
  onEventField: (
    eventId: string,
    field: string,
    policy: MergeFieldPolicy,
  ) => void;
};

function PersonCard({
  match,
  choice,
  eventChoices,
  formatDate,
  onChoice,
  onField,
  onEventChoice,
  onEventField,
}: PersonCardProps) {
  const { t } = useTranslation(["project", "event", "enums"]);
  const styles = useStyles();
  const empty = t("project:emptyValue");
  const leftName = mergePersonLabel(match.left, empty);
  const rightName = mergePersonLabel(match.right, empty);

  return (
    <article
      className={styles.card}
      aria-label={`${leftName} / ${rightName}`}
    >
      <div className={styles.personHead}>
        <div className={styles.personSide}>
          <Text size={200} className={styles.caption}>
            {t("project:merge.policy.Left")}
          </Text>
          <Text weight="semibold">{leftName}</Text>
          <Text size={200} className={styles.muted}>
            {lifeYears(match.left)}
          </Text>
        </div>
        <Text className={styles.arrow} aria-hidden="true">
          ⇄
        </Text>
        <div className={styles.personSide}>
          <Text size={200} className={styles.caption}>
            {t("project:merge.policy.Right")}
          </Text>
          <Text weight="semibold">{rightName}</Text>
          <Text size={200} className={styles.muted}>
            {lifeYears(match.right)}
          </Text>
        </div>
        <Badge
          appearance="tint"
          color={CONFIDENCE_COLOR[match.confidence]}
          size="small"
        >
          {t(`project:merge.confidence.${match.confidence}`)}
        </Badge>
      </div>

      {match.evidence.length > 0 ? (
        <div className={styles.evidence}>
          {match.evidence.map((evidence, index) => (
            <Text
              key={`${evidence.code}-${index}`}
              size={200}
              className={styles.evidenceChip}
            >
              {t(`project:merge.evidence.${evidence.code}`, {
                defaultValue: evidence.code,
              })}
            </Text>
          ))}
        </div>
      ) : null}

      <RadioGroup
        layout="horizontal"
        value={choice.action}
        aria-label={t("project:merge.personAction")}
        onChange={(_event, data) =>
          onChoice({ action: data.value as MergeAction })
        }
      >
        <Radio
          value="Merge"
          label={t("project:merge.actionLabel.Merge")}
        />
        <Radio
          value="KeepBoth"
          label={t("project:merge.actionLabel.KeepBoth")}
        />
      </RadioGroup>

      {choice.action === "Merge" ? (
        <>
          <RadioGroup
            layout="horizontal"
            value={choice.base}
            aria-label={t("project:merge.personBase")}
            onChange={(_event, data) =>
              onChoice({ base: data.value as MergeSide })
            }
          >
            <Radio
              value="Left"
              label={t("project:merge.baseOption.Left")}
            />
            <Radio
              value="Right"
              label={t("project:merge.baseOption.Right")}
            />
          </RadioGroup>

          {match.fieldDiffs.map((field) => (
            <FieldCompare
              key={field}
              label={t(`project:merge.field.${field}`, {
                defaultValue: field,
              })}
              left={personFieldText(
                match.left,
                field,
                formatDate,
                empty,
                t,
              )}
              right={personFieldText(
                match.right,
                field,
                formatDate,
                empty,
                t,
              )}
              policy={choice.fields[field] ?? choice.base}
              policies={fieldPolicies(field, "person")}
              multiline={field === "notes"}
              onChange={(policy) => onField(field, policy)}
            />
          ))}

          <PersonEvents
            match={match}
            eventChoices={eventChoices}
            formatDate={formatDate}
            onEventChoice={onEventChoice}
            onEventField={onEventField}
          />
        </>
      ) : (
        <Text size={200} className={styles.muted}>
          {t("project:merge.keepBothHint")}
        </Text>
      )}
    </article>
  );
}

function PersonEvents({
  match,
  eventChoices,
  formatDate,
  onEventChoice,
  onEventField,
}: {
  match: MergePersonMatch;
  eventChoices: Record<string, MergeEventChoice>;
  formatDate: (value: MergePerson["birth"]) => string;
  onEventChoice: (
    eventId: string,
    patch: Partial<MergeEventChoice>,
  ) => void;
  onEventField: (
    eventId: string,
    field: string,
    policy: MergeFieldPolicy,
  ) => void;
}) {
  const { t } = useTranslation(["project"]);
  const styles = useStyles();
  const matchedLeft = new Set(match.eventMatches.map((pair) => pair.left.id));
  const matchedRight = new Set(match.eventMatches.map((pair) => pair.right.id));
  const unmatchedLeft = match.leftEvents.filter(
    (event) => !matchedLeft.has(event.id),
  ).length;
  const unmatchedRight = match.rightEvents.filter(
    (event) => !matchedRight.has(event.id),
  ).length;
  const hasAnyEvent =
    match.leftEvents.length > 0 || match.rightEvents.length > 0;

  return (
    <div className={styles.section}>
      <Text weight="semibold">{t("project:merge.eventsTitle")}</Text>

      {match.eventMatches.map((eventMatch) => (
        <EventCard
          key={eventMatch.id}
          match={eventMatch}
          choice={
            eventChoices[eventMatch.id] ?? defaultEventChoice(eventMatch)
          }
          formatDate={formatDate}
          onChoice={(patch) => onEventChoice(eventMatch.id, patch)}
          onField={(field, policy) =>
            onEventField(eventMatch.id, field, policy)
          }
        />
      ))}

      {!hasAnyEvent ? (
        <Text size={200} className={styles.muted}>
          {t("project:merge.noEvents")}
        </Text>
      ) : null}

      {hasAnyEvent && match.eventMatches.length === 0 ? (
        <Text size={200} className={styles.muted}>
          {t("project:merge.noPairedEvents")}
        </Text>
      ) : null}

      {unmatchedLeft > 0 ? (
        <Text size={200} className={styles.muted}>
          {t("project:merge.unmatchedLeftEvents", { value: unmatchedLeft })}
        </Text>
      ) : null}
      {unmatchedRight > 0 ? (
        <Text size={200} className={styles.muted}>
          {t("project:merge.unmatchedRightEvents", { value: unmatchedRight })}
        </Text>
      ) : null}
    </div>
  );
}

function EventCard({
  match,
  choice,
  formatDate,
  onChoice,
  onField,
}: {
  match: MergeEventMatch;
  choice: MergeEventChoice;
  formatDate: (value: MergePerson["birth"]) => string;
  onChoice: (patch: Partial<MergeEventChoice>) => void;
  onField: (field: string, policy: MergeFieldPolicy) => void;
}) {
  const { t } = useTranslation(["project", "event"]);
  const styles = useStyles();
  const empty = t("project:emptyValue");
  const label = (event: MergeEvent) =>
    eventTypeLabel(event.type, event.originalType, t);

  return (
    <div className={styles.eventCard}>
      <div className={styles.personHead}>
        <div className={styles.personSide}>
          <Text size={200} className={styles.caption}>
            {t("project:merge.policy.Left")}
          </Text>
          <Text weight="semibold">{label(match.left)}</Text>
          <Text size={200} className={styles.muted}>
            {formatDate(match.left.date)}
            {match.left.place ? ` · ${match.left.place}` : ""}
          </Text>
        </div>
        <Text className={styles.arrow} aria-hidden="true">
          ⇄
        </Text>
        <div className={styles.personSide}>
          <Text size={200} className={styles.caption}>
            {t("project:merge.policy.Right")}
          </Text>
          <Text weight="semibold">{label(match.right)}</Text>
          <Text size={200} className={styles.muted}>
            {formatDate(match.right.date)}
            {match.right.place ? ` · ${match.right.place}` : ""}
          </Text>
        </div>
        <Badge
          appearance="tint"
          color={CONFIDENCE_COLOR[match.confidence]}
          size="small"
        >
          {t(`project:merge.confidence.${match.confidence}`)}
        </Badge>
      </div>

      <RadioGroup
        layout="horizontal"
        value={choice.action}
        aria-label={t("project:merge.eventAction")}
        onChange={(_event, data) =>
          onChoice({ action: data.value as MergeAction })
        }
      >
        <Radio
          value="Merge"
          label={t("project:merge.eventActionLabel.Merge")}
        />
        <Radio
          value="KeepBoth"
          label={t("project:merge.eventActionLabel.KeepBoth")}
        />
      </RadioGroup>

      {choice.action === "Merge" ? (
        <>
          <RadioGroup
            layout="horizontal"
            value={choice.base}
            aria-label={t("project:merge.eventBase")}
            onChange={(_event, data) =>
              onChoice({ base: data.value as MergeSide })
            }
          >
            <Radio
              value="Left"
              label={t("project:merge.baseOption.Left")}
            />
            <Radio
              value="Right"
              label={t("project:merge.baseOption.Right")}
            />
          </RadioGroup>

          {match.fieldDiffs.map((field) => {
            const key = detailKey(field);
            const fieldLabel =
              key === null
                ? t(`project:merge.field.${field}`, { defaultValue: field })
                : t(`event:fields.${key}`, {
                    defaultValue: t("project:merge.detailsKey", { key }),
                  });

            return (
              <FieldCompare
                key={field}
                label={fieldLabel}
                left={eventFieldText(match.left, field, formatDate, empty)}
                right={eventFieldText(match.right, field, formatDate, empty)}
                policy={choice.fields[field] ?? choice.base}
                policies={fieldPolicies(field, "event")}
                multiline={key !== null || field === "description"}
                onChange={(policy) => onField(field, policy)}
              />
            );
          })}
        </>
      ) : null}
    </div>
  );
}

function FieldCompare({
  label,
  left,
  right,
  policy,
  policies,
  multiline = false,
  onChange,
}: {
  label: string;
  left: string;
  right: string;
  policy: MergeFieldPolicy;
  policies: MergeFieldPolicy[];
  multiline?: boolean;
  onChange: (policy: MergeFieldPolicy) => void;
}) {
  const { t } = useTranslation(["project"]);
  const styles = useStyles();
  const valueClass = multiline ? styles.longText : undefined;

  return (
    <div className={styles.compareRow}>
      <Text weight="semibold">{label}</Text>
      <div className={styles.compareValues}>
        <div className={styles.compareValue}>
          <Text size={200} className={styles.caption}>
            {t("project:merge.policy.Left")}
          </Text>
          <Text size={300} className={valueClass}>
            {left}
          </Text>
        </div>
        <div className={styles.compareValue}>
          <Text size={200} className={styles.caption}>
            {t("project:merge.policy.Right")}
          </Text>
          <Text size={300} className={valueClass}>
            {right}
          </Text>
        </div>
      </div>
      <RadioGroup
        layout="horizontal"
        value={policy}
        aria-label={`${label}: ${t("project:merge.policyLabel")}`}
        onChange={(_event, data) =>
          onChange(data.value as MergeFieldPolicy)
        }
      >
        {policies.map((option) => (
          <Radio
            key={option}
            value={option}
            label={t(`project:merge.policy.${option}`)}
          />
        ))}
      </RadioGroup>
    </div>
  );
}

function UnmatchedPeople({ people }: { people: MergePerson[] }) {
  const { t } = useTranslation(["project"]);
  const styles = useStyles();
  const empty = t("project:emptyValue");

  return (
    <section className={styles.card} aria-label={t("project:merge.unmatchedRightTitle")}>
      <Text weight="semibold">{t("project:merge.unmatchedRightTitle")}</Text>
      <Text size={200} className={styles.muted}>
        {t("project:merge.unmatchedRightHint")}
      </Text>
      <ul className={styles.peopleList}>
        {people.map((person) => (
          <li key={person.id}>
            <Text size={300}>{mergePersonLabel(person, empty)}</Text>
            <Text size={200} className={styles.muted}>
              {" · "}
              {lifeYears(person)}
            </Text>
          </li>
        ))}
      </ul>
    </section>
  );
}

function personFieldText(
  person: MergePerson,
  field: string,
  formatDate: (value: MergePerson["birth"]) => string,
  empty: string,
  t: (key: string) => string,
): string {
  switch (field) {
    case "gender":
      return t(`enums:gender.${person.gender}`);
    case "birth":
      return formatDate(person.birth);
    case "death":
      return formatDate(person.death);
    case "notes":
      return person.notes?.trim() ? person.notes : empty;
    default:
      return empty;
  }
}

function eventFieldText(
  event: MergeEvent,
  field: string,
  formatDate: (value: MergePerson["birth"]) => string,
  empty: string,
): string {
  const key = detailKey(field);
  if (key !== null) {
    return event.details[key]?.trim() ? event.details[key] : empty;
  }
  switch (field) {
    case "date":
      return formatDate(event.date);
    case "place":
      return event.place?.trim() ? event.place : empty;
    case "placeGeo":
      return event.placeGeo
        ? `${event.placeGeo.lat.toFixed(4)}, ${event.placeGeo.lon.toFixed(4)}`
        : empty;
    case "description":
      return event.description?.trim() ? event.description : empty;
    default:
      return empty;
  }
}
