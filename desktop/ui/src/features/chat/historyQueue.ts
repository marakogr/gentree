// Serialized chat-history saves with per-conversation tombstones.
//
// The queue guarantees two things the screen cannot get from bare `invoke`
// calls: snapshots reach storage in the order they were produced, and a queued
// save for a conversation that was deleted (or for a project whose history was
// cleared) never recreates the file.

import type { ChatHistoryEntry, ChatHistorySummary } from "../../api/types";

export type HistorySave = (
  projectId: string,
  conversationId: string,
  entries: ChatHistoryEntry[],
) => Promise<ChatHistorySummary>;

/** A save that was discarded because its conversation is gone. */
export class DiscardedHistorySaveError extends Error {
  readonly code = "CHAT_HISTORY_DISCARDED";

  constructor() {
    super("Chat history save was discarded");
    this.name = "DiscardedHistorySaveError";
  }
}

export class HistoryQueue {
  private chain: Promise<void> = Promise.resolve();
  /** Bumped for one conversation when it is deleted. */
  private epochs = new Map<string, number>();
  /** Bumped for every conversation when the whole history is cleared. */
  private globalEpoch = 0;

  constructor(private readonly save: HistorySave) {}

  /**
   * Queues a whole-conversation snapshot. The returned promise resolves with
   * the storage summary, or rejects with [`DiscardedHistorySaveError`] when a
   * delete/clear happened before the save reached the front of the queue.
   */
  enqueue(
    projectId: string,
    conversationId: string,
    entries: readonly ChatHistoryEntry[],
  ): Promise<ChatHistorySummary> {
    const key = queueKey(projectId, conversationId);
    const epoch = this.epochs.get(key) ?? 0;
    const global = this.globalEpoch;
    const run = this.chain.then(() => {
      if (global !== this.globalEpoch || (this.epochs.get(key) ?? 0) !== epoch) {
        throw new DiscardedHistorySaveError();
      }
      return this.save(projectId, conversationId, [...entries]);
    });
    // Keep the chain alive after a rejection; callers still see their own error.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Discards queued saves for one deleted conversation. */
  tombstone(projectId: string, conversationId: string): void {
    const key = queueKey(projectId, conversationId);
    this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
  }

  /** Discards every queued save after "clear history". */
  tombstoneAll(): void {
    this.globalEpoch += 1;
  }

  /** Resolves when every queued save has settled (including discarded ones). */
  idle(): Promise<void> {
    return this.chain;
  }
}

function queueKey(projectId: string, conversationId: string): string {
  return `${projectId}:${conversationId}`;
}
