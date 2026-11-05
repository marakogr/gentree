import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Badge,
  Checkbox,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Skeleton,
  SkeletonItem,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@fluentui/react-components";
import { useTranslation } from "react-i18next";
import {
  AlertRegular,
  ArchiveRegular,
  ArrowDownRegular,
  ArrowDownloadRegular,
  ArrowRightRegular,
  ArrowSortRegular,
  ArrowUpRegular,
  DeleteRegular,
  DismissRegular,
  DocumentArrowRightRegular,
  EditRegular,
  FolderAddRegular,
  FolderSearchRegular,
  HistoryRegular,
  InfoRegular,
  MergeRegular,
  SearchRegular,
  ShieldCheckmarkRegular,
} from "@fluentui/react-icons";
import { projectsApi } from "../../api/client";
import type { ProjectInfo, ValidationReport } from "../../api/types";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { MenuButton, type MenuItem } from "../../components/ui/menu";
import { useToast } from "../../components/ui/toast";
import { normalizeError, type AppErrorEnvelope } from "../../lib/errors";
import { ImportDialog } from "../import/ImportDialog";
import { ProjectExportDialog } from "./ProjectExportDialog";
import { ProjectMergeDialog } from "./ProjectMergeDialog";
import { ProjectRestoreDialog } from "./ProjectRestoreDialog";
import { ValidationSummary } from "./ValidationSummary";
import {
  formatBackupStamp,
  readLastBackup,
  readLastCheck,
  writeLastBackup,
  writeLastCheck,
} from "./backupStamp";
import {
  defaultSortDirection,
  visibleProjects,
  type ProjectSort,
  type ProjectSortState,
} from "./listView";
import {
  PROJECT_NAME_MAX_LENGTH,
  checkProjectName,
  renameErrorKey,
} from "./nameRules";
import { formatRelativeStamp, isStaleStamp } from "./relativeTime";
import "./projects.css";

type Props = {
  current: ProjectInfo | null;
  onOpened: (project: ProjectInfo) => void;
  onClosed: () => void;
  /**
   * The open project was renamed in place. `App` should update its `current`
   * state so the sidebar and other screens show the new name without reopening.
   */
  onRenamed?: (project: ProjectInfo) => void;
  /** Jump to one event, e.g. from a validation issue. */
  onOpenEvent?: (eventId: string) => void;
};

type PendingAction =
  | "create"
  | "open"
  | "close"
  | "backup"
  | "validate"
  | "rename"
  | "delete"
  | null;

/** Validation issues shown before the "and N more" hint. */

const SORT_STORAGE_KEY = "gentree.projects.sort";

/** Last chosen column and direction; survives leaving the projects screen. */
function readSortState(): ProjectSortState {
  try {
    const raw = window.localStorage.getItem(SORT_STORAGE_KEY);
    if (raw !== null) {
      const [key, direction] = raw.split(":");
      if (
        (key === "recent" || key === "name" || key === "people") &&
        (direction === "asc" || direction === "desc")
      ) {
        return { key, direction };
      }
    }
  } catch {
    // A hardened webview may refuse storage access; the default still works.
  }
  return { key: "recent", direction: "desc" };
}

function writeSortState(sort: ProjectSortState) {
  try {
    window.localStorage.setItem(
      SORT_STORAGE_KEY,
      `${sort.key}:${sort.direction}`,
    );
  } catch {
    // Ignore: sorting still works for the current visit.
  }
}

function stampMap(
  projects: readonly ProjectInfo[],
  read: (projectId: string) => string | null,
): Record<string, string | null> {
  return Object.fromEntries(
    projects.map((project) => [project.projectId, read(project.projectId)]),
  );
}

