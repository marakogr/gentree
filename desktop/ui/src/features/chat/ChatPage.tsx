import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import {
  Add20Regular,
  ArrowClockwise16Regular,
  Copy16Regular,
  Delete20Regular,
  Globe16Regular,
  Send20Regular,
  Settings20Regular,
  ShieldCheckmark16Regular,
  SparkleRegular,
  Stop20Regular,
  Wrench16Regular,
} from "@fluentui/react-icons";
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Avatar,
  Button,
  Caption1,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Subtitle2,
  Textarea,
} from "@fluentui/react-components";
import { chatApi, personsApi } from "../../api/client";
import { SUPPORTED_LOCALES, type Locale } from "../../i18n";
import type {
  AppErrorEnvelope,
  ChatConfirmEvent,
  ChatDeltaEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatSkillEvent,
  ChatStatus,
  DateValue,
  Gender,
  Person,
} from "../../api/types";
import { Markdown } from "../../components/Markdown";
import { EmptyState } from "../../components/ui/empty";
import { useToast } from "../../components/ui/toast";
import { buildGuideContext } from "../help/guide";
import { normalizeError } from "../../lib/errors";
import { useDateFormatter } from "../../lib/useDateFormatter";
import type { EntityPerson } from "./entityLinks";
import { durationParts, isLocalProviderUrl } from "./format";
import { diffPerson, formatPersonName } from "./confirm";
import { rotationInterval, shouldPauseRotation } from "./rotation";
import {
  buildTranscript,
  initialChatState,
  reduceChat,
  type ChatEntry,
  type ChatToolCall,
  type ChatToolEvent,
  type ChatToolStatus,
} from "./stream";
import "./chat.css";

type Props = {
  /** Settings is reachable from every banner/state of the screen. */
  onOpenSettings: () => void;
  /** Opens a person card; person mentions stay plain without it. */
  onOpenPerson?: (personId: string) => void;
  /** The screen stays mounted while hidden, so refresh status on return. */
  active?: boolean;
  /** Chat belongs to one project; the shell remounts the screen on change. */
  projectId?: string;
  /** Prefills the composer without sending anything. */
  seed?: ChatSeed | null;
  /** Called once the seed has been placed into the composer. */
  onSeedHandled?: () => void;
};

/** A question handed to the composer; `id` makes an identical repeat distinct. */
export type ChatSeed = { id: string; text: string };

/** Reasons the backend puts into `CHAT_UNAVAILABLE.params.reason`. */
type ChatReason =
  | "disabled"
  | "missingKey"
  | "missingModel"
  | "timeout"
  | "unauthorized"
  | "unavailable"
  | "protocol"
  | "truncated"
  | "unsupported";

const REASONS: readonly ChatReason[] = [
  "disabled",
  "missingKey",
  "missingModel",
  "timeout",
  "unauthorized",
  "unavailable",
  "protocol",
  "truncated",
  "unsupported",
];

const REASON_LABEL: Record<ChatReason, string> = {
  disabled: "chat:reasonDisabled",
  missingKey: "chat:reasonMissingKey",
  missingModel: "chat:reasonMissingModel",
  timeout: "chat:reasonTimeout",
  unauthorized: "chat:reasonUnauthorized",
  unavailable: "chat:reasonUnavailable",
  protocol: "chat:reasonProtocol",
  truncated: "chat:reasonTruncated",
  unsupported: "chat:reasonUnsupported",
};

const TOOL_STATUS_LABEL: Record<ChatToolStatus, string> = {
  running: "chat:toolRunning",
  ok: "chat:toolOk",
  error: "chat:toolError",
};

/** Matches the CSS `max-height` of the composer textarea (7rem). */
const COMPOSER_MAX_HEIGHT = 112;

/**
 * Phrases shown while the answer is being prepared and tool calls are hidden.
 * They rotate so a long request does not look frozen; the first one is the
 * search, the last one is the answer being written.
 */
