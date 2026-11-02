// Project block at the top of the sidebar: inline rename (Enter saves, Esc
// cancels), the "..." menu and the project tabs.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  Divider,
  Input,
  Text,
} from "@fluentui/react-components";
import {
  CheckmarkRegular,
  DismissRegular,
  EditRegular,
} from "@fluentui/react-icons";
import { projectsApi } from "../api/client";
import type { ProjectInfo, ValidationReport } from "../api/types";
import { normalizeError } from "../lib/errors";
import { PROJECT_NAME_MAX_LENGTH } from "../features/projects/nameRules";
import { ProjectExportDialog } from "../features/projects/ProjectExportDialog";
import { ProjectMergeDialog } from "../features/projects/ProjectMergeDialog";
import { ProjectRestoreDialog } from "../features/projects/ProjectRestoreDialog";
import { ValidationSummary } from "../features/projects/ValidationSummary";
import { writeLastCheck } from "../features/projects/backupStamp";
import { Dialog } from "./ui/dialog";
import { MenuButton } from "./ui/menu";
import { useToast } from "./ui/toast";
import "./sidebar-project.css";

export type SidebarProjectProps = {
  project: ProjectInfo;
  collapsed?: boolean;
  children?: React.ReactNode;
  onRenamed: (project: ProjectInfo) => void;
  onClose: () => Promise<void>;
  /** The backend has already opened the restored copy; switch the shell to it. */
  onRestored: (project: ProjectInfo) => void;
};

