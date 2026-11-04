import {
  useCallback,
  useEffect,
  useId,
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
  Badge,
  Button as FluentButton,
  Caption1,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Subtitle2,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
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
  ChatHistoryLimits,
  ChatHistorySummary,
  ChatSkillEvent,
  ChatStatus,
  DateValue,
  Gender,
  Person,
} from "../../api/types";
import { CollectionShell } from "../../components/patterns/collection-shell";
import { DataTable, DataTableColgroup } from "../../components/patterns/data-table";
import { PageShell } from "../../components/patterns/page-shell";
import type { SplitterBounds } from "../../components/patterns/splitter";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { EmptyState } from "../../components/ui/empty";
import { IconButton } from "../../components/ui/icon-button";
import { useToast } from "../../components/ui/toast";
import { normalizeError } from "../../lib/errors";
import { useDateFormatter } from "../../lib/useDateFormatter";
import { Markdown } from "../../components/Markdown";
import type { EntityPerson } from "./entityLinks";
import { durationParts, isLocalProviderUrl } from "./format";
import { diffPerson, formatPersonName } from "./confirm";
import {
  fromChatEntries,
  historyDateValue,
  newConversationLimitScope,
  nextConversationId,
  sendLimitScope,
  sortConversations,
  startupConversationId,
  toChatEntries,
} from "./history";
import {
  DiscardedHistorySaveError,
  HistoryQueue,
} from "./historyQueue";
import { rotationInterval, shouldPauseRotation } from "./rotation";
import {
  buildTranscript,
  initialChatState,
  reduceChat,
  type ChatAction,
  type ChatEntry,
  type ChatStreamState,
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
};

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

/** The rail is narrower than a table screen; keep the detail pane dominant. */
const CHAT_SPLITTER: SplitterBounds = {
  defaultWidth: 32,
  min: 26,
  max: 44,
};

const CHAT_LIST_WIDTH_KEY = "gentree.chat.listWidth";

/** A small local preference; the collection shell owns the geometry. */
function readChatListWidth(): string | null {
  try {
    return window.localStorage.getItem(CHAT_LIST_WIDTH_KEY);
  } catch {
    return null;
  }
}

function writeChatListWidth(value: string): void {
  try {
    window.localStorage.setItem(CHAT_LIST_WIDTH_KEY, value);
  } catch {
    // Storage can be disabled in a hardened webview; keep the session width.
  }
}

type HistoryNotice = "notSaved" | "limit" | "damaged" | null;

