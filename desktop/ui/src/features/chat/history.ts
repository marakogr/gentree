// Pure chat-history rules: ordering, selection, limit preemption and the
// mapping between the screen's `ChatEntry` and the persisted DTO. Keeping these
// functions free of React and IPC makes each rule directly testable.

import type {
  ChatHistoryConversation,
  ChatHistoryEntry,
  ChatHistoryLimits,
  ChatHistoryStatus,
  ChatHistorySummary,
  ChatHistoryTool,
  DateValue,
} from "../../api/types";
import type {
  ChatEntry,
  ChatEntryStatus,
  ChatToolCall,
  ChatToolStatus,
} from "./stream";

export type HistoryLimitScope = "conversation" | "project";

/** Newest first; the id is a stable tie-breaker for equal timestamps. */
export function sortConversations(
  rows: readonly ChatHistorySummary[],
): ChatHistorySummary[] {
  return [...rows].sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.id.localeCompare(right.id),
  );
}

/**
 * Selection after deleting one conversation: the next healthy row in list
 * order, then the previous healthy row, otherwise `null` for the empty state.
 * A damaged row is never selected.
 */
export function nextConversationId(
  rows: readonly ChatHistorySummary[],
  deletedId: string,
): string | null {
  const sorted = sortConversations(rows);
  const index = sorted.findIndex((row) => row.id === deletedId);
  const start = index === -1 ? 0 : index + 1;
  for (let position = start; position < sorted.length; position += 1) {
    if (!sorted[position].damaged) return sorted[position].id;
  }
  for (let position = start - 2; position >= 0; position -= 1) {
    if (!sorted[position].damaged) return sorted[position].id;
  }
  return null;
}

/**
 * A turn adds a user entry and an assistant entry, so `maxEntries - 2` is the
 * last usable size. A blocked turn must stop before the provider call.
 */
export function sendLimitScope(
  limits: ChatHistoryLimits,
  entryCount: number,
): HistoryLimitScope | null {
  return entryCount + 2 > limits.maxEntries ? "conversation" : null;
}

/** A new conversation cannot be created once the project-wide cap is reached. */
export function newConversationLimitScope(
  limits: ChatHistoryLimits,
  conversationCount: number,
): HistoryLimitScope | null {
  return conversationCount >= limits.maxConversations ? "project" : null;
}

/**
 * The conversation opened on startup: the most recent healthy row, skipping
 * ones already known to be unreadable. `null` means the empty state.
 */
export function startupConversationId(
  rows: readonly ChatHistorySummary[],
  skipped: readonly string[] = [],
): string | null {
  const skip = new Set(skipped);
  for (const row of sortConversations(rows)) {
    if (!row.damaged && !skip.has(row.id)) return row.id;
  }
  return null;
}

function normalizeStatus(status: ChatHistoryStatus): ChatEntryStatus {
  return status === "pending" || status === "streaming" ? "cancelled" : status;
}

function normalizeToolStatus(status: ChatHistoryTool["status"]): ChatToolStatus {
  // A tool that was still running at the terminal boundary never completed.
  return status === "running" ? "error" : status;
}

function fromHistoryTool(tool: ChatHistoryTool): ChatToolCall {
  return {
    name: tool.name,
    status: normalizeToolStatus(tool.status),
    durationMs: tool.durationMs ?? null,
    ...(tool.arguments !== undefined ? { arguments: tool.arguments } : {}),
    ...(tool.result !== undefined ? { result: tool.result } : {}),
  };
}

function toHistoryTool(tool: ChatToolCall): ChatHistoryTool {
  return {
    name: tool.name,
    status: normalizeToolStatus(tool.status),
    ...(tool.durationMs !== null ? { durationMs: tool.durationMs } : {}),
    ...(tool.arguments !== undefined ? { arguments: tool.arguments } : {}),
    ...(tool.result !== undefined ? { result: tool.result } : {}),
  };
}

/**
 * Loaded entries carry no `requestId`, so a late event from an earlier request
 * cannot match them. Pending/streaming answers load as cancelled.
 */
export function toChatEntries(conversation: ChatHistoryConversation): ChatEntry[] {
  return conversation.entries.map((entry) => ({
    id: entry.id,
    role: entry.role,
    content: entry.content,
    requestId: null,
    status: normalizeStatus(entry.status),
    skills: entry.skills ?? [],
    tools: (entry.tools ?? []).map(fromHistoryTool),
  }));
}

/** Snapshot for storage: request ids are dropped and unfinished states settle. */
export function fromChatEntries(entries: readonly ChatEntry[]): ChatHistoryEntry[] {
  return entries.map((entry) => ({
    id: entry.id,
    role: entry.role,
    content: entry.content,
    status: normalizeStatus(entry.status),
    skills: [...entry.skills],
    tools: entry.tools.map(toHistoryTool),
  }));
}

/**
 * A `DateValue` for the list/detail date cell. The stored value is RFC 3339;
 * only the civil date is shown, so no timezone shifts a stored timestamp.
 */
export function historyDateValue(updatedAt: string): DateValue | null {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(updatedAt.trim());
  if (match === null) return null;
  return {
    start: match[1],
    end: match[1],
    precision: "DAY",
    qualifier: "EXACT",
    original: null,
  };
}
