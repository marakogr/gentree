import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import {
  MessageBar,
  MessageBarBody,
  Radio,
  RadioGroup,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { projectsApi } from "../../api/client";
import type {
  ProjectExportFormat,
  ProjectExportGedcomVersion,
  ProjectInfo,
} from "../../api/types";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { useToast } from "../../components/ui/toast";
import { useAsyncAction } from "../../lib/useAsyncAction";
import { exportFileName } from "./export";

type Props = {
  project: ProjectInfo;
  open: boolean;
  onClose: () => void;
};

const useStyles = makeStyles({
  hint: {
    display: "block",
    marginTop: tokens.spacingVerticalS,
    color: tokens.colorNeutralForeground2,
  },
  error: {
    marginTop: tokens.spacingVerticalM,
  },
});

/**
 * Format picker and native save dialog for one project. The backend builds the
 * archive; this dialog only chooses AT5/GEDCOM and the target file.
 */
export function ProjectExportDialog({ project, open, onClose }: Props) {
  const { t } = useTranslation(["project", "common"]);
  const toast = useToast();
  const styles = useStyles();
  const { busy, error, setError, run } = useAsyncAction();
  const [format, setFormat] = useState<ProjectExportFormat>("AT5");
  const [gedcomVersion, setGedcomVersion] =
    useState<ProjectExportGedcomVersion>("5.5.1");

  useEffect(() => {
    if (!open) return;
    setFormat("AT5");
    setGedcomVersion("5.5.1");
    setError(null);
  }, [open, setError]);

  const choose = () => {
    void run(async () => {
      const target = await save({
        title: t("project:exportChooseTitle"),
        defaultPath: exportFileName(project.name),
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
      if (typeof target !== "string" || target.trim() === "") return;
      const result = await projectsApi.export(
        project.projectId,
        format,
        target,
        format === "GEDCOM" ? gedcomVersion : undefined,
      );
      toast.success(t("project:exported", { file: result.fileName }));
      if (result.warnings.length > 0) {
        toast.info(
          t("project:exportWarnings", { count: result.warnings.length }),
        );
      }
      onClose();
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
      title={t("project:exportTitle")}
      description={t("project:exportHint")}
      onClose={() => {
        if (!busy) onClose();
      }}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button variant="primary" loading={busy} onClick={choose}>
            {t("project:exportAction")}
          </Button>
        </>
      }
    >
      <RadioGroup
        layout="vertical"
        value={format}
        disabled={busy}
        aria-label={t("project:exportFormat")}
        onChange={(_event, data) =>
          setFormat(data.value as ProjectExportFormat)
        }
      >
        <Radio value="AT5" label={t("project:exportAt5")} />
        <Radio value="GEDCOM" label={t("project:exportGedcom")} />
      </RadioGroup>
      {format === "GEDCOM" ? (
        <>
          <Text as="p" size={300} className={styles.hint}>
            {t("project:exportGedcomVersion")}
          </Text>
          <RadioGroup
            layout="vertical"
            value={gedcomVersion}
            disabled={busy}
            aria-label={t("project:exportGedcomVersion")}
            onChange={(_event, data) =>
              setGedcomVersion(data.value as ProjectExportGedcomVersion)
            }
          >
            <Radio value="5.5.1" label={t("project:exportGedcom551")} />
            <Radio value="7.0" label={t("project:exportGedcom70")} />
          </RadioGroup>
        </>
      ) : null}
      <Text as="p" size={300} className={styles.hint}>
        {format === "AT5"
          ? t("project:exportAt5Hint")
          : gedcomVersion === "7.0"
            ? t("project:exportGedcom70Hint")
            : t("project:exportGedcomHint")}
      </Text>
      {errorText ? (
        <MessageBar className={styles.error} intent="error">
          <MessageBarBody>{errorText}</MessageBarBody>
        </MessageBar>
      ) : null}
    </Dialog>
  );
}