export default function ProjectsPage({
  current,
  onOpened,
  onClosed,
  onRenamed,
  onOpenEvent,
}: Props) {
  const { t, i18n } = useTranslation(["project", "person", "common"]);
  const toast = useToast();
  const locale = i18n.language;
  const now = new Date();

  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingAction>(null);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [error, setError] = useState<AppErrorEnvelope | null>(null);

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ProjectSortState>(readSortState);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [backupStamps, setBackupStamps] = useState<
    Record<string, string | null>
  >({});
  const [checkStamps, setCheckStamps] = useState<Record<string, string | null>>(
    {},
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createErrorKey, setCreateErrorKey] = useState<string | null>(null);

  const [renameTarget, setRenameTarget] = useState<ProjectInfo | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameNameErrorKey, setRenameNameErrorKey] = useState<string | null>(
    null,
  );

  const [deleteTargets, setDeleteTargets] = useState<ProjectInfo[] | null>(null);
  const [validationReport, setValidationReport] =
    useState<ValidationReport | null>(null);

  const [exportTarget, setExportTarget] = useState<ProjectInfo | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<ProjectInfo | null>(null);
  const [mergePair, setMergePair] = useState<{
    leftId: string;
    rightId: string;
  } | null>(null);

  const createInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const createFormId = "projects-create-form";
  const renameFormId = "projects-rename-form";

  const busy = pending !== null;
  const openProjectId = current?.projectId ?? null;
  const errorText = error
    ? t(`common:errors.${error.code}`, {
        defaultValue: t("common:errors.UNKNOWN"),
      })
    : null;
  const selectedSet = new Set(selectedIds);
  const selectedProjects = projects.filter((project) =>
    selectedSet.has(project.projectId),
  );
  const selectedHasOpen = selectedIds.some((id) => id === openProjectId);
  const visible = visibleProjects(
    projects,
    query,
    sort,
    locale,
    (projectId) => backupStamps[projectId] ?? null,
    openProjectId,
  );
  const allVisibleSelected =
    visible.length > 0 &&
    visible.every((project) => selectedSet.has(project.projectId));
  const someVisibleSelected = visible.some((project) =>
    selectedSet.has(project.projectId),
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await projectsApi.list();
      setProjects(list);
      setBackupStamps(stampMap(list, (id) => readLastBackup(id)));
      setCheckStamps(stampMap(list, (id) => readLastCheck(id)));
      setSelectedIds((ids) =>
        ids.filter((id) => list.some((project) => project.projectId === id)),
      );
    } catch (caught) {
      setError(normalizeError(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The stamps are seeded from localStorage so the pinned row shows the right
  // labels before the list request finishes (or when the request fails).
  useEffect(() => {
    if (!openProjectId) return;
    setBackupStamps((stamps) => ({
      ...stamps,
      [openProjectId]: readLastBackup(openProjectId),
    }));
    setCheckStamps((stamps) => ({
      ...stamps,
      [openProjectId]: readLastCheck(openProjectId),
    }));
  }, [openProjectId]);

  const run = useCallback(
    async (
      action: Exclude<PendingAction, null>,
      work: () => Promise<void>,
      projectId?: string,
    ) => {
      setPending(action);
      setPendingProjectId(projectId ?? null);
      setError(null);
      try {
        await work();
      } catch (caught) {
        setError(normalizeError(caught));
      } finally {
        setPending(null);
        setPendingProjectId(null);
      }
    },
    [],
  );

  const openCreate = () => {
    setCreateName("");
    setCreateErrorKey(null);
    setError(null);
    setCreateOpen(true);
  };

  const closeCreate = () => {
    if (pending === "create") return;
    setCreateOpen(false);
    setCreateName("");
    setCreateErrorKey(null);
    setError(null);
  };

  const submitCreate = (event: FormEvent) => {
    event.preventDefault();
    if (pending === "create") return;
    const checked = checkProjectName(createName);
    if (!checked.ok) {
      setCreateErrorKey(checked.errorKey);
      return;
    }
    setCreateErrorKey(null);
    setPending("create");
    setError(null);
    void (async () => {
      try {
        const created = await projectsApi.create(checked.name);
        setCreateOpen(false);
        setCreateName("");
        await load();
        onOpened(created);
      } catch (caught) {
        const normalized = normalizeError(caught);
        if (
          normalized.code === "VALIDATION_ERROR" ||
          normalized.code === "PROJECT_LOCKED"
        ) {
          setCreateErrorKey(renameErrorKey(normalized));
        } else {
          setError(normalized);
        }
      } finally {
        setPending(null);
      }
    })();
  };

  const announceBackfill = (project: ProjectInfo) => {
    const report = project.relationBackfill;
    if (!report) return;
    const total = report.spouseCreated + report.parentCreated;
    if (total === 0) return;
    toast.info(
      t("project:relationBackfill", {
        total,
        spouse: report.spouseCreated,
        parent: report.parentCreated,
      }),
    );
  };

  const open = (project: ProjectInfo) => {
    void run(
      "open",
      async () => {
        const opened = await projectsApi.open(project.projectId);
        announceBackfill(opened);
        onOpened(opened);
      },
      project.projectId,
    );
  };

  const continueWork = () => {
    // `onOpened` already switches to the default project tab.
    if (current) onOpened(current);
  };

  const close = () => {
    void run("close", async () => {
      await projectsApi.close();
      onClosed();
      await load();
    });
  };

  const backup = () => {
    if (!current) return;
    const projectId = current.projectId;
    void run("backup", async () => {
      const file = await projectsApi.backup();
      // Storage may be unavailable; the label still shows for this session.
      const stamp = writeLastBackup(projectId) ?? new Date().toISOString();
      setBackupStamps((stamps) => ({ ...stamps, [projectId]: stamp }));
      toast.success(t("project:backupCreated"), {
        label: t("project:revealBackup"),
        onSelect: () => {
          void projectsApi.revealBackup(file).catch((caught) => {
            const normalized = normalizeError(caught);
            toast.error(
              t(`common:errors.${normalized.code}`, {
                defaultValue: t("common:errors.UNKNOWN"),
              }),
            );
          });
        },
      });
    });
  };

  const validate = () => {
    if (!current) return;
    const projectId = current.projectId;
    void run("validate", async () => {
      const result = await projectsApi.validate();
      setValidationReport(result);
      const stamp = writeLastCheck(projectId, result.checkedAt);
      if (stamp) {
        setCheckStamps((stamps) => ({ ...stamps, [projectId]: stamp }));
      }
    });
  };

  const openRename = (project: ProjectInfo) => {
    setError(null);
    setRenameNameErrorKey(null);
    setRenameName(project.name);
    setRenameTarget(project);
  };

  const closeRename = () => {
    if (pending === "rename") return;
    setRenameTarget(null);
    setRenameName("");
    setRenameNameErrorKey(null);
    setError(null);
  };

  const submitRename = (event: FormEvent) => {
    event.preventDefault();
    if (pending === "rename") return;
    const target = renameTarget;
    if (!target) return;
    const checked = checkProjectName(renameName);
    if (!checked.ok) {
      setRenameNameErrorKey(checked.errorKey);
      return;
    }
    setRenameNameErrorKey(null);
    setPending("rename");
    setError(null);
    void (async () => {
      try {
        const renamed = await projectsApi.rename(target.projectId, checked.name);
        setProjects((list) =>
          list.map((project) =>
            project.projectId === target.projectId
              ? { ...project, ...renamed }
              : project,
          ),
        );
        setRenameTarget(null);
        setRenameName("");
        toast.success(t("project:renamed", { name: renamed.name }));
        if (current?.projectId === target.projectId) onRenamed?.(renamed);
      } catch (caught) {
        const normalized = normalizeError(caught);
        if (
          normalized.code === "VALIDATION_ERROR" ||
          normalized.code === "PROJECT_LOCKED"
        ) {
          setRenameNameErrorKey(renameErrorKey(normalized));
        } else {
          setError(normalized);
        }
      } finally {
        setPending(null);
      }
    })();
  };

  const requestDelete = (project: ProjectInfo) => {
    setError(null);
    setDeleteTargets([project]);
  };

  const requestBulkDelete = () => {
    if (selectedProjects.length === 0) return;
    setError(null);
    setDeleteTargets(selectedProjects);
  };

  const confirmDelete = () => {
    const targets = deleteTargets;
    if (!targets || targets.length === 0) return;
    void run("delete", async () => {
      const removed: string[] = [];
      try {
        for (const project of targets) {
          await projectsApi.remove(project.projectId);
          removed.push(project.projectId);
        }
      } catch (caught) {
        // Keep only the projects that are still there so a retry does not hit
        // PROJECT_NOT_FOUND for rows this loop already removed.
        setDeleteTargets(
          targets.filter((project) => !removed.includes(project.projectId)),
        );
        throw caught;
      } finally {
        // Reload even after a partial failure so the table tells the truth.
        setSelectedIds([]);
        await load();
      }
      setDeleteTargets(null);
      toast.success(t("project:deleted"));
    });
  };

  const changeQuery = (value: string) => {
    setQuery(value);
    // Hidden rows must not stay selected: a bulk action has to match what the
    // user sees.
    setSelectedIds([]);
  };

  const toggleSelect = (projectId: string, checked: boolean) => {
    setSelectedIds((ids) =>
      checked
        ? ids.includes(projectId)
          ? ids
          : [...ids, projectId]
        : ids.filter((id) => id !== projectId),
    );
  };

  const toggleSelectAll = (checked: boolean) => {
    setSelectedIds(checked ? visible.map((project) => project.projectId) : []);
  };

  const mergeSelected = () => {
    if (selectedProjects.length !== 2) return;
    const [left, right] = [...selectedProjects].sort(
      (a, b) =>
        b.persons - a.persons ||
        a.name.localeCompare(b.name, locale, { sensitivity: "base" }),
    );
    setMergePair({ leftId: left.projectId, rightId: right.projectId });
  };

  const mergeWith = (project: ProjectInfo) => {
    const right =
      current && current.projectId !== project.projectId
        ? current
        : projects.find((item) => item.projectId !== project.projectId);
    if (!right) return;
    setMergePair({ leftId: project.projectId, rightId: right.projectId });
  };

  const rowMenu = (project: ProjectInfo, isOpen: boolean): MenuItem[] => {
    const items: MenuItem[] = [];

    if (isOpen) {
      items.push(
        {
          id: "backup",
          label: t("project:backup"),
          icon: <ArchiveRegular fontSize={16} />,
          disabled: busy && pending !== "backup",
          disabledReason: t("project:busyHint"),
          onSelect: backup,
        },
        {
          id: "restore",
          label: t("project:restore"),
          icon: <HistoryRegular fontSize={16} />,
          disabled: busy,
          disabledReason: t("project:busyHint"),
          onSelect: () => setRestoreTarget(project),
        },
        {
          id: "validate",
          label: t("project:validate"),
          icon: <ShieldCheckmarkRegular fontSize={16} />,
          disabled: busy && pending !== "validate",
          disabledReason: t("project:busyHint"),
          onSelect: validate,
        },
        {
          id: "export",
          label: t("project:export"),
          icon: <ArrowDownloadRegular fontSize={16} />,
          disabled: busy,
          disabledReason: t("project:busyHint"),
          onSelect: () => setExportTarget(project),
        },
        { id: "divider-open", label: "", divider: true },
        {
          id: "close",
          label: t("project:close"),
          icon: <DismissRegular fontSize={16} />,
          disabled: busy && pending !== "close",
          disabledReason: t("project:busyHint"),
          onSelect: close,
        },
        { id: "divider-common", label: "", divider: true },
      );
    }

    items.push(
      {
        id: "rename",
        label: t("project:rename"),
        icon: <EditRegular fontSize={16} />,
        disabled: project.readOnly || busy,
        disabledReason: project.readOnly
          ? t("project:nameReadOnly")
          : t("project:busyHint"),
        onSelect: () => openRename(project),
      },
      {
        id: "merge",
        label: t("project:mergeWith"),
        icon: <MergeRegular fontSize={16} />,
        disabled: projects.length < 2 || busy,
        disabledReason:
          projects.length < 2
            ? t("project:merge.needTwoProjects")
            : t("project:busyHint"),
        onSelect: () => mergeWith(project),
      },
    );

    if (!isOpen) {
      items.push(
        {
          id: "restore",
          label: t("project:restore"),
          icon: <HistoryRegular fontSize={16} />,
          disabled: busy,
          disabledReason: t("project:busyHint"),
          onSelect: () => setRestoreTarget(project),
        },
        {
          id: "export",
          label: t("project:export"),
          icon: <ArrowDownloadRegular fontSize={16} />,
          disabled: busy,
          disabledReason: t("project:busyHint"),
          onSelect: () => setExportTarget(project),
        },
      );
    }

    items.push({
      id: "delete",
      label: t("project:delete"),
      icon: <DeleteRegular fontSize={16} />,
      danger: true,
      disabled: isOpen || busy,
      disabledReason: isOpen
        ? t("project:deleteOpenHint")
        : t("project:busyHint"),
      onSelect: () => requestDelete(project),
    });

    return items;
  };

  const createValidation = createErrorKey
    ? t(createErrorKey, { max: PROJECT_NAME_MAX_LENGTH })
    : undefined;
  const renameValidation = renameNameErrorKey
    ? t(renameNameErrorKey, { max: PROJECT_NAME_MAX_LENGTH })
    : undefined;
  const deleteOne = deleteTargets?.length === 1 ? deleteTargets[0] : null;

  const changeSort = (key: ProjectSort) => {
    setSort((current) => {
      const next: ProjectSortState =
        current.key === key
          ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
          : { key, direction: defaultSortDirection(key) };
      writeSortState(next);
      return next;
    });
  };

  const ariaSort = (key: ProjectSort) =>
    sort.key === key
      ? sort.direction === "asc"
        ? "ascending"
        : "descending"
      : "none";

  const sortHeader = (key: ProjectSort, label: string) => {
    const active = sort.key === key;
    const Icon = active
      ? sort.direction === "asc"
        ? ArrowUpRegular
        : ArrowDownRegular
      : ArrowSortRegular;
    return (
      <button
        type="button"
        className="projects-sort-header"
        data-active={active ? "true" : undefined}
        title={t(`project:sort_${key}`)}
        onClick={() => changeSort(key)}
      >
        {label}
        <Icon fontSize={12} aria-hidden="true" className="projects-sort-icon" />
      </button>
    );
  };

  return (
    <div className="projects-page">
      <div className="projects-panel">
        <header className="projects-header">
          <div className="projects-header-title">
            <h1 className="page-title">{t("project:title")}</h1>
            {!loading && projects.length > 0 ? (
              <Badge appearance="tint" color="subtle" size="small">
                {t("project:projectCount", { count: projects.length })}
              </Badge>
            ) : null}
          </div>

          <div className="projects-header-actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setImportOpen(true)}
            >
              <DocumentArrowRightRegular fontSize={18} aria-hidden="true" />
              {t("project:importButton")}
            </Button>
            <Button
              variant="primary"
              className="projects-create-open"
              data-tour="projects-create"
              disabled={busy}
              onClick={openCreate}
            >
              <FolderAddRegular fontSize={18} aria-hidden="true" />
              {t("project:create")}
            </Button>
          </div>
        </header>

        {errorText ? (
          <MessageBar intent="error">
            <MessageBarBody>{errorText}</MessageBarBody>
          </MessageBar>
        ) : null}

        {!loading && projects.length === 0 && !error ? (
          <section
            className="projects-empty"
            aria-labelledby="projects-empty-title"
          >
            <div className="projects-empty-inner">
              <div className="projects-empty-icon" aria-hidden="true">
                <FolderSearchRegular fontSize={30} />
              </div>
              <h2 id="projects-empty-title" className="projects-empty-title">
                {t("project:emptyTitle")}
              </h2>
              <p className="projects-empty-hint">{t("project:emptyHint")}</p>

              <div className="projects-empty-options">
                <button
                  type="button"
                  className="projects-empty-option"
                  onClick={openCreate}
                >
                  <span
                    className="projects-empty-option-icon"
                    aria-hidden="true"
                  >
                    <FolderAddRegular fontSize={20} />
                  </span>
                  <span className="projects-empty-option-title">
                    {t("project:emptyCreateTitle")}
                  </span>
                  <span className="projects-empty-option-hint">
                    {t("project:emptyCreateHint")}
                  </span>
                  <span
                    className="projects-empty-option-cta"
                    aria-hidden="true"
                  >
                    {t("project:emptyStart")}
                    <ArrowRightRegular fontSize={14} />
                  </span>
                </button>

                <button
                  type="button"
                  className="projects-empty-option"
                  onClick={() => setImportOpen(true)}
                >
                  <span
                    className="projects-empty-option-icon projects-empty-option-icon-import"
                    aria-hidden="true"
                  >
                    <DocumentArrowRightRegular fontSize={20} />
                  </span>
                  <span className="projects-empty-option-title">
                    {t("project:emptyImportTitle")}
                  </span>
                  <span className="projects-empty-option-hint">
                    {t("project:emptyImportHint")}
                  </span>
                  <span
                    className="projects-empty-option-cta"
                    aria-hidden="true"
                  >
                    {t("project:emptyChooseFile")}
                    <ArrowRightRegular fontSize={14} />
                  </span>
                </button>
              </div>
            </div>
          </section>
        ) : null}

        {loading || projects.length > 0 ? (
          <section
            className="projects-card"
            aria-label={t("project:title")}
            aria-busy={loading || undefined}
          >
            <div className="projects-toolbar">
              <div className="projects-toolbar-main">
                <div className="projects-search">
                  <Input
                    type="search"
                    value={query}
                    disabled={busy}
                    placeholder={t("project:searchPlaceholder")}
                    aria-label={t("project:searchPlaceholder")}
                    contentBefore={
                      <SearchRegular fontSize={16} aria-hidden="true" />
                    }
                    onChange={(_event, data) => changeQuery(data.value)}
                  />
                </div>
              </div>

              {selectedIds.length > 0 ? (
                <div className="projects-selection" role="status">
                  <span className="projects-selection-count">
                    {t("project:selectedCount", {
                      count: selectedIds.length,
                    })}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={selectedIds.length !== 2 || busy}
                    disabledReason={
                      selectedIds.length !== 2
                        ? t("project:merge.needTwoProjects")
                        : undefined
                    }
                    onClick={mergeSelected}
                  >
                    <MergeRegular fontSize={16} aria-hidden="true" />
                    {t("project:merge.action")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="projects-danger-text"
                    disabled={selectedHasOpen || busy}
                    disabledReason={
                      selectedHasOpen
                        ? t("project:deleteOpenHint")
                        : undefined
                    }
                    onClick={requestBulkDelete}
                  >
                    <DeleteRegular fontSize={16} aria-hidden="true" />
                    {t("project:delete")}
                  </Button>
                </div>
              ) : null}
            </div>

            {loading ? (
              <div className="projects-table-wrap" aria-hidden="true">
                <Table size="small">
                  <TableBody>
                    {[0, 1, 2].map((row) => (
                      <TableRow key={row}>
                        {[0, 1, 2, 3].map((cell) => (
                          <TableCell
                            key={cell}
                            className="projects-skeleton-cell"
                          >
                            <Skeleton>
                              <SkeletonItem size={16} />
                            </Skeleton>
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="projects-table-wrap">
                <Table
                  size="small"
                  aria-label={t("project:title")}
                  style={{ tableLayout: "auto" }}
                >
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell className="projects-select-cell">
                        <Checkbox
                          checked={
                            allVisibleSelected
                              ? true
                              : someVisibleSelected
                                ? "mixed"
                                : false
                          }
                          onChange={(_event, data) =>
                            toggleSelectAll(data.checked === true)
                          }
                          aria-label={t("project:selectAll")}
                        />
                      </TableHeaderCell>
                      <TableHeaderCell aria-sort={ariaSort("name")}>
                        {sortHeader("name", t("project:name"))}
                      </TableHeaderCell>
                      <TableHeaderCell
                        className="projects-persons-header"
                        aria-sort={ariaSort("people")}
                      >
                        {sortHeader("people", t("person:title"))}
                      </TableHeaderCell>
                      <TableHeaderCell aria-sort={ariaSort("recent")}>
                        <span className="projects-header-info">
                          {sortHeader("recent", t("project:lastBackup"))}
                          <span
                            className="projects-header-info-icon"
                            title={t("project:lastBackupHint")}
                            aria-label={t("project:lastBackupHint")}
                            role="img"
                          >
                            <InfoRegular fontSize={14} aria-hidden="true" />
                          </span>
                        </span>
                      </TableHeaderCell>
                      <TableHeaderCell className="projects-actions-header">
                        {t("common:fields.actions")}
                      </TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((project) => {
                      const isOpen = current?.projectId === project.projectId;
                      const rowPending = pendingProjectId === project.projectId;
                      const stamp = backupStamps[project.projectId] ?? null;
                      const stale = isStaleStamp(stamp, now);
                      const stampText = formatRelativeStamp(
                        stamp,
                        locale,
                        now,
                        t("project:justNow"),
                        t("project:emptyValue"),
                      );
                      const stampTitle = stale
                        ? `${t("project:staleBackupHint")} · ${formatBackupStamp(
                            stamp,
                            locale,
                            t("project:emptyValue"),
                          )}`
                        : formatBackupStamp(
                            stamp,
                            locale,
                            t("project:emptyValue"),
                          );
                      return (
                        <TableRow
                          key={project.projectId}
                          className={
                            isOpen ? "projects-row-current" : undefined
                          }
                        >
                          <TableCell className="projects-select-cell">
                            <Checkbox
                              checked={selectedSet.has(project.projectId)}
                              onChange={(_event, data) =>
                                toggleSelect(
                                  project.projectId,
                                  data.checked === true,
                                )
                              }
                              aria-label={t("project:selectProject", {
                                name: project.name,
                              })}
                            />
                          </TableCell>
                          <TableCell>
                            <div className="projects-name-cell">
                              <span className="projects-name-text">
                                {project.name}
                              </span>
                              {isOpen ? (
                                <Badge
                                  appearance="tint"
                                  color="informative"
                                  size="small"
                                >
                                  {t("project:openedBadge")}
                                </Badge>
                              ) : null}
                              {isOpen && !checkStamps[project.projectId] ? (
                                <span
                                  className="projects-check-dot"
                                  role="img"
                                  aria-label={t("project:checkNever")}
                                  title={t("project:checkNever")}
                                />
                              ) : null}
                              {project.readOnly ? (
                                <Badge
                                  appearance="tint"
                                  color="warning"
                                  size="small"
                                >
                                  {t("project:readOnly")}
                                </Badge>
                              ) : null}
                            </div>
                          </TableCell>
                          <TableCell>
                            {t("person:count", { count: project.persons })}
                          </TableCell>
                          <TableCell
                            className="projects-cell-muted"
                            title={stampTitle}
                          >
                            <span
                              className={
                                stale ? "projects-backup-stale" : undefined
                              }
                            >
                              {stale ? (
                                <AlertRegular
                                  fontSize={14}
                                  aria-hidden="true"
                                />
                              ) : null}
                              {stampText}
                            </span>
                          </TableCell>
                          <TableCell>
                            <div className="projects-row-actions">
                              {isOpen ? (
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  className="projects-row-primary"
                                  disabled={busy}
                                  onClick={continueWork}
                                >
                                  {t("project:continueShort")}
                                </Button>
                              ) : (
                                <Button
                                  variant="primary"
                                  size="sm"
                                  className="projects-row-primary"
                                  loading={pending === "open" && rowPending}
                                  disabled={
                                    busy && !(pending === "open" && rowPending)
                                  }
                                  onClick={() => open(project)}
                                >
                                  {t("project:open")}
                                </Button>
                              )}
                              <MenuButton
                                align="end"
                                iconOnly
                                dense
                                label={t("project:rowActions")}
                                items={rowMenu(project, isOpen)}
                              />
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>

                {visible.length === 0 ? (
                  <p className="projects-no-results">
                    {t("project:noResults")}
                  </p>
                ) : null}
              </div>
            )}

            {!loading ? (
              <div className="projects-footer">
                <span>
                  {t("project:totalCount", { count: projects.length })}
                </span>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>

      <Dialog
        open={createOpen}
        size="sm"
        title={t("project:createDialogTitle")}
        onClose={closeCreate}
        busy={pending === "create"}
        initialFocusRef={createInputRef}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={pending === "create"}
              onClick={closeCreate}
            >
              {t("common:actions.cancel")}
            </Button>
            <Button
              type="submit"
              form={createFormId}
              variant="primary"
              className="projects-create-submit"
              loading={pending === "create"}
            >
              {t("project:create")}
            </Button>
          </>
        }
      >
        <form id={createFormId} onSubmit={submitCreate} noValidate>
          <Field
            label={t("project:name")}
            required
            validationMessage={createValidation}
            validationState={createErrorKey ? "error" : "none"}
          >
            <Input
              ref={createInputRef}
              value={createName}
              placeholder={t("project:name")}
              autoComplete="off"
              disabled={pending === "create"}
              onChange={(_event, data) => {
                setCreateName(data.value);
                if (createErrorKey) setCreateErrorKey(null);
              }}
            />
          </Field>
          {errorText ? (
            <MessageBar intent="error" className="projects-dialog-error">
              <MessageBarBody>{errorText}</MessageBarBody>
            </MessageBar>
          ) : null}
        </form>
      </Dialog>

      <Dialog
        open={renameTarget !== null}
        size="sm"
        title={t("project:rename")}
        onClose={closeRename}
        busy={pending === "rename"}
        initialFocusRef={renameInputRef}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={pending === "rename"}
              onClick={closeRename}
            >
              {t("common:actions.cancel")}
            </Button>
            <Button
              type="submit"
              form={renameFormId}
              variant="primary"
              loading={pending === "rename"}
            >
              {t("common:actions.save")}
            </Button>
          </>
        }
      >
        <form id={renameFormId} onSubmit={submitRename} noValidate>
          <Field
            label={t("project:renameLabel")}
            required
            validationMessage={renameValidation}
            validationState={renameNameErrorKey ? "error" : "none"}
          >
            <Input
              ref={renameInputRef}
              value={renameName}
              autoComplete="off"
              disabled={pending === "rename"}
              onChange={(_event, data) => {
                setRenameName(data.value);
                if (renameNameErrorKey) setRenameNameErrorKey(null);
              }}
            />
          </Field>
          {errorText ? (
            <MessageBar intent="error" className="projects-dialog-error">
              <MessageBarBody>{errorText}</MessageBarBody>
            </MessageBar>
          ) : null}
        </form>
      </Dialog>

      <Dialog
        open={deleteTargets !== null}
        size="sm"
        title={
          deleteOne ? t("project:deleteTitle") : t("project:bulkDeleteTitle")
        }
        description={
          deleteOne
            ? t("project:confirmDelete", { name: deleteOne.name })
            : t("project:confirmBulkDelete", {
                count: deleteTargets?.length ?? 0,
              })
        }
        onClose={() => {
          if (pending !== "delete") setDeleteTargets(null);
        }}
        busy={pending === "delete"}
        initialFocusRef={cancelDeleteRef}
        footer={
          <>
            <Button
              ref={cancelDeleteRef}
              variant="ghost"
              disabled={pending === "delete"}
              onClick={() => setDeleteTargets(null)}
            >
              {t("common:actions.cancel")}
            </Button>
            <Button
              variant="danger"
              loading={pending === "delete"}
              disabled={pending !== "delete" && busy}
              onClick={confirmDelete}
            >
              {t("common:actions.delete")}
            </Button>
          </>
        }
      >
        <p className="projects-hint">{t("project:deleteHint")}</p>
        {errorText ? (
          <MessageBar intent="error">
            <MessageBarBody>{errorText}</MessageBarBody>
          </MessageBar>
        ) : null}
      </Dialog>

      <Dialog
        open={validationReport !== null}
        size="md"
        title={t("project:validate")}
        onClose={() => setValidationReport(null)}
        footer={
          <Button
            variant="secondary"
            onClick={() => setValidationReport(null)}
          >
            {t("common:actions.close")}
          </Button>
        }
      >
        {validationReport ? (
          <ValidationSummary
            report={validationReport}
            locale={locale}
            emptyLabel={t("project:emptyValue")}
            onOpenEvent={onOpenEvent}
          />
        ) : null}
      </Dialog>

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(imported) => {
          setImportOpen(false);
          void load();
          announceBackfill(imported);
          onOpened(imported);
        }}
      />

      {exportTarget ? (
        <ProjectExportDialog
          project={exportTarget}
          open
          onClose={() => setExportTarget(null)}
        />
      ) : null}

      {restoreTarget ? (
        <ProjectRestoreDialog
          project={restoreTarget}
          open
          onClose={() => setRestoreTarget(null)}
          onRestored={(restored) => {
            setRestoreTarget(null);
            announceBackfill(restored);
            onOpened(restored);
          }}
        />
      ) : null}

      <ProjectMergeDialog
        open={mergePair !== null}
        projects={projects}
        current={current}
        initialPair={mergePair}
        onClose={() => setMergePair(null)}
        onOpened={(merged) => {
          setMergePair(null);
          setSelectedIds([]);
          announceBackfill(merged);
          onOpened(merged);
          void load();
        }}
      />
    </div>
  );
}
