import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MessageBar,
  MessageBarBody,
  Radio,
  RadioGroup,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { projectsApi } from "../../api/client";
import type { BackupInfo, ProjectInfo } from "../../api/types";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { useToast } from "../../components/ui/toast";
import { normalizeError, type AppErrorEnvelope } from "../../lib/errors";
import { useAsyncAction } from "../../lib/useAsyncAction";
import { formatBackupSize, formatBackupStamp } from "./backupStamp";

type Props = {
  project: ProjectInfo;
  open: boolean;
  onClose: () => void;
  /** The restored copy is already open in the backend; the shell switches to it. */
  onRestored: (project: ProjectInfo) => void;
};

const useStyles = makeStyles({
  list: {
    display: "grid",
    gap: tokens.spacingVerticalS,
  },
  hint: {
    display: "block",
    marginTop: tokens.spacingVerticalXS,
    color: tokens.colorNeutralForeground2,
  },
  error: {
    marginTop: tokens.spacingVerticalM,
  },
  loading: {
    display: "flex",
    justifyContent: "center",
    padding: tokens.spacingVerticalL,
  },
});

/**
 * Lists one project's backup archives and restores the selected one as a new
 * project. Restore never overwrites the source: the backend creates a fresh
 * project id and opens it.
 */
export function ProjectRestoreDialog({
  project,
  open,
  onClose,
  onRestored,
}: Props) {
  const { t, i18n } = useTranslation(["project", "common"]);
  const toast = useToast();
  const styles = useStyles();
  const { busy, error, setError, run } = useAsyncAction();
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [loadError, setLoadError] = useState<AppErrorEnvelope | null>(null);
  const [selected, setSelected] = useState("");

  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    setBackups(null);
    setLoadError(null);
    setSelected("");
    setError(null);
    void projectsApi
      .listBackups(project.projectId)
      .then((items) => {
        if (!active) return;
        setBackups(items);
        setSelected(items[0]?.backupId ?? "");
      })
      .catch((caught) => {
        if (active) setLoadError(normalizeError(caught));
      });
    return () => {
      active = false;
    };
  }, [open, project.projectId, setError]);

  const restore = () => {
    if (selected === "") return;
    void run(async () => {
      const restored = await projectsApi.restoreBackup(selected);
      toast.success(t("project:restored"));
      onClose();
      onRestored(restored);
    });
  };

  const errorText = error
    ? t(`common:errors.${error.code}`, {
        defaultValue: t("common:errors.UNKNOWN"),
      })
    : null;
  const loadErrorText = loadError
    ? t(`common:errors.${loadError.code}`, {
        defaultValue: t("common:errors.UNKNOWN"),
      })
    : null;

  return (
    <Dialog
      open={open}
      title={t("project:restoreTitle")}
      description={t("project:restoreHint")}
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
            loading={busy}
            disabled={selected === "" || backups === null}
            onClick={restore}
          >
            {t("project:restoreAction")}
          </Button>
        </>
      }
    >
      {loadErrorText ? (
        <MessageBar className={styles.error} intent="error">
          <MessageBarBody>{loadErrorText}</MessageBarBody>
        </MessageBar>
      ) : null}

      {backups === null && loadErrorText === null ? (
        <div className={styles.loading}>
          <Spinner size="small" label={t("project:restoreLoading")} />
        </div>
      ) : null}

      {backups !== null && backups.length === 0 ? (
        <div>
          <Text as="p" size={300}>
            {t("project:restoreEmpty")}
          </Text>
          <Text as="span" size={200} className={styles.hint}>
            {t("project:restoreEmptyHint")}
          </Text>
        </div>
      ) : null}

      {backups !== null && backups.length > 0 ? (
        <RadioGroup
          className={styles.list}
          layout="vertical"
          value={selected}
          disabled={busy}
          aria-label={t("project:restoreSelect")}
          onChange={(_event, data) => setSelected(data.value)}
        >
          {backups.map((backup) => (
            <Radio
              key={backup.backupId}
              value={backup.backupId}
              label={t("project:restoreMeta", {
                date: formatBackupStamp(
                  backup.createdAt,
                  i18n.language,
                  t("project:emptyValue"),
                ),
                size: formatBackupSize(backup.sizeBytes),
              })}
            />
          ))}
        </RadioGroup>
      ) : null}

      {errorText ? (
        <MessageBar className={styles.error} intent="error">
          <MessageBarBody>{errorText}</MessageBarBody>
        </MessageBar>
      ) : null}
    </Dialog>
  );
}