const WORKING_KEYS = [
  "chat:workingSearch",
  "chat:workingDates",
  "chat:workingKinship",
  "chat:workingSources",
  "chat:workingCompose",
] as const;

export default function ChatPage({
  onOpenSettings,
  onOpenPerson,
  active = true,
  projectId,
  seed = null,
  onSeedHandled,
}: Props) {
  const { t, i18n } = useTranslation(["chat", "common"]);
  const toast = useToast();
  const formatDate = useDateFormatter();
  const sendReasonId = useId();
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [statusError, setStatusError] = useState<AppErrorEnvelope | null>(null);
  const [persons, setPersons] = useState<EntityPerson[]>([]);
  const [state, dispatch] = useReducer(reduceChat, initialChatState);
  const [input, setInput] = useState("");
  const [workingIndex, setWorkingIndex] = useState(0);
  const [workingHovered, setWorkingHovered] = useState(false);
  const [workingFocused, setWorkingFocused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [confirmation, setConfirmation] = useState<ChatConfirmEvent | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // `chat_status` is an IPC snapshot: a response that started earlier must not
  // overwrite a newer one, and no state is written after unmount.
  const statusSequence = useRef(0);
  const statusAlive = useRef(true);
  const activeRequestRef = useRef<string | null>(null);

  const locale: Locale = SUPPORTED_LOCALES.includes(
    i18n.language as Locale,
  )
    ? (i18n.language as Locale)
    : "ru";
  // The guide is interface reference, not user data: it travels with every
  // request so the assistant can explain screens and buttons. The backend
  // appends it to the system prompt.
  const guide = useMemo(
    () => buildGuideContext((key) => t(key)),
    [t, i18n.language],
  );
  const statusReason = status === null ? null : reasonFromStatus(status);
  const ready = status !== null && statusReason === null;
  const streaming = state.activeRequestId !== null;
  const showTools = status?.showTools === true;
  // One condition for every tool-related affordance: the status counter, the
  // recorded calls and the skills that only make sense when tools are offered.
  const toolsVisible = ready && showTools;
  // With tool calls hidden the feed would stay empty, so the screen narrates
  // the work with a rotating line instead.
  const working = streaming && !toolsVisible;
  const localProvider =
    status !== null ? isLocalProviderUrl(status.baseUrl) : false;
  const issueReason =
    statusReason ??
    (state.error !== null ? reasonFromError(state.error) : null);
  // Reading the line or writing the next message pauses the rotation; the
  // phrase the user is looking at must not change mid-sentence.
  const rotationPaused = shouldPauseRotation(
    input,
    workingHovered,
    workingFocused,
  );

  useEffect(() => {
    statusAlive.current = true;
    return () => {
      statusAlive.current = false;
    };
  }, []);

  const loadStatus = useCallback(() => {
    const sequence = statusSequence.current + 1;
    statusSequence.current = sequence;
    void chatApi
      .status()
      .then((next) => {
        if (!statusAlive.current || statusSequence.current !== sequence) return;
        setStatus(next);
        setStatusError(null);
      })
      .catch((caught: unknown) => {
        if (!statusAlive.current || statusSequence.current !== sequence) return;
        setStatusError(normalizeError(caught));
      });
  }, []);

  // The backend keeps `chat.enabled`/key/model in its live config, so the tab
  // refetches the snapshot whenever it becomes visible and when the project
  // changes. The sequence guard above drops stale in-flight responses: an old
  // `enabled=false` cannot overwrite a fresh one.
  useEffect(() => {
    if (!active) return;
    loadStatus();
  }, [active, loadStatus, projectId]);

  // Settings writes the live config; refresh immediately instead of waiting
  // for the next activation. `focus`/`visibilitychange` also cover a key that
  // was added in Windows while the app stayed open.
  useEffect(() => {
    if (!active) return;
    const refresh = () => loadStatus();
    const onVisibility = () => {
      if (document.visibilityState === "visible") loadStatus();
    };
    window.addEventListener("gentree:settings-saved", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("gentree:settings-saved", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, loadStatus]);

  // While chat is unavailable, retry on a slow timer: enabling it in Settings
  // or adding the key in Windows must not require restarting the application.
  useEffect(() => {
    if (!active || (status !== null && statusReason === null)) return;
    const timer = window.setInterval(loadStatus, 5000);
    return () => window.clearInterval(timer);
  }, [active, status, statusReason, loadStatus]);

  // The shell remounts this screen per project (it keys ChatPage by projectId);
  // this effect keeps the same contract for a host that only passes the prop.
  // A stream of the previous project is cancelled, not left running.
  useEffect(() => {
    const requestId = activeRequestRef.current;
    if (requestId !== null) {
      void chatApi.cancel(requestId).catch(() => undefined);
    }
    dispatch({ type: "reset" });
    setInput("");
    setConfirmation(null);
  }, [projectId]);

  // One page is enough for name linking; the list is sorted for determinism.
  useEffect(() => {
    if (!active) return;
    let mounted = true;
    void personsApi
      .list({ limit: 1000, sort: "name" })
      .then((page) => {
        if (!mounted) return;
        setPersons(
          page.items.map((item) => ({
            id: item.entity.id,
            names: item.entity.names,
          })),
        );
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [active, projectId]);

  // Stream events are global; `requestId` keeps concurrent requests apart and
  // the reducer ignores events for requests it does not know.
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const register = (pending: Promise<() => void>) => {
      void pending
        .then((unlisten) => {
          if (disposed) unlisten();
          else unlisteners.push(unlisten);
        })
        .catch(() => undefined);
    };

    register(
      listen<ChatSkillEvent>("chat-skill", (event) => {
        dispatch({
          type: "skill",
          requestId: event.payload.requestId,
          skills: event.payload.skills,
        });
      }),
    );
    register(
      listen<ChatDeltaEvent>("chat-delta", (event) => {
        dispatch({
          type: "delta",
          requestId: event.payload.requestId,
          delta: event.payload.delta,
        });
      }),
    );
    register(
      listen<ChatToolEvent>("chat-tool", (event) => {
        dispatch({
          type: "tool",
          requestId: event.payload.requestId,
          name: event.payload.name,
          status: event.payload.status,
          durationMs: event.payload.durationMs,
          arguments: event.payload.arguments,
          result: event.payload.result,
        });
      }),
    );
    register(
      listen<ChatDoneEvent>("chat-done", (event) => {
        dispatch({
          type: "done",
          requestId: event.payload.requestId,
          content: event.payload.content,
        });
        setConfirmation(null);
      }),
    );
    register(
      listen<ChatErrorEvent>("chat-error", (event) => {
        dispatch({
          type: "error",
          requestId: event.payload.requestId,
          error: event.payload.error,
        });
        setConfirmation(null);
      }),
    );
    register(
      listen<ChatConfirmEvent>("chat-confirm", (event) => {
        setConfirmation(event.payload);
      }),
    );

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, []);

  useEffect(() => {
    activeRequestRef.current = state.activeRequestId;
  }, [state.activeRequestId]);

  // A project switch remounts the screen (the shell keys it by projectId):
  // cancel the old stream, otherwise its late events would be emitted for a
  // transcript that no longer exists.
  useEffect(
    () => () => {
      const requestId = activeRequestRef.current;
      if (requestId === null) return;
      void chatApi.cancel(requestId).catch(() => undefined);
    },
    [],
  );

  // Rotates the working line while tools are hidden. A new request or the end
  // of the stream restarts it at the first phrase, so the next turn always
  // begins with the search message. Hover, focus and typed text pause it, and
  // `prefers-reduced-motion` slows the cadence down.
  useEffect(() => {
    setWorkingIndex(0);
  }, [working, state.activeRequestId]);

  useEffect(() => {
    if (!working || rotationPaused) return;
    const timer = window.setInterval(() => {
      setWorkingIndex((current) => (current + 1) % WORKING_KEYS.length);
    }, rotationInterval(reducedMotion));
    return () => window.clearInterval(timer);
  }, [working, rotationPaused, reducedMotion, state.activeRequestId]);

  // Follow the OS motion preference live: some users switch it while the app
  // stays open.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReducedMotion(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [state.messages, state.error, issueReason, working]);

  // Grows up to three lines and shrinks back when the text is removed.
  useEffect(() => {
    const textarea = inputRef.current;
    if (textarea === null) return;
    textarea.style.height = "auto";
    const next = Math.min(textarea.scrollHeight, COMPOSER_MAX_HEIGHT);
    textarea.style.height = `${Math.max(next, 44)}px`;
  }, [input]);

  // The guide hands over a question: place it in the composer and focus it.
  // Sending remains the user's own action.
  useEffect(() => {
    if (!seed) return;
    setInput(seed.text);
    onSeedHandled?.();
    inputRef.current?.focus();
  }, [seed, onSeedHandled]);

  const errorMessage = (error: AppErrorEnvelope) =>
    t(`errors.${error.code}`, {
      ns: "common",
      defaultValue: t("errors.UNKNOWN", { ns: "common" }),
    });

  const sendMessage = (raw: string) => {
    const text = raw.trim();
    if (text === "" || state.activeRequestId !== null || !ready) return;
    const requestId = newRequestId();
    const transcript = buildTranscript(state.messages, text);
    dispatch({
      type: "send",
      requestId,
      userId: `user-${requestId}`,
      content: text,
    });
    setInput("");
    void chatApi
      .send({ requestId, locale, messages: transcript, guide })
      .catch((caught: unknown) => {
        dispatch({
          type: "error",
          requestId,
          error: normalizeError(caught),
        });
      });
  };

  const send = () => sendMessage(input);

  const stop = () => {
    const requestId = state.activeRequestId;
    if (requestId === null) return;
    dispatch({ type: "cancel", requestId });
    void chatApi.cancel(requestId).catch(() => undefined);
    setConfirmation(null);
  };

  const retry = () => {
    setStatusError(null);
    loadStatus();
    if (state.error === null) return;
    const query = lastUserQuery(state.messages);
    if (query !== null) sendMessage(query);
  };

  const resetChat = () => {
    if (state.activeRequestId !== null) {
      stop();
    }
    dispatch({ type: "reset" });
    setConfirmation(null);
  };

  const deleteChat = () => {
    if (state.messages.length === 0) return;
    if (!window.confirm(t("chat:confirmDelete"))) return;
    resetChat();
  };

  const copyAnswer = (content: string) => {
    void writeClipboard(content).then((copied) => {
      if (copied) toast.success(t("chat:copied"));
      else toast.error(t("chat:copyFailed"));
    });
  };

  const applySuggestion = (text: string) => {
    setInput(text);
    const textarea = inputRef.current;
    if (textarea === null) return;
    textarea.focus();
    requestAnimationFrame(() => {
      const current = inputRef.current;
      if (current !== null) {
        current.setSelectionRange(current.value.length, current.value.length);
      }
    });
  };

  const applyConfirmation = useCallback(() => {
    const id = confirmation?.confirmationId;
    if (id === undefined || confirmBusy) return;
    setConfirmBusy(true);
    void chatApi
      .confirm(id, true)
      .then(() => setConfirmation(null))
      .catch(() => toast.error(t("chat:confirmFailed")))
      .finally(() => setConfirmBusy(false));
  }, [confirmation, confirmBusy, toast, t]);

  const cancelConfirmation = useCallback(() => {
    const id = confirmation?.confirmationId;
    if (id === undefined || confirmBusy) return;
    setConfirmBusy(true);
    void chatApi
      .confirm(id, false)
      .catch(() => toast.error(t("chat:confirmFailed")))
      .finally(() => {
        setConfirmBusy(false);
        setConfirmation(null);
      });
  }, [confirmation, confirmBusy, toast, t]);

  // Esc declines the confirmation card; accidental approval stays hard.
  useEffect(() => {
    if (confirmation === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelConfirmation();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmation, cancelConfirmation]);

  return (
    <section className="panel chat chat-screen">
      <div className="card-head chat-head">
        <h2>{t("chat:title")}</h2>
        <div className="chat-head-actions">
          <Button
            appearance="subtle"
            shape="rounded"
            icon={<Add20Regular aria-hidden="true" />}
            aria-label={t("chat:newChat")}
            title={t("chat:newChat")}
            onClick={resetChat}
          />
          <Button
            appearance="subtle"
            shape="rounded"
            className="chat-delete"
            icon={<Delete20Regular aria-hidden="true" />}
            aria-label={t("chat:deleteChat")}
            title={t("chat:deleteChat")}
            disabled={state.messages.length === 0}
            onClick={deleteChat}
          />
          <Button
            appearance="subtle"
            shape="rounded"
            icon={<Settings20Regular aria-hidden="true" />}
            aria-label={t("chat:openSettings")}
            title={t("chat:openSettings")}
            onClick={onOpenSettings}
          />
        </div>
      </div>

      {status !== null ? (
        <div className="chat-status-strip" role="note">
          <span className="chat-status-chip">
            {t("chat:providerLabel", { provider: status.provider || "—" })}
          </span>
          <span className="chat-status-chip">
            {t("chat:modelLabel", { model: status.model || "—" })}
          </span>
          {ready ? (
            <span
              className={
                localProvider
                  ? "chat-privacy chat-privacy-local"
                  : "chat-privacy chat-privacy-external"
              }
            >
              {localProvider ? (
                <ShieldCheckmark16Regular aria-hidden="true" />
              ) : (
                <Globe16Regular aria-hidden="true" />
              )}
              {localProvider
                ? t("chat:localNotice")
                : t("chat:externalNotice")}
            </span>
          ) : null}
          {toolsVisible ? (
            <span className="chat-status-chip">
              {t("chat:toolsCount", {
                count: status.toolsCount ?? status.tools?.length ?? 0,
              })}
            </span>
          ) : null}
          {ready && status.canEditPersons === true ? (
            <span className="chat-status-chip chat-status-chip-edit">
              {t("chat:editingEnabled")}
            </span>
          ) : null}
        </div>
      ) : null}

      {statusError !== null ? (
        <MessageBar intent="error" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>{t("chat:unavailableTitle")}</MessageBarTitle>
            {errorMessage(statusError)}
          </MessageBarBody>
          <MessageBarActions>
            <Button appearance="secondary" size="small" onClick={retry}>
              {t("chat:retry")}
            </Button>
          </MessageBarActions>
        </MessageBar>
      ) : null}

      <div
        className="chat-feed"
        aria-live="polite"
        aria-label={t("chat:transcript")}
      >
        {status === null && statusError === null ? (
          <div className="chat-loading" aria-hidden="true">
            <span className="skeleton" />
            <span className="skeleton" />
            <span className="skeleton" />
          </div>
        ) : null}

        {state.messages.length === 0 && status !== null ? (
          <div className="chat-empty">
            <Subtitle2 as="p" className="chat-empty-title">
              {t("chat:emptyTitle")}
            </Subtitle2>
            <EmptyState compact text={t("chat:empty")} />
            <div
              className="chat-suggestions"
              aria-label={t("chat:suggestionsLabel")}
            >
              {[t("chat:exampleLongevity"), t("chat:exampleConflicts")].map(
                (example) => (
                  <Button
                    key={example}
                    appearance="secondary"
                    shape="rounded"
                    size="small"
                    onClick={() => applySuggestion(example)}
                  >
                    {example}
                  </Button>
                ),
              )}
            </div>
          </div>
        ) : null}

        {state.messages.map((message, index) => {
          const roleLabel =
            message.role === "user" ? t("chat:you") : t("chat:assistant");
          return (
            <article
              key={message.id}
              className={`chat-message ${message.role}`}
              aria-busy={
                message.status === "pending" || message.status === "streaming"
              }
            >
              <div className="chat-message-head">
                <Avatar
                  name={roleLabel}
                  size={24}
                  color={message.role === "user" ? "brand" : "colorful"}
                  aria-hidden="true"
                />
                <Caption1 className="chat-author">{roleLabel}</Caption1>
              </div>
              {message.content === "" ? (
                <p className="chat-text">
                  {message.status === "pending" ||
                  message.status === "streaming"
                    ? t("chat:thinking")
                    : ""}
                </p>
              ) : message.role === "assistant" ? (
                <Markdown
                  text={message.content}
                  persons={onOpenPerson !== undefined ? persons : undefined}
                  onOpenPerson={onOpenPerson}
                />
              ) : (
                <p className="chat-text">{message.content}</p>
              )}

              {toolsVisible &&
              message.role === "assistant" &&
              message.skills.length > 0 ? (
                <div
                  className="chat-skills"
                  aria-label={t("chat:skillsLabel")}
                >
                  <SparkleRegular aria-hidden="true" fontSize={14} />
                  <span>
                    {t("chat:skillsUsed", {
                      skills: message.skills.join(", "),
                    })}
                  </span>
                </div>
              ) : null}

              {toolsVisible && message.tools.length > 0 ? (
                <ToolCalls tools={message.tools} locale={locale} />
              ) : null}

              {message.status === "cancelled" ? (
                <Caption1 as="p" className="chat-note">
                  {t("chat:cancelled")}
                </Caption1>
              ) : null}
              {message.status === "error" ? (
                <MessageBar intent="error">
                  <MessageBarBody>{t("chat:answerFailed")}</MessageBarBody>
                </MessageBar>
              ) : null}

              {message.role === "assistant" &&
              message.status === "done" &&
              message.content.trim() !== "" ? (
                <div className="chat-answer-actions">
                  <Button
                    appearance="subtle"
                    size="small"
                    icon={<Copy16Regular aria-hidden="true" />}
                    aria-label={t("chat:copy")}
                    title={t("chat:copy")}
                    onClick={() => copyAnswer(message.content)}
                  />
                  <Button
                    appearance="subtle"
                    size="small"
                    icon={<ArrowClockwise16Regular aria-hidden="true" />}
                    aria-label={t("chat:repeat")}
                    title={t("chat:repeat")}
                    disabled={!ready || streaming}
                    onClick={() => {
                      const query = queryBefore(state.messages, index);
                      if (query !== null) sendMessage(query);
                    }}
                  />
                </div>
              ) : null}
            </article>
          );
        })}

        {confirmation !== null && confirmation.changedFields.length > 0 ? (
          <ConfirmCard
            confirmation={confirmation}
            confirmBusy={confirmBusy}
            formatDate={formatDate}
            onApply={applyConfirmation}
            onCancel={cancelConfirmation}
          />
        ) : null}

        {working ? (
          <div
            className="chat-working"
            role="status"
            aria-live="polite"
            onMouseEnter={() => setWorkingHovered(true)}
            onMouseLeave={() => setWorkingHovered(false)}
            onFocusCapture={() => setWorkingFocused(true)}
            onBlurCapture={() => setWorkingFocused(false)}
          >
            <SparkleRegular aria-hidden="true" fontSize={14} />
            <span key={workingIndex} className="chat-working-text">
              {t(WORKING_KEYS[workingIndex])}
            </span>
          </div>
        ) : null}

        {issueReason !== null && statusError === null ? (
          <MessageBar intent="error" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>{t("chat:unavailableTitle")}</MessageBarTitle>
              {t(REASON_LABEL[issueReason])}
            </MessageBarBody>
            <MessageBarActions>
              <Button
                appearance="secondary"
                size="small"
                onClick={retry}
              >
                {t("chat:retry")}
              </Button>
              <Button
                appearance="subtle"
                size="small"
                onClick={onOpenSettings}
              >
                {t("chat:openSettings")}
              </Button>
            </MessageBarActions>
          </MessageBar>
        ) : null}

        {state.error !== null && status?.logPath ? (
          <Caption1 as="p" className="chat-note">
            {t("chat:logPath", { path: status.logPath })}
          </Caption1>
        ) : null}

        <div ref={bottomRef} />
      </div>

      <form
        className="chat-compose"
        onSubmit={(event) => {
          event.preventDefault();
          if (!streaming) send();
        }}
      >
        <div className="chat-input-row">
          <Textarea
            ref={inputRef}
            className="chat-compose-textarea"
            value={input}
            rows={1}
            resize="none"
            placeholder={t("chat:placeholder")}
            aria-label={t("chat:inputLabel")}
            onChange={(_, data) => setInput(data.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                if (!streaming) send();
              }
            }}
          />
          <Button
            type="button"
            appearance={streaming ? "secondary" : "primary"}
            aria-pressed={streaming}
            aria-describedby={
              !streaming && !ready ? sendReasonId : undefined
            }
            disabled={!streaming && (!ready || input.trim() === "")}
            title={
              !streaming && !ready ? t("chat:sendDisabled") : undefined
            }
            icon={
              streaming ? (
                <Stop20Regular aria-hidden="true" />
              ) : (
                <Send20Regular aria-hidden="true" />
              )
            }
            onClick={() => {
              if (streaming) stop();
              else send();
            }}
          >
            {streaming ? t("chat:stop") : t("chat:send")}
          </Button>
          {!streaming && !ready ? (
            <span id={sendReasonId} className="ui-sr-only" aria-hidden="true">
              {t("chat:sendDisabled")}
            </span>
          ) : null}
        </div>
        <Caption1 as="p" className="chat-hint">
          {t("chat:hint")}
        </Caption1>
      </form>
    </section>
  );
}

function reasonFromStatus(status: ChatStatus): ChatReason | null {
  if (!status.enabled) return "disabled";
  if (!status.keyPresent) return "missingKey";
  if (status.model.trim() === "") return "missingModel";
  return null;
}

function reasonFromError(error: AppErrorEnvelope): ChatReason {
  const reason = error.params?.reason;
  if (reason !== undefined && (REASONS as readonly string[]).includes(reason)) {
    return reason as ChatReason;
  }
  return "unavailable";
}

function lastUserQuery(messages: ChatEntry[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (entry.role === "user") return entry.content;
  }
  return null;
}

function queryBefore(messages: ChatEntry[], position: number): string | null {
  for (let index = position - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (entry.role === "user") return entry.content;
  }
  return null;
}

/** `crypto.randomUUID` is unavailable on very old WebViews; keep a fallback. */
function newRequestId(): string {
  const cryptoApi = globalThis.crypto as
    | { randomUUID?: () => string }
    | undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Pretty-prints JSON for the expandable tool details; raw text stays raw. */
function formatToolDetail(value: string | undefined): string {
  if (value === undefined || value.trim() === "") return "—";
  try {
    return JSON.stringify(JSON.parse(value) as unknown, null, 2);
  } catch {
    return value;
  }
}

/** Clipboard API with an `execCommand` fallback for older WebViews. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}

function ToolCalls({
  tools,
  locale,
}: {
  tools: ChatToolCall[];
  locale: string;
}) {
  const { t } = useTranslation("chat");
  const failed = tools.filter((tool) => tool.status === "error").length;

  return (
    <div className="chat-tools">
      <div className="chat-tools-summary">
        <Wrench16Regular aria-hidden="true" />
        <span>{t("toolsUsed", { count: tools.length })}</span>
        {failed > 0 ? (
          <span className="chat-tools-failed">
            {t("toolsFailed", { count: failed })}
          </span>
        ) : null}
      </div>
      {/* One collapsible item per tool; every panel starts closed. */}
      <Accordion multiple collapsible>
        {tools.map((tool, index) => {
          const duration =
            tool.durationMs !== null
              ? durationParts(tool.durationMs, locale)
              : null;
          const durationText =
            duration === null
              ? "—"
              : t(duration.unit === "ms" ? "durationMs" : "durationSec", {
                  value: duration.value,
                });
          return (
            <AccordionItem
              key={`${tool.name}-${index}`}
              value={`tool-${index}`}
              className={
                tool.status === "error" ? "chat-tool-item-error" : undefined
              }
            >
              <AccordionHeader size="small" expandIconPosition="start">
                <span className="chat-tool-head">
                  <code className="chat-tool-name">{tool.name}</code>
                  <Caption1
                    className={`chat-tool-status chat-tool-status-${tool.status}`}
                  >
                    {t(TOOL_STATUS_LABEL[tool.status])}
                  </Caption1>
                  <Caption1 className="chat-tool-duration">
                    {durationText}
                  </Caption1>
                </span>
              </AccordionHeader>
              <AccordionPanel className="tool-detail">
                <Caption1 as="p" className="meta">
                  {t("toolInput")}
                </Caption1>
                <pre>{formatToolDetail(tool.arguments)}</pre>
                <Caption1 as="p" className="meta">
                  {t("toolResult")}
                </Caption1>
                <pre>{formatToolDetail(tool.result)}</pre>
              </AccordionPanel>
            </AccordionItem>
          );
        })}
      </Accordion>
    </div>
  );
}

/** Primary (or first) name of a person, in the backend display order. */
function displayNameOf(person: Person): string {
  const primary =
    person.names.find((name) => name.isPrimary) ?? person.names[0];
  return primary ? formatPersonName(primary) : "";
}

/** Stable, localized label for one diff row. */
function confirmFieldLabel(
  row: { field: string; nameType?: string },
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  switch (row.field) {
    case "names":
      return row.nameType
        ? `${t("chat:fieldNames")} · ${t(`enums:nameType.${row.nameType}`)}`
        : t("chat:fieldNames");
    case "gender":
      return t("chat:fieldGender");
    case "birth":
      return t("chat:fieldBirth");
    case "death":
      return t("chat:fieldDeath");
    case "notes":
      return t("chat:fieldNotes");
    default:
      return row.field;
  }
}

function ConfirmCard({
  confirmation,
  confirmBusy,
  formatDate,
  onApply,
  onCancel,
}: {
  confirmation: ChatConfirmEvent;
  confirmBusy: boolean;
  formatDate: (value: DateValue) => string;
  onApply: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const name = displayNameOf(confirmation.before);
  const rows = diffPerson(confirmation.before, confirmation.after, {
    name: displayNameOf,
    date: formatDate,
    gender: (value: Gender) => t(`enums:gender.${value}`),
  });

  return (
    <div className="chat-confirm" role="group" aria-label={t("chat:confirmTitle")}>
      <Subtitle2 as="p" className="chat-confirm-title">
        {t("chat:confirmTitle")}
      </Subtitle2>
      <p className="chat-confirm-body">{t("chat:confirmBody", { name })}</p>
      <p className="chat-confirm-warning">{t("chat:confirmWarning")}</p>
      <ul className="chat-confirm-rows">
        {rows.map((row, index) => (
          <li key={`${row.field}-${index}`} className="chat-confirm-row">
            <span className="chat-confirm-field">
              {confirmFieldLabel(row, t)}
            </span>
            <span className="chat-confirm-values">
              <span className="chat-confirm-before">
                {row.before === "" ? t("chat:addedValue") : row.before}
              </span>
              <span className="chat-confirm-arrow" aria-hidden="true">
                →
              </span>
              <span className="chat-confirm-after">
                {row.after === "" ? t("chat:removedValue") : row.after}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <div className="chat-confirm-actions">
        <Button
          appearance="secondary"
          size="small"
          disabled={confirmBusy}
          onClick={onCancel}
        >
          {t("chat:confirmCancel")}
        </Button>
        <Button
          appearance="primary"
          size="small"
          disabled={confirmBusy}
          onClick={onApply}
        >
          {confirmBusy ? t("chat:confirmApplying") : t("chat:confirmApply")}
        </Button>
      </div>
    </div>
  );
}
