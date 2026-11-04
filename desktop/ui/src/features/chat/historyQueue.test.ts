import { describe, expect, it, vi } from "vitest";
import type { ChatHistorySummary } from "../../api/types";
import { DiscardedHistorySaveError, HistoryQueue } from "./historyQueue";

function summary(conversationId: string): ChatHistorySummary {
  return {
    id: conversationId,
    title: conversationId,
    updatedAt: "2026-01-01T00:00:00Z",
    damaged: false,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("HistoryQueue", () => {
  it("runs saves one at a time in enqueue order", async () => {
    const calls: string[] = [];
    const gate = deferred();
    const queue = new HistoryQueue(async (_project, conversationId) => {
      calls.push(conversationId);
      if (conversationId === "a") await gate.promise;
      return summary(conversationId);
    });

    const first = queue.enqueue("p", "a", []);
    const second = queue.enqueue("p", "b", []);
    await Promise.resolve();
    expect(calls).toEqual(["a"]);

    gate.resolve();
    await first;
    await second;
    expect(calls).toEqual(["a", "b"]);
  });

  it("discards a queued save after its conversation is deleted", async () => {
    const gate = deferred();
    const save = vi.fn(async (_project: string, conversationId: string) => {
      if (conversationId === "keep") await gate.promise;
      return summary(conversationId);
    });
    const queue = new HistoryQueue(save);

    const keep = queue.enqueue("p", "keep", []);
    const deleted = queue.enqueue("p", "deleted", []);
    queue.tombstone("p", "deleted");
    gate.resolve();

    await keep;
    await expect(deleted).rejects.toBeInstanceOf(DiscardedHistorySaveError);
    expect(save).toHaveBeenCalledTimes(1);
    await expect(queue.idle()).resolves.toBeUndefined();
  });

  it("discards every queued save after clear history", async () => {
    const gate = deferred();
    const save = vi.fn(async () => {
      await gate.promise;
      return summary("one");
    });
    const queue = new HistoryQueue(save);

    const first = queue.enqueue("p", "one", []);
    const second = queue.enqueue("p", "two", []);
    queue.tombstoneAll();
    gate.resolve();

    await expect(first).rejects.toBeInstanceOf(DiscardedHistorySaveError);
    await expect(second).rejects.toBeInstanceOf(DiscardedHistorySaveError);
    expect(save).not.toHaveBeenCalled();
  });
});
