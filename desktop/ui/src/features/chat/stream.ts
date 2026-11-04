// Pure chat stream reducer. The screen owns no stream logic: Tauri events and
// local actions all go through `reduceChat`, so ordering and status changes are
// testable without a browser or a provider.
//
// Contract: `chat.delta|done|error` events and the chat state machine.

import type { AppErrorEnvelope, ChatMessage } from "../../api/types";

export type ChatEntryRole = "user" | "assistant";

export type ChatEntryStatus =
  | "pending"
  | "streaming"
  | "done"
  | "error"
  | "cancelled";

/** Lifecycle of one tool call, mirroring the `chat-tool` wire status. */
export type ChatToolStatus = "running" | "ok" | "error";

export type ChatToolCall = {
  name: string;
  status: ChatToolStatus;
  /** Reported only on the final event; `null` while running. */
  durationMs: number | null;
  /** Raw JSON arguments, present on the `running` event. */
  arguments?: string;
  /** Serialized result or error, present on the final event. */
  result?: string;
};

/** Payload of the `chat-tool` event. */
export type ChatToolEvent = {
  requestId: string;
  name: string;
  status: ChatToolStatus;
  durationMs?: number;
  arguments?: string;
  result?: string;
};

export type ChatEntry = {
  id: string;
  role: ChatEntryRole;
  content: string;
  /** Set for assistant entries; ties deltas to one request. */
  requestId: string | null;
  status: ChatEntryStatus;
  /** Skills selected by the backend router for this request. */
  skills: string[];
  /** Tool calls made while producing this answer, in call order. */
  tools: ChatToolCall[];
};

export type ChatStreamState = {
  messages: ChatEntry[];
  activeRequestId: string | null;
  error: AppErrorEnvelope | null;
};

export const initialChatState: ChatStreamState = {
  messages: [],
  activeRequestId: null,
  error: null,
};

export type ChatAction =
  | { type: "send"; requestId: string; userId: string; content: string }
  | { type: "skill"; requestId: string; skills: string[] }
  | { type: "delta"; requestId: string; delta: string }
  | {
      type: "tool";
      requestId: string;
      name: string;
      status: ChatToolStatus;
      durationMs?: number;
      arguments?: string;
      result?: string;
    }
  | { type: "done"; requestId: string; content?: string }
  | { type: "error"; requestId: string; error: AppErrorEnvelope }
  | { type: "cancel"; requestId: string }
  | { type: "load"; messages: ChatEntry[] }
  | { type: "reset" };

/** Appends in send order; deltas update the matching assistant entry in place. */
export function reduceChat(
  state: ChatStreamState,
  action: ChatAction,
): ChatStreamState {
  switch (action.type) {
    case "send":
      return {
        messages: [
          ...state.messages,
          {
            id: action.userId,
            role: "user",
            content: action.content,
            requestId: null,
            status: "done",
            skills: [],
            tools: [],
          },
          {
            id: `assistant-${action.requestId}`,
            role: "assistant",
            content: "",
            requestId: action.requestId,
            status: "pending",
            skills: [],
            tools: [],
          },
        ],
        activeRequestId: action.requestId,
        error: null,
      };
    case "skill": {
      if (state.activeRequestId !== action.requestId) return state;
      const index = findAssistant(state.messages, action.requestId);
      if (index === -1) return state;
      return {
        ...state,
        messages: replaceAt(state.messages, index, (entry) => ({
          ...entry,
          skills: action.skills,
        })),
      };
    }
    case "delta": {
      if (state.activeRequestId !== action.requestId) return state;
      const index = findAssistant(state.messages, action.requestId);
      if (index === -1) return state;
      return {
        ...state,
        messages: replaceAt(state.messages, index, (entry) => ({
          ...entry,
          content: entry.content + action.delta,
          status: "streaming",
        })),
      };
    }
    case "tool": {
      if (state.activeRequestId !== action.requestId) return state;
      const index = findAssistant(state.messages, action.requestId);
      if (index === -1) return state;
      return {
        ...state,
        messages: replaceAt(state.messages, index, (entry) => ({
          ...entry,
          tools: mergeToolCall(entry.tools, action),
        })),
      };
    }
    case "done": {
      const index = findAssistant(state.messages, action.requestId);
      if (index === -1) return state;
      return {
        messages: replaceAt(state.messages, index, (entry) => ({
          ...entry,
          // The final event carries the full text; it corrects any lost delta.
          content: action.content ? action.content : entry.content,
          status: "done",
        })),
        activeRequestId:
          state.activeRequestId === action.requestId
            ? null
            : state.activeRequestId,
        error:
          state.activeRequestId === action.requestId ? null : state.error,
      };
    }
    case "error": {
      const index = findAssistant(state.messages, action.requestId);
      if (index === -1) return state;
      // A cancellation is a user action: show "cancelled", not an error banner,
      // even when the backend reports it as a `chat-error` event.
      const cancelled = action.error.code === "CHAT_CANCELLED";
      return {
        messages: replaceAt(state.messages, index, (entry) => ({
          ...entry,
          status: cancelled ? "cancelled" : "error",
        })),
        activeRequestId:
          state.activeRequestId === action.requestId
            ? null
            : state.activeRequestId,
        error: cancelled ? null : action.error,
      };
    }
    case "cancel": {
      const index = findAssistant(state.messages, action.requestId);
      if (index === -1) return state;
      return {
        messages: replaceAt(state.messages, index, (entry) => ({
          ...entry,
          status: "cancelled",
        })),
        activeRequestId:
          state.activeRequestId === action.requestId
            ? null
            : state.activeRequestId,
        error: null,
      };
    }
    case "load":
      // A loaded conversation has no live request. Its entries carry no
      // request id, so a late event for the previous request cannot match.
      return {
        messages: action.messages,
        activeRequestId: null,
        error: null,
      };
    case "reset":
      return initialChatState;
  }
}