export function SidebarProject({
  project,
  collapsed = false,
  children,
  onRenamed,
  onClose,
  onRestored,
}: SidebarProjectProps) {
  const { t, i18n } = useTranslation(["project", "common"]);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeProjects, setMergeProjects] = useState<ProjectInfo[]>([]);
  const [validationReport, setValidationReport] =
    useState<ValidationReport | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!editing) setDraft(project.name);
  }, [project.name, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const cancel = () => {
    setEditing(false);
    setError(null);
    setDraft(project.name);
    triggerRef.current?.focus();
  };

  const save = async () => {
    const name = draft.trim();
    if (name === "") {
      setError(t("project:nameRequired"));
      return;
    }
    if (name === project.name) {
      setEditing(false);
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const renamed = await projectsApi.rename(project.projectId, name);
      onRenamed(renamed);
      setEditing(false);
      toast.success(t("project:renamed", { name: renamed.name }));
    } catch (caught) {
      const normalized = normalizeError(caught);
      const rule =
        typeof normalized.params?.rule === "string"
          ? normalized.params.rule
          : null;
      if (normalized.code === "VALIDATION_ERROR" && rule === "duplicate") {
        setError(t("project:nameDuplicate"));
      } else if (normalized.code === "VALIDATION_ERROR" && rule === "required") {
        setError(t("project:nameRequired"));
      } else if (
        normalized.code === "VALIDATION_ERROR" &&
        rule === "maxLength"
      ) {
        setError(t("project:nameTooLong", { max: PROJECT_NAME_MAX_LENGTH }));
      } else {
        setError(t(`common:errors.${normalized.code}`, {
          defaultValue: t("common:errors.UNKNOWN"),
        }));
      }
    } finally {
      setBusy(false);
    }
  };

  const backup = async () => {
    try {
      const file = await projectsApi.backup();
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
    } catch (caught) {
      const normalized = normalizeError(caught);
      toast.error(
        t(`common:errors.${normalized.code}`, {
          defaultValue: t("common:errors.UNKNOWN"),
        }),
      );
    }
  };

  const close = async () => {
    try {
      await onClose();
    } catch (caught) {
      const normalized = normalizeError(caught);
      toast.error(
        t(`common:errors.${normalized.code}`, {
          defaultValue: t("common:errors.UNKNOWN"),
        }),
      );
    }
  };

  const validate = () => {
    void projectsApi.validate().then(
      (report) => {
        writeLastCheck(project.projectId, report.checkedAt);
        setValidationReport(report);
      },
      (caught) => {
        const normalized = normalizeError(caught);
        toast.error(
          t(`common:errors.${normalized.code}`, {
            defaultValue: t("common:errors.UNKNOWN"),
          }),
        );
      },
    );
  };

  const openMerge = () => {
    void projectsApi.list().then(
      (list) => {
        setMergeProjects(list);
        setMergeOpen(true);
      },
      (caught) => {
        const normalized = normalizeError(caught);
        toast.error(
          t(`common:errors.${normalized.code}`, {
            defaultValue: t("common:errors.UNKNOWN"),
          }),
        );
      },
    );
  };

  const menuItems = [
    {
      id: "rename",
      label: t("project:rename"),
      icon: <EditRegular fontSize={16} aria-hidden="true" />,
      disabled: project.readOnly,
      disabledReason: project.readOnly ? t("project:nameReadOnly") : undefined,
      onSelect: () => setEditing(true),
    },
    { id: "divider-data", label: "", divider: true },
    {
      id: "backup",
      label: t("common:app.backup"),
      onSelect: backup,
    },
    {
      id: "restore",
      label: t("project:restore"),
      onSelect: () => setRestoreOpen(true),
    },
    {
      id: "validate",
      label: t("common:app.validate"),
      onSelect: validate,
    },
    {
      id: "export",
      label: t("project:export"),
      onSelect: () => setExportOpen(true),
    },
    { id: "divider-common", label: "", divider: true },
    {
      id: "merge",
      label: t("project:mergeWith"),
      onSelect: openMerge,
    },
    { id: "divider-close", label: "", divider: true },
    {
      id: "close",
      label: t("common:app.closeProject"),
      danger: true,
      onSelect: () => void close(),
    },
  ];

  if (collapsed) {
    return (
      <div className="sidebar-project sidebar-project-collapsed">
        <Divider className="sidebar-project-divider" />
        {children}
      </div>
    );
  }

  return (
    <div className="sidebar-project">
      <Divider className="sidebar-project-divider" />
      <div className="sidebar-project-head">
        {editing ? (
          <form
            className="sidebar-project-edit"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <Input
              ref={inputRef}
              className="sidebar-project-input"
              size="small"
              value={draft}
              aria-label={t("project:name")}
              aria-invalid={error !== null}
              onChange={(_, data) => setDraft(data.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancel();
                }
              }}
            />
            <Button
              type="submit"
              appearance="subtle"
              icon={<CheckmarkRegular fontSize={20} aria-hidden="true" />}
              aria-label={t("common:actions.save")}
              title={t("common:actions.save")}
              disabled={busy}
            />
            <Button
              type="button"
              appearance="subtle"
              icon={<DismissRegular fontSize={20} aria-hidden="true" />}
              aria-label={t("common:actions.cancel")}
              title={t("common:actions.cancel")}
              disabled={busy}
              onClick={cancel}
            />
          </form>
        ) : (
          <>
            <Button
              ref={triggerRef}
              appearance="subtle"
              className="sidebar-project-name"
              title={t("project:renameHint")}
              onClick={() => setEditing(true)}
            >
              <Text
                as="span"
                weight="semibold"
                truncate
                className="sidebar-project-title"
              >
                {project.name}
              </Text>
              {project.readOnly ? (
                <Badge appearance="tint" size="small" color="informative">
                  {t("common:app.readOnly")}
                </Badge>
              ) : null}
            </Button>
            <MenuButton
              label={t("common:app.projectMenu")}
              iconOnly
              align="end"
              items={menuItems}
            />
          </>
        )}
      </div>
      {error ? (
        <Text className="field-error" role="alert">
          {error}
        </Text>
      ) : null}
      {children}
      <ProjectExportDialog
        project={project}
        open={exportOpen}
        onClose={() => setExportOpen(false)}
      />
      <ProjectRestoreDialog
        project={project}
        open={restoreOpen}
        onClose={() => setRestoreOpen(false)}
        onRestored={onRestored}
      />
      <ProjectMergeDialog
        open={mergeOpen}
        projects={mergeProjects}
        current={project}
        onClose={() => setMergeOpen(false)}
        onOpened={(merged) => {
          setMergeOpen(false);
          onRestored(merged);
        }}
      />
      <Dialog
        open={validationReport !== null}
        size="md"
        title={t("project:validate")}
        onClose={() => setValidationReport(null)}
        footer={
          <Button
            appearance="secondary"
            onClick={() => setValidationReport(null)}
          >
            {t("common:actions.close")}
          </Button>
        }
      >
        {validationReport ? (
          <ValidationSummary
            report={validationReport}
            locale={i18n.language}
            emptyLabel={t("project:emptyValue")}
          />
        ) : null}
      </Dialog>
    </div>
  );
}
