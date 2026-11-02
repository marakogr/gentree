import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  Badge,
  MessageBar,
  MessageBarBody,
  ProgressBar,
  Text,
} from "@fluentui/react-components";
import {
  ArrowUploadRegular,
  DismissRegular,
  FolderOpenRegular,
} from "@fluentui/react-icons";
import { importApi } from "../../api/client";
import type { ImportReport, ProjectInfo } from "../../api/types";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { useToast } from "../../components/ui/toast";
import { normalizeError, type AppErrorEnvelope } from "../../lib/errors";
import {
  IMPORT_EXTENSIONS,
  canImport,
  importFileLabel,
  modeLabelKey,
  reportCounts,
  reportNotes,
  type ImportMode,
} from "./helpers";
import "./import.css";

type Props = {
  open: boolean;
  onClose: () => void;
  /** The backend already opened the new project. */
  onImported: (project: ProjectInfo) => void;
};

/**
 * Import as a single modal: drop or pick one AT5/GEDCOM file and an optional
 * media folder. The reader is detected from the file content (extension as a
 * fallback), then a dry-run preview gates the import button.
 */
export function ImportDialog({ open: dialogOpen, onClose, onImported }: Props) {
  const { t } = useTranslation(["import", "common"]);
  const toast = useToast();

  const [filePath, setFilePath] = useState("");
  const [mode, setMode] = useState<ImportMode | null>(null);
  const [mediaDir, setMediaDir] = useState("");
  const [preview, setPreview] = useState<ImportReport | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<AppErrorEnvelope | null>(null);
  const [localErrorKey, setLocalErrorKey] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const previewToken = useRef(0);
  const probeToken = useRef(0);

  // A fresh open never inherits a previous file or report.
  useEffect(() => {
    if (!dialogOpen) return;
    probeToken.current += 1;
    previewToken.current += 1;
    setFilePath("");
    setMode(null);
    setMediaDir("");
    setPreview(null);
    setPreviewing(false);
    setImporting(false);
    setError(null);
    setLocalErrorKey(null);
    setDragActive(false);
  }, [dialogOpen]);

  const applyPath = useCallback(async (path: string) => {
    const token = probeToken.current + 1;
    probeToken.current = token;
    setError(null);
    setLocalErrorKey(null);
    try {
      const probe = await importApi.probe(path);
      if (token !== probeToken.current) return;
      if (probe.isDir) {
        setMediaDir(path);
        return;
      }
      if (!probe.format) {
        setFilePath("");
        setMode(null);
        setPreview(null);
        setLocalErrorKey("import:unsupportedFile");
        return;
      }
      setFilePath(path);
      setMode(probe.format);
    } catch (caught) {
      if (token === probeToken.current) setError(normalizeError(caught));
    }
  }, []);

  const handleDrop = useCallback(
    async (paths: string[]) => {
      setDragActive(false);
      setError(null);
      setLocalErrorKey(null);

      let file: { path: string; mode: ImportMode } | null = null;
      let folder: string | null = null;
      for (const path of paths) {
        if (file && folder) break;
        try {
          const probe = await importApi.probe(path);
          if (probe.isDir) {
            folder ??= path;
          } else if (probe.format && !file) {
            file = { path, mode: probe.format };
          }
        } catch (caught) {
          setError(normalizeError(caught));
        }
      }

      if (file) {
        setFilePath(file.path);
        setMode(file.mode);
      }
      if (folder) setMediaDir(folder);
      if (!file && !folder) {
        setLocalErrorKey("import:unsupportedFile");
      }
    },
    [],
  );

  // Tauri intercepts OS drops (dragDropEnabled defaults to true), so the web
  // page never sees HTML5 file drops; the webview event carries real paths.
  useEffect(() => {
    if (!dialogOpen || importing) return undefined;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setDragActive(true);
        } else if (payload.type === "leave") {
          setDragActive(false);
        } else if (payload.type === "drop") {
          setDragActive(false);
          void handleDrop(payload.paths);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Picking still works when event permissions are unavailable.
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [dialogOpen, importing, handleDrop]);

  // Dry-run every change of the file or media folder; a token drops responses
  // that belong to an older selection.
  useEffect(() => {
    if (!dialogOpen) {
      previewToken.current += 1;
      return;
    }
    const path = filePath.trim();
    if (!path || !mode) {
      setPreview(null);
      setPreviewing(false);
      return;
    }

    const token = previewToken.current + 1;
    previewToken.current = token;
    setPreviewing(true);
    setPreview(null);
    setError(null);

    const mediaDirs = mediaDir.trim() === "" ? [] : [mediaDir.trim()];
    const request =
      mode === "at5"
        ? importApi.previewAt5(path, mediaDirs)
        : importApi.previewGedcom(path, mediaDirs);

    void request
      .then((result) => {
        if (token === previewToken.current) setPreview(result.report);
      })
      .catch((caught) => {
        if (token === previewToken.current) setError(normalizeError(caught));
      })
      .finally(() => {
        if (token === previewToken.current) setPreviewing(false);
      });

    return () => {
      previewToken.current += 1;
    };
  }, [dialogOpen, filePath, mediaDir, mode]);

  const chooseFile = () => {
    void (async () => {
      setError(null);
      setLocalErrorKey(null);
      try {
        const selected = await open({
          multiple: false,
          directory: false,
          title: t("import:pickFileTitle"),
          filters: [
            {
              name: t("import:filterAll"),
              extensions: [...IMPORT_EXTENSIONS],
            },
          ],
        });
        const chosen = Array.isArray(selected) ? selected[0] : selected;
        if (typeof chosen === "string") await applyPath(chosen);
      } catch (caught) {
        setError(normalizeError(caught));
      }
    })();
  };

  const chooseMediaDir = () => {
    void (async () => {
      setError(null);
      setLocalErrorKey(null);
      try {
        const selected = await open({
          directory: true,
          multiple: false,
          title: t("import:pickMediaFolderTitle"),
        });
        const chosen = Array.isArray(selected) ? selected[0] : selected;
        if (typeof chosen === "string") setMediaDir(chosen);
      } catch (caught) {
        setError(normalizeError(caught));
      }
    })();
  };

  const clearFile = () => {
    previewToken.current += 1;
    setFilePath("");
    setMode(null);
    setPreview(null);
    setPreviewing(false);
    setError(null);
    setLocalErrorKey(null);
  };

  const clearMedia = () => {
    setMediaDir("");
    setPreview(null);
  };

  const runImport = () => {
    if (!filePath || !mode || !canImport(preview) || importing) return;
    const path = filePath;
    const mediaDirs = mediaDir.trim() === "" ? [] : [mediaDir.trim()];
    setImporting(true);
    setError(null);
    setLocalErrorKey(null);

    const request =
      mode === "at5"
        ? importApi.importAt5(path, mediaDirs)
        : importApi.importGedcom(path, mediaDirs);

    void request
      .then((result) => {
        toast.success(
          t("import:projectCreated", { name: result.project.name }),
        );
        setImporting(false);
        onImported(result.project);
      })
      .catch((caught) => {
        setImporting(false);
        setError(normalizeError(caught));
      });
  };

  const errorText = error
    ? t(`common:errors.${error.code}`, {
        defaultValue: t("common:errors.UNKNOWN"),
      })
    : null;
  const localErrorText = localErrorKey ? t(localErrorKey) : null;
  const message = localErrorText ?? errorText;
  const notes = preview ? reportNotes(preview) : null;
  const mediaNotice = t(
    mode === "gedcom" ? "import:mediaCopiedNotice" : "import:mediaNotice",
  );

  return (
    <Dialog
      open={dialogOpen}
      size="md"
      title={t("import:title")}
      description={t("import:dialogHint")}
      onClose={onClose}
      busy={importing}
      footer={
        <>
          <Button variant="ghost" disabled={importing} onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            variant="primary"
            loading={importing}
            disabled={!canImport(preview) || previewing || importing}
            onClick={runImport}
          >
            {importing ? t("import:importing") : t("import:import")}
          </Button>
        </>
      }
    >
      <div className="import-dialog">
        <div className="import-field">
          <span className="import-label">{t("import:fileLabel")}</span>
          <button
            type="button"
            className={`import-dropzone${dragActive ? " import-dropzone-active" : ""}${
              filePath ? " import-dropzone-filled" : ""
            }`}
            disabled={importing}
            onClick={chooseFile}
          >
            <span className="import-dropzone-icon" aria-hidden="true">
              <ArrowUploadRegular />
            </span>
            <span className="import-dropzone-body">
              <span className="import-dropzone-title">
                {filePath
                  ? importFileLabel(filePath)
                  : t("import:chooseFileCta")}
              </span>
              <span className="import-dropzone-hint">
                {dragActive ? t("import:dropActive") : t("import:fileHint")}
              </span>
            </span>
            {mode ? (
              <Badge appearance="tint" color="informative" size="small">
                {t(modeLabelKey(mode))}
              </Badge>
            ) : null}
          </button>
          {filePath ? (
            <div className="import-selected">
              <Text
                as="span"
                size={200}
                className="import-path"
                title={filePath}
              >
                {filePath}
              </Text>
              <Button
                variant="ghost"
                size="sm"
                disabled={importing}
                aria-label={t("import:clearFile")}
                onClick={clearFile}
              >
                <DismissRegular fontSize={16} aria-hidden="true" />
              </Button>
            </div>
          ) : null}
        </div>

        <div className="import-field">
          <span className="import-label">{t("import:mediaLabel")}</span>
          <button
            type="button"
            className={`import-dropzone import-dropzone-compact${
              dragActive ? " import-dropzone-active" : ""
            }`}
            disabled={importing}
            onClick={chooseMediaDir}
          >
            <span className="import-dropzone-icon" aria-hidden="true">
              <FolderOpenRegular />
            </span>
            <span className="import-dropzone-body">
              <span className="import-dropzone-title">
                {mediaDir
                  ? importFileLabel(mediaDir)
                  : t("import:chooseMediaCta")}
              </span>
              <span className="import-dropzone-hint">
                {t("import:mediaHint")}
              </span>
            </span>
          </button>
          {mediaDir ? (
            <div className="import-selected">
              <Text
                as="span"
                size={200}
                className="import-path"
                title={mediaDir}
              >
                {mediaDir}
              </Text>
              <Button
                variant="ghost"
                size="sm"
                disabled={importing}
                aria-label={t("import:clearMedia")}
                onClick={clearMedia}
              >
                <DismissRegular fontSize={16} aria-hidden="true" />
              </Button>
            </div>
          ) : null}
        </div>

        <div className="import-status" aria-live="polite">
          {previewing ? (
            <div className="import-loading">
              <ProgressBar aria-label={t("import:previewing")} />
              <Text as="span" size={200} className="import-muted">
                {t("import:previewing")}
              </Text>
            </div>
          ) : null}

          {!previewing && preview ? (
            <div className="import-preview">
              <div className="import-counts">
                {reportCounts(preview).map(({ key, count }) => (
                  <Badge key={key} appearance="tint" size="medium">
                    {t(`import:counts.${key}`, { count })}
                  </Badge>
                ))}
              </div>
              {notes && (notes.warnings > 0 || notes.issues > 0) ? (
                <Text as="p" size={200} className="import-muted">
                  {t("import:warningsSummary", {
                    warnings: notes.warnings,
                    issues: notes.issues,
                  })}
                </Text>
              ) : null}
              {preview.media > 0 ? (
                <Text as="p" size={200} className="import-muted">
                  {mediaNotice}
                </Text>
              ) : null}
            </div>
          ) : null}
        </div>

        {message ? (
          <MessageBar intent="error">
            <MessageBarBody>{message}</MessageBarBody>
          </MessageBar>
        ) : null}
      </div>
    </Dialog>
  );
}
