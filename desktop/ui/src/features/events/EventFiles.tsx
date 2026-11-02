// Files of one event (ADR-0018). The section lives in the event dialog, so it
// can only attach to an event that already exists. Opening, saving and the
// stored path come from the shared media commands; this component only owns the
// event-scoped list, the caption edit and the detach call.

import { useEffect, useState, type KeyboardEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Input, Text } from "@fluentui/react-components";
import {
  ArrowDownloadRegular,
  AttachRegular,
  DismissRegular,
  DocumentRegular,
  OpenRegular,
} from "@fluentui/react-icons";
import { useTranslation } from "react-i18next";
import { mediaApi } from "../../api/client";
import type { MediaItem } from "../../api/types";
import { ErrorBanner } from "../../components/feedback";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty";
import { IconButton } from "../../components/ui/icon-button";
import { normalizeError, type AppErrorEnvelope } from "../../lib/errors";
import {
  eventAttachments,
  isImageMedia,
  mediaLabel,
} from "../media/helpers";

type Props = {
  eventId: string;
  /** Called after the stored files change, so the page can refresh counts. */
  onChanged?: () => void;
  disabled?: boolean;
};

export default function EventFiles({ eventId, onChanged, disabled }: Props) {
  const { t } = useTranslation(["event", "common"]);
  const [files, setFiles] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppErrorEnvelope | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    mediaApi
      .listForEvent(eventId)
      .then((items) => {
        if (active) setFiles(items);
      })
      .catch((caught: unknown) => {
        if (active) {
          setFiles([]);
          setError(normalizeError(caught));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [eventId]);

  const reload = async () => {
    setFiles(await mediaApi.listForEvent(eventId));
    onChanged?.();
  };

  const attach = () => {
    void (async () => {
      try {
        const source = await open({ multiple: false, directory: false });
        if (!source) return;
        setAttaching(true);
        await mediaApi.attachToEvent(eventId, source);
        await reload();
        setError(null);
      } catch (caught) {
        setError(normalizeError(caught));
      } finally {
        setAttaching(false);
      }
    })();
  };

  const openFile = (item: MediaItem) => {
    void mediaApi.open(item.id).catch((caught: unknown) => {
      setError(normalizeError(caught));
    });
  };

  const download = (item: MediaItem) => {
    void (async () => {
      try {
        const target = await save({ defaultPath: item.fileName });
        if (!target) return;
        await mediaApi.saveAs(item.id, target);
        setError(null);
      } catch (caught) {
        setError(normalizeError(caught));
      }
    })();
  };

  const detach = (item: MediaItem) => {
    void (async () => {
      setBusyId(item.id);
      try {
        await mediaApi.detachFromEvent(eventId, item.id);
        await reload();
        setError(null);
      } catch (caught) {
        setError(normalizeError(caught));
      } finally {
        setBusyId(null);
      }
    })();
  };

  const setCaption = (item: MediaItem, raw: string) => {
    const caption = raw.trim();
    if (caption === (item.caption ?? "")) return;
    void (async () => {
      setBusyId(item.id);
      try {
        await mediaApi.setCaption(item.id, caption === "" ? null : caption);
        await reload();
        setError(null);
      } catch (caught) {
        setError(normalizeError(caught));
      } finally {
        setBusyId(null);
      }
    })();
  };

  const commitOnEnter = (key: KeyboardEvent<HTMLInputElement>) => {
    if (key.key === "Enter") key.currentTarget.blur();
  };

  const ordered = eventAttachments(files, eventId);
  const busy = Boolean(disabled) || attaching;

  return (
    <div className="event-files">
      <div className="event-files-head">
        <h3 className="events-form-details-title">{t("event:filesTitle")}</h3>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={attach}
        >
          <AttachRegular aria-hidden="true" /> {t("event:attachFile")}
        </Button>
      </div>
      <ErrorBanner error={error} />
      {loading ? (
        <div className="event-files-loading" aria-busy="true">
          <span className="skeleton" aria-hidden="true" />
          <span className="skeleton" aria-hidden="true" />
        </div>
      ) : ordered.length === 0 ? (
        <EmptyState compact text={t("event:noFiles")} />
      ) : (
        <ul className="plain event-files-list">
          {ordered.map((item) => (
            <li key={item.id}>
              <div className="event-file">
                {isImageMedia(item) ? (
                  <img
                    className="event-file-thumb"
                    src={convertFileSrc(item.path)}
                    alt={mediaLabel(item)}
                    loading="lazy"
                  />
                ) : (
                  <DocumentRegular
                    className="event-file-icon"
                    aria-hidden="true"
                  />
                )}
                <div className="event-file-main">
                  <div className="event-file-line">
                    <Text as="span" size={200} weight="semibold">
                      {mediaLabel(item)}
                    </Text>
                    <Text size={100} className="meta">
                      {item.mimeType}
                    </Text>
                  </div>
                  <Input
                    key={`${item.id}:${item.caption ?? ""}`}
                    className="event-file-caption"
                    size="small"
                    defaultValue={item.caption ?? ""}
                    placeholder={t("event:fileCaptionPlaceholder")}
                    aria-label={t("event:fileCaption", {
                      name: mediaLabel(item),
                    })}
                    disabled={busy || busyId === item.id}
                    maxLength={500}
                    onKeyDown={commitOnEnter}
                    onBlur={(change) =>
                      setCaption(item, change.currentTarget.value)
                    }
                  />
                </div>
                <div className="event-file-actions">
                  <IconButton
                    label={t("common:actions.open")}
                    disabled={busy}
                    onClick={() => openFile(item)}
                  >
                    <OpenRegular aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label={t("event:saveFileAs")}
                    disabled={busy}
                    onClick={() => download(item)}
                  >
                    <ArrowDownloadRegular aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label={t("event:detachFile")}
                    disabled={busy || busyId === item.id}
                    onClick={() => detach(item)}
                  >
                    <DismissRegular aria-hidden="true" />
                  </IconButton>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="meta event-files-hint">{t("event:filesHint")}</p>
    </div>
  );
}