type PendingAction =
  | { kind: "delete"; id: string }
  | { kind: "clear" }
  | { kind: "switch"; id: string }
  | { kind: "new" };

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

  const [conversations, setConversations] = useState<ChatHistorySummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<AppErrorEnvelope | null>(null);
  const [historyNotice, setHistoryNotice] = useState<HistoryNotice>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [pendingBusy, setPendingBusy] = useState(false);
  const [listWidth, setListWidth] = useState<string | null>(() =>
    readChatListWidth(),
  );

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // `chat_status` is an IPC snapshot: a response that started earlier must not
  // overwrite a newer one, and no state is written after unmount.
  const statusSequence = useRef(0);
  const statusAlive = useRef(true);
  const activeRequestRef = useRef<string | null>(null);
  const stateRef = useRef<ChatStreamState>(initialChatState);
  const conversationsRef = useRef<ChatHistorySummary[]>([]);
  const conversationIdRef = useRef<string | null>(null);
  const limitsRef = useRef<ChatHistoryLimits | null>(null);
  const projectIdRef = useRef<string | null>(projectId ?? null);
  const loadSequence = useRef(0);
  const sendLock = useRef(false);
  const historyQueue = useRef<HistoryQueue | null>(null);
  if (historyQueue.current === null) {
    historyQueue.current = new HistoryQueue(chatApi.saveHistory);
  }
  projectIdRef.current = projectId ?? null;

  const locale: Locale = SUPPORTED_LOCALES.includes(
    i18n.language as Locale,
  )
    ? (i18n.language as Locale)
    : "ru";
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
  const activeRow = conversations.find((row) => row.id === conversationId);

  const updateConversations = useCallback(
    (update: (rows: ChatHistorySummary[]) => ChatHistorySummary[]) => {
      setConversations((previous) => {
        const next = update(previous);
        conversationsRef.current = next;
        return next;
      });
    },
    [],
  );

  const dateText = useCallback(
    (row: ChatHistorySummary): string => {
      const value = historyDateValue(row.updatedAt);
      return value === null ? "—" : formatDate(value);
    },
    [formatDate],
  );

  const activeTitle =
    activeRow !== undefined
      ? (activeRow.title ?? t("chat:untitled"))
      : t("chat:newConversation");
  const activeDate = activeRow !== undefined ? dateText(activeRow) : null;

  useEffect(() => {
    stateRef.current = state;
    activeRequestRef.current = state.activeRequestId;
  }, [state]);

  useEffect(() => {
    statusAlive.current = true;
    return () => {
      statusAlive.current = false;
    };
  }, []);

  const errorMessage = useCallback(
    (error: AppErrorEnvelope) =>
      t(`errors.${error.code}`, {
        ns: "common",
        defaultValue: t("errors.UNKNOWN", { ns: "common" }),
      }),
    [t],
  );

  /** Applies a reducer action while keeping the ref ahead of React's render. */
  const apply = (action: ChatAction): ChatStreamState => {
    const next = reduceChat(stateRef.current, action);
    stateRef.current = next;
    dispatch(action);
    return next;
  };

  /** Queues a whole-conversation snapshot; failures stay visible, not silent. */
  const persist = useCallback(
    (
      messages: ChatEntry[],
      targetId = conversationIdRef.current,
      terminal = false,
    ) => {
      const project = projectIdRef.current;
      if (project === null || targetId === null) return;
      void historyQueue.current
        ?.enqueue(project, targetId, fromChatEntries(messages))
        .then((summary) => {
          updateConversations((rows) =>
            sortConversations([
              ...rows.filter((row) => row.id !== summary.id),
              summary,
            ]),
          );
          setHistoryNotice(null);
        })
        .catch((caught: unknown) => {
          if (caught instanceof DiscardedHistorySaveError) return;
          const error = normalizeError(caught);
          setHistoryNotice(
            terminal || error.code !== "CHAT_HISTORY_LIMIT"
              ? "notSaved"
              : "limit",
          );
        });
    },
    [updateConversations],
  );

  /**
   * Loads one conversation. A corrupted file marks its row and tries the next
   * healthy conversation; when none is readable the damaged row stays selected
   * with an explicit notice instead of a partial transcript.
   */
  const loadConversation = useCallback(
    async (id: string, rows?: readonly ChatHistorySummary[]): Promise<void> => {
      const project = projectIdRef.current;
      if (project === null) return;
      const sequence = loadSequence.current + 1;
      loadSequence.current = sequence;
      try {
        const conversation = await chatApi.loadHistory(project, id);
        if (sequence !== loadSequence.current) return;
        const entries = toChatEntries(conversation);
        const next = { messages: entries, activeRequestId: null, error: null };
        stateRef.current = next;
        dispatch({ type: "load", messages: entries });
        conversationIdRef.current = id;
        setConversationId(id);
        setHistoryError(null);
        setHistoryNotice(null);
        updateConversations((previous) =>
          sortConversations(
            previous.map((row) =>
              row.id === id
                ? {
                    ...row,
                    title: conversation.title,
                    updatedAt: conversation.updatedAt,
                    damaged: false,
                  }
                : row,
            ),
          ),
        );
      } catch (caught: unknown) {
        if (sequence !== loadSequence.current) return;
        const error = normalizeError(caught);
        if (error.code !== "CHAT_HISTORY_CORRUPTED") {
          setHistoryError(error);
          return;
        }
        const base = rows ?? conversationsRef.current;
        const nextRows = sortConversations(
          base.map((row) =>
            row.id === id ? { ...row, damaged: true, title: null } : row,
          ),
        );
        updateConversations(() => nextRows);
        const nextId = startupConversationId(nextRows, [id]);
        if (nextId !== null) {
          await loadConversation(nextId, nextRows);
          return;
        }
        const empty: ChatStreamState = {
          messages: [],
          activeRequestId: null,
          error: null,
        };
        stateRef.current = empty;
        dispatch({ type: "load", messages: [] });
        conversationIdRef.current = id;
        setConversationId(id);
        setHistoryNotice("damaged");
      }
    },
    [updateConversations],
  );

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
  // changes. The sequence guard above drops stale in-flight responses.
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
    stateRef.current = initialChatState;
    conversationsRef.current = [];
    conversationIdRef.current = null;
    limitsRef.current = null;
    loadSequence.current += 1;
    setConversations([]);
    setConversationId(null);
    setHistoryError(null);
    setHistoryNotice(null);
    setHistoryLoading(projectId !== undefined);
    setPending(null);
    setInput("");
    setConfirmation(null);
  }, [projectId]);

  // Startup: list the project's conversations and open the most recent
  // healthy one. Without an open project the chat stays ephemeral and no
  // history command is called.
  useEffect(() => {
    if (projectId === undefined) return;
    let disposed = false;
    const sequence = loadSequence.current + 1;
    loadSequence.current = sequence;
    setHistoryLoading(true);
    setHistoryError(null);
    void chatApi
      .listHistory(projectId)
      .then((result) => {
        if (disposed || sequence !== loadSequence.current) return;
        const rows = sortConversations(result.conversations);
        limitsRef.current = result.limits;
        updateConversations(() => rows);
        setHistoryLoading(false);
        const id = startupConversationId(rows);
        if (id !== null) void loadConversation(id, rows);
      })
      .catch((caught: unknown) => {
        if (disposed || sequence !== loadSequence.current) return;
        setHistoryLoading(false);
        setHistoryError(normalizeError(caught));
      });
    return () => {
      disposed = true;
    };
  }, [projectId, loadConversation, updateConversations]);

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
  // the reducer ignores events for requests it does not know. Terminal events
  // also persist the final snapshot.
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
        apply({
          type: "skill",
          requestId: event.payload.requestId,
          skills: event.payload.skills,
        });
      }),
    );
    register(
      listen<ChatDeltaEvent>("chat-delta", (event) => {
        apply({
          type: "delta",
          requestId: event.payload.requestId,
          delta: event.payload.delta,
        });
      }),
    );
    register(
      listen<ChatToolEvent>("chat-tool", (event) => {
        apply({
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
        const next = apply({
          type: "done",
          requestId: event.payload.requestId,
          content: event.payload.content,
        });
        setConfirmation(null);
        persist(next.messages, conversationIdRef.current, true);
      }),
    );
    register(
      listen<ChatErrorEvent>("chat-error", (event) => {
        const next = apply({
          type: "error",
          requestId: event.payload.requestId,
          error: event.payload.error,
        });
        setConfirmation(null);
        persist(next.messages, conversationIdRef.current, true);
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
    // `apply` and `persist` only touch refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    const applyPreference = () => setReducedMotion(media.matches);
    applyPreference();
    media.addEventListener("change", applyPreference);
    return () => media.removeEventListener("change", applyPreference);
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

  /** Stops the active stream and optionally persists the cancelled snapshot. */
  const stopStream = (save: boolean): void => {
    const requestId = stateRef.current.activeRequestId;
    if (requestId === null) return;
    const next = apply({ type: "cancel", requestId });
    setConfirmation(null);
    void chatApi.cancel(requestId).catch(() => undefined);
    if (save) persist(next.messages, conversationIdRef.current, true);
  };

  /** Clears the screen for an unsaved new conversation. */
  const resetToNew = (): void => {
    stateRef.current = initialChatState;
    dispatch({ type: "reset" });
    conversationIdRef.current = null;
    setConversationId(null);
    setInput("");
    setConfirmation(null);
    setHistoryNotice(null);
    setHistoryError(null);
  };

  const sendMessage = (raw: string) => {
    const text = raw.trim();
    if (
      text === "" ||
      stateRef.current.activeRequestId !== null ||
      !ready ||
      sendLock.current
    ) {
      return;
    }
    sendLock.current = true;
    void (async () => {
      try {
        const project = projectIdRef.current;
        const requestId = newRequestId();
        const userId = `user-${requestId}`;
        const transcript = buildTranscript(stateRef.current.messages, text);
        const nextMessages: ChatEntry[] = [
          ...stateRef.current.messages,
          {
            id: userId,
            role: "user",
            content: text,
            requestId: null,
            status: "done",
            skills: [],
            tools: [],
          },
          {
            id: `assistant-${requestId}`,
            role: "assistant",
            content: "",
            requestId,
            status: "pending",
            skills: [],
            tools: [],
          },
        ];

        if (project !== null) {
          const limits = limitsRef.current;
          if (limits !== null) {
            const entryLimit = sendLimitScope(
              limits,
              stateRef.current.messages.length,
            );
            if (entryLimit !== null) {
              setHistoryNotice("limit");
              return;
            }
            if (
              conversationIdRef.current === null &&
              newConversationLimitScope(limits, conversationsRef.current.length)
            ) {
              setHistoryNotice("limit");
              return;
            }
          }
          if (conversationIdRef.current === null) {
            const id = newUuid();
            conversationIdRef.current = id;
            setConversationId(id);
          }
          const targetId = conversationIdRef.current;
          if (targetId !== null) {
            try {
              const summary = await historyQueue.current?.enqueue(
                project,
                targetId,
                fromChatEntries(nextMessages),
              );
              if (summary !== undefined) {
                updateConversations((rows) =>
                  sortConversations([
                    ...rows.filter((row) => row.id !== summary.id),
                    summary,
                  ]),
                );
              }
            } catch (caught: unknown) {
              if (caught instanceof DiscardedHistorySaveError) return;
              const error = normalizeError(caught);
              if (error.code === "CHAT_HISTORY_LIMIT") {
                setHistoryNotice("limit");
                return;
              }
              // A non-limit write failure must not lose the answer: send it and
              // keep the persistent "not saved" notice.
              setHistoryNotice("notSaved");
            }
          }
        }

        apply({
          type: "send",
          requestId,
          userId,
          content: text,
        });
        setInput("");
        void chatApi
          .send({ requestId, locale, messages: transcript })
          .catch((caught: unknown) => {
            const error = normalizeError(caught);
            const next = apply({ type: "error", requestId, error });
            persist(next.messages, conversationIdRef.current, true);
          });
      } finally {
        sendLock.current = false;
      }
    })();
  };

  const send = () => sendMessage(input);

  const stop = () => stopStream(true);

  const retry = () => {
    setStatusError(null);
    loadStatus();
    if (state.error === null) return;
    const query = lastUserQuery(state.messages);
    if (query !== null) sendMessage(query);
  };

  const openConversation = (id: string) => {
    if (id === conversationIdRef.current) return;
    if (stateRef.current.activeRequestId !== null) {
      setPending({ kind: "switch", id });
      return;
    }
    void loadConversation(id);
  };

  const requestNewChat = () => {
    if (stateRef.current.activeRequestId !== null) {
      setPending({ kind: "new" });
      return;
    }
    resetToNew();
  };

  const requestDelete = (id: string) => setPending({ kind: "delete", id });

  const requestClear = () => setPending({ kind: "clear" });

  const deleteConversation = async (id: string): Promise<void> => {
    const project = projectIdRef.current;
    if (project === null) return;
    const wasActive = id === conversationIdRef.current;
    if (wasActive) stopStream(false);
    historyQueue.current?.tombstone(project, id);
    await chatApi.deleteHistory(project, id);
    const rows = conversationsRef.current;
    const neighbour = wasActive ? nextConversationId(rows, id) : null;
    const remaining = rows.filter((row) => row.id !== id);
    updateConversations(() => remaining);
    setHistoryNotice((current) => (current === "limit" ? null : current));
    if (wasActive) {
      if (neighbour !== null) await loadConversation(neighbour, remaining);
      else resetToNew();
    }
  };

  const clearAllHistory = async (): Promise<void> => {
    const project = projectIdRef.current;
    if (project === null) return;
    // Stop first; the tombstone then discards any queued cancelled snapshot so
    // a cleared history cannot be recreated.
    stopStream(false);
    historyQueue.current?.tombstoneAll();
    await chatApi.clearHistory(project);
    updateConversations(() => []);
    resetToNew();
  };

  const runPending = async (): Promise<void> => {
    const action = pending;
    if (action === null || pendingBusy) return;
    setPendingBusy(true);
    try {
      switch (action.kind) {
        case "switch":
          stopStream(true);
          await loadConversation(action.id);
          break;
        case "new":
          stopStream(true);
          resetToNew();
          break;
        case "delete":
          await deleteConversation(action.id);
          break;
        case "clear":
          await clearAllHistory();
          break;
      }
    } catch (caught: unknown) {
      toast.error(errorMessage(normalizeError(caught)));
    } finally {
      setPendingBusy(false);
      setPending(null);
    }
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

  const dialogueKeys =
    pending === null ? null : historyDialogue(pending, streaming, activeRow);
  const dialogue =
    dialogueKeys === null
      ? null
      : {
          ...dialogueKeys,
          title: t(dialogueKeys.title),
          body: t(dialogueKeys.body),
          action: t(dialogueKeys.action),
        };

  return (
    <PageShell
      className="chat chat-screen"
      headerClassName="chat-head"
      actionsClassName="chat-head-actions"
      titleAs="h2"
      titleClassName=""
      title={t("chat:title")}
      titleAside={
        <Badge appearance="tint" color="informative" size="small">
          {conversations.length}
        </Badge>
      }
      actions={
        <>
          <IconButton
            label={t("chat:newChat")}
            onClick={requestNewChat}
            data-tour="chat-new"
          >
            <Add20Regular aria-hidden="true" />
          </IconButton>
          <IconButton
            label={t("chat:openSettings")}
            onClick={onOpenSettings}
          >
            <Settings20Regular aria-hidden="true" />
          </IconButton>
        </>
      }
    >
      <CollectionShell
        storedWidth={listWidth}
        onCommitWidth={(value) => {
          setListWidth(value);
          writeChatListWidth(value);
        }}
        bounds={CHAT_SPLITTER}
        splitterLabel={t("chat:resizeList")}
        listLabel={t("chat:listLabel")}
        layoutClassName="chat-collection"
        listClassName="chat-history-panel"
        splitterClassName="chat-splitter"
        detailAs="section"
        detailPanel
        detailClassName="chat-detail-panel"
        toolbar={
          <div className="chat-history-toolbar">
            <Caption1 className="chat-history-count">
              {t("chat:conversationsLabel", { count: conversations.length })}
            </Caption1>
            <Button
              variant="ghost"
              size="sm"
              onClick={requestClear}
              disabled={projectId === undefined || conversations.length === 0}
            >
              {t("chat:clearHistory")}
            </Button>
          </div>
        }
        banner={
          historyError !== null ? (
            <MessageBar intent="error">
              <MessageBarBody>{errorMessage(historyError)}</MessageBarBody>
            </MessageBar>
          ) : undefined
        }
        detail={
          <div className="chat-detail">
            <div className="chat-detail-head">
              <Subtitle2 as="h3" className="chat-detail-title">
                {activeTitle}
              </Subtitle2>
              {activeDate !== null ? (
                <Caption1 className="chat-detail-date">{activeDate}</Caption1>
              ) : null}
              {activeRow?.damaged === true ? (
                <Caption1 className="chat-damaged-label">
                  {t("chat:damaged")}
                </Caption1>
              ) : null}
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
                  <FluentButton
                    appearance="secondary"
                    size="small"
                    onClick={retry}
                  >
                    {t("chat:retry")}
                  </FluentButton>
                </MessageBarActions>
              </MessageBar>
            ) : null}

            {historyNotice === "notSaved" ? (
              <MessageBar intent="warning" layout="multiline">
                <MessageBarBody>{t("chat:notSaved")}</MessageBarBody>
              </MessageBar>
            ) : null}

            {historyNotice === "limit" ? (
              <MessageBar intent="warning" layout="multiline">
                <MessageBarBody>{t("chat:limitNotice")}</MessageBarBody>
              </MessageBar>
            ) : null}

            {historyNotice === "damaged" ? (
              <MessageBar intent="warning" layout="multiline">
                <MessageBarBody>{t("chat:damagedNotice")}</MessageBarBody>
                <MessageBarActions>
                  {conversationId !== null ? (
                    <FluentButton
                      appearance="secondary"
                      size="small"
                      onClick={() => requestDelete(conversationId)}
                    >
                      {t("chat:deleteConversation")}
                    </FluentButton>
                  ) : null}
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

              {state.messages.length === 0 &&
              status !== null &&
              historyNotice !== "damaged" ? (
                <div className="chat-empty">
                  <EmptyState compact text={t("chat:empty")} />
                  <div
                    className="chat-suggestions"
                    aria-label={t("chat:suggestionsLabel")}
                  >
                    {[t("chat:exampleLongevity"), t("chat:exampleConflicts")].map(
                      (example) => (
                        <Button
                          key={example}
                          variant="secondary"
                          size="sm"
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
                  message.role === "user"
                    ? t("chat:you")
                    : t("chat:assistant");
                return (
                  <article
                    key={message.id}
                    className={`chat-message ${message.role}`}
                    aria-busy={
                      message.status === "pending" ||
                      message.status === "streaming"
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
                        persons={
                          onOpenPerson !== undefined ? persons : undefined
                        }
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
                        <FluentButton
                          appearance="subtle"
                          size="small"
                          icon={<Copy16Regular aria-hidden="true" />}
                          aria-label={t("chat:copy")}
                          title={t("chat:copy")}
                          onClick={() => copyAnswer(message.content)}
                        />
                        <FluentButton
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
                    <FluentButton
                      appearance="secondary"
                      size="small"
                      onClick={retry}
                    >
                      {t("chat:retry")}
                    </FluentButton>
                    <FluentButton
                      appearance="subtle"
                      size="small"
                      onClick={onOpenSettings}
                    >
                      {t("chat:openSettings")}
                    </FluentButton>
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
                  variant={streaming ? "secondary" : "primary"}
                  aria-pressed={streaming}
                  aria-describedby={
                    !streaming && !ready ? sendReasonId : undefined
                  }
                  disabled={!streaming && (!ready || input.trim() === "")}
                  title={!streaming && !ready ? t("chat:sendDisabled") : undefined}
                  onClick={() => {
                    if (streaming) stop();
                    else send();
                  }}
                >
                  {streaming ? (
                    <Stop20Regular aria-hidden="true" />
                  ) : (
                    <Send20Regular aria-hidden="true" />
                  )}
                  {streaming ? t("chat:stop") : t("chat:send")}
                </Button>
                {!streaming && !ready ? (
                  <span
                    id={sendReasonId}
                    className="ui-sr-only"
                    aria-hidden="true"
                  >
                    {t("chat:sendDisabled")}
                  </span>
                ) : null}
              </div>
              <Caption1 as="p" className="chat-hint">
                {t("chat:hint")}
              </Caption1>
            </form>
          </div>
        }
      >
        {historyLoading ? (
          <div className="chat-history-loading" aria-hidden="true">
            <span className="skeleton" />
            <span className="skeleton" />
            <span className="skeleton" />
          </div>
        ) : historyError !== null ? null : projectId === undefined ? (
          <EmptyState compact text={t("chat:ephemeral")} />
        ) : conversations.length === 0 ? (
          <EmptyState compact text={t("chat:noConversations")} />
        ) : (
          <div className="chat-history-table-wrap">
            <DataTable
              ariaLabel={t("chat:listLabel")}
              busy={pendingBusy}
              className="chat-history-table"
            >
              <DataTableColgroup
                columns={["conversation", "actions"]}
                widths={{}}
                selection={false}
                columnClassName={(column) =>
                  column === "actions"
                    ? "chat-history-col-actions"
                    : "chat-history-col"
                }
              />
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>
                    {t("chat:conversationColumn")}
                  </TableHeaderCell>
                  <TableHeaderCell className="chat-history-actions-head">
                    <span className="ui-sr-only">
                      {t("chat:deleteConversation")}
                    </span>
                  </TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {conversations.map((row) => (
                  <TableRow
                    key={row.id}
                    className={
                      row.id === conversationId
                        ? "chat-history-row chat-history-row-active"
                        : "chat-history-row"
                    }
                    aria-selected={row.id === conversationId}
                    onClick={() => openConversation(row.id)}
                  >
                    <TableCell className="chat-history-cell">
                      <span className="chat-history-title">
                        {row.title ?? t("chat:untitled")}
                      </span>
                      <Caption1 className="chat-history-date">
                        {dateText(row)}
                        {row.damaged ? ` · ${t("chat:damaged")}` : ""}
                      </Caption1>
                    </TableCell>
                    <TableCell
                      className="chat-history-actions"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <IconButton
                        label={t("chat:deleteConversation")}
                        disabled={pendingBusy}
                        onClick={() => requestDelete(row.id)}
                      >
                        <Delete20Regular aria-hidden="true" />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </DataTable>
          </div>
        )}
      </CollectionShell>

      <Dialog
        open={pending !== null}
        title={dialogue?.title ?? ""}
        description={dialogue?.body}
        busy={pendingBusy}
        onClose={() => {
          if (!pendingBusy) setPending(null);
        }}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={pendingBusy}
              onClick={() => setPending(null)}
            >
              {t("chat:confirmCancel")}
            </Button>
            <Button
              variant={dialogue?.destructive === true ? "danger" : "primary"}
              loading={pendingBusy}
              onClick={() => void runPending()}
            >
              {dialogue?.action ?? t("chat:confirmApply")}
            </Button>
          </>
        }
      >
        <span />
      </Dialog>
    </PageShell>
  );
}

function historyDialogue(
  pending: PendingAction,
  streaming: boolean,
  activeRow: ChatHistorySummary | undefined,
): { title: string; body: string; action: string; destructive: boolean } {
  // Translated by the caller's `t`, so this helper returns keys plus a flag.
  switch (pending.kind) {
    case "delete":
      return {
        title: "chat:deleteConversationTitle",
        body:
          streaming && activeRow?.id === pending.id
            ? "chat:deleteActiveStreamingBody"
            : "chat:deleteConversationBody",
        action: "chat:deleteAction",
        destructive: true,
      };
    case "clear":
      return {
        title: "chat:clearHistoryTitle",
        body: "chat:clearHistoryBody",
        action: "chat:clearAction",
        destructive: true,
      };
    case "switch":
      return {
        title: "chat:switchTitle",
        body: "chat:switchBody",
        action: "chat:switchAction",
        destructive: false,
      };
    case "new":
      return {
        title: "chat:newChatTitle",
        body: "chat:newChatBody",
        action: "chat:newChatAction",
        destructive: false,
      };
  }
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

/** Conversation ids must be real UUIDs: the backend validates them. */
function newUuid(): string {
  const cryptoApi = globalThis.crypto as
    | {
        randomUUID?: () => string;
        getRandomValues?: (values: Uint8Array) => Uint8Array;
      }
    | undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  );
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
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
        <FluentButton
          appearance="secondary"
          size="small"
          disabled={confirmBusy}
          onClick={onCancel}
        >
          {t("chat:confirmCancel")}
        </FluentButton>
        <FluentButton
          appearance="primary"
          size="small"
          disabled={confirmBusy}
          onClick={onApply}
        >
          {confirmBusy ? t("chat:confirmApplying") : t("chat:confirmApply")}
        </FluentButton>
      </div>
    </div>
  );
}