function findAssistant(messages: ChatEntry[], requestId: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (entry.role === "assistant" && entry.requestId === requestId) {
      return index;
    }
  }
  return -1;
}

function replaceAt(
  messages: ChatEntry[],
  index: number,
  update: (entry: ChatEntry) => ChatEntry,
): ChatEntry[] {
  return messages.map((entry, position) =>
    position === index ? update(entry) : entry,
  );
}

/**
 * `running` opens a new call; the matching `ok`/`error` closes the most recent
 * still-running call with that name. A completion without a running entry is
 * appended, so a lost event cannot hide a call.
 */
function mergeToolCall(
  tools: ChatToolCall[],
  update: {
    name: string;
    status: ChatToolStatus;
    durationMs?: number;
    arguments?: string;
    result?: string;
  },
): ChatToolCall[] {
  if (update.status === "running") {
    return [
      ...tools,
      {
        name: update.name,
        status: "running",
        durationMs: null,
        ...(update.arguments !== undefined
          ? { arguments: update.arguments }
          : {}),
      },
    ];
  }
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index];
    if (tool.name === update.name && tool.status === "running") {
      return tools.map((entry, position) =>
        position === index
          ? {
              ...entry,
              status: update.status,
              durationMs: update.durationMs ?? null,
              ...(update.result !== undefined ? { result: update.result } : {}),
            }
          : entry,
      );
    }
  }
  return [
    ...tools,
    {
      name: update.name,
      status: update.status,
      durationMs: update.durationMs ?? null,
      ...(update.arguments !== undefined
        ? { arguments: update.arguments }
        : {}),
      ...(update.result !== undefined ? { result: update.result } : {}),
    },
  ];
}

/**
 * Completed turns plus the new user message. Pending/error/cancelled answers
 * are never sent back (a user message without a completed answer is dropped
 * with its answer), and the system prompt is added by the backend.
 */
export function buildTranscript(
  messages: ChatEntry[],
  next: string,
): ChatMessage[] {
  const transcript: ChatMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const entry = messages[index];
    if (entry.role === "user") {
      const answer = messages[index + 1];
      const answered =
        answer !== undefined &&
        answer.role === "assistant" &&
        answer.status === "done" &&
        answer.content.trim() !== "";
      if (!answered) continue;
      transcript.push({ role: "user", content: entry.content });
      continue;
    }
    if (entry.status === "done" && entry.content.trim() !== "") {
      transcript.push({ role: "assistant", content: entry.content });
    }
  }
  const trimmed = next.trim();
  if (trimmed !== "") {
    transcript.push({ role: "user", content: trimmed });
  }
  return transcript;
}
