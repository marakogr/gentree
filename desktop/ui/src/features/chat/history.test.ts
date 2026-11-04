import { describe, expect, it } from "vitest";
import type {
  ChatHistoryConversation,
  ChatHistoryLimits,
  ChatHistorySummary,
} from "../../api/types";
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
import type { ChatEntry } from "./stream";

function row(
  id: string,
  updatedAt: string,
  damaged = false,
): ChatHistorySummary {
  return { id, title: id, updatedAt, damaged };
}

const limits: ChatHistoryLimits = {
  maxEntries: 4,
  maxConversationBytes: 1024,
  maxConversations: 2,
  maxProjectBytes: 4096,
  titleMaxChars: 80,
};

function conversation(
  entries: ChatHistoryConversation["entries"],
): ChatHistoryConversation {
  return {
    schema: 1,
    kind: "chat",
    id: "c1",
    projectId: "p1",
    title: "title",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    entries,
  };
}

describe("conversation list rules", () => {
  it("sorts newest first with a stable id tie-breaker", () => {
    const sorted = sortConversations([
      row("b", "2026-01-01T00:00:00Z"),
      row("a", "2026-02-01T00:00:00Z"),
      row("c", "2026-02-01T00:00:00Z"),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["a", "c", "b"]);
  });

  it("selects the next healthy conversation after a delete", () => {
    const rows = [
      row("new", "2026-03-01T00:00:00Z"),
      row("bad", "2026-02-01T00:00:00Z", true),
      row("old", "2026-01-01T00:00:00Z"),
    ];
    expect(nextConversationId(rows, "new")).toBe("old");
    expect(nextConversationId(rows, "old")).toBe("new");
    expect(nextConversationId([row("only", "2026-01-01T00:00:00Z")], "only")).toBe(
      null,
    );
  });

  it("chooses the most recent healthy startup conversation", () => {
    const rows = [
      row("bad", "2026-03-01T00:00:00Z", true),
      row("ok", "2026-02-01T00:00:00Z"),
      row("older", "2026-01-01T00:00:00Z"),
    ];
    expect(startupConversationId(rows)).toBe("ok");
    expect(startupConversationId(rows, ["ok"])).toBe("older");
    expect(startupConversationId([row("bad", "2026-01-01T00:00:00Z", true)])).toBe(
      null,
    );
  });

  it("preempts a turn and a new conversation at their caps", () => {
    expect(sendLimitScope(limits, 1)).toBeNull();
    expect(sendLimitScope(limits, 2)).toBeNull();
    expect(sendLimitScope(limits, 3)).toBe("conversation");
    expect(newConversationLimitScope(limits, 1)).toBeNull();
    expect(newConversationLimitScope(limits, 2)).toBe("project");
  });
});

describe("entry mapping", () => {
  it("normalizes unfinished statuses, drops request ids and stops running tools", () => {
    const loaded = toChatEntries(
      conversation([
        {
          id: "u1",
          role: "user",
          content: "question",
          status: "done",
          skills: [],
          tools: [],
        },
        {
          id: "a1",
          role: "assistant",
          content: "",
          status: "streaming",
          skills: ["core"],
          tools: [
            {
              name: "search",
              status: "running",
              durationMs: 5,
              arguments: "{}",
            },
          ],
        },
      ]),
    );
    expect(loaded[0].requestId).toBeNull();
    expect(loaded[1].status).toBe("cancelled");
    expect(loaded[1].requestId).toBeNull();
    expect(loaded[1].tools[0].status).toBe("error");
    expect(loaded[1].tools[0].durationMs).toBe(5);
  });

  it("writes a normalized snapshot without request ids", () => {
    const entries: ChatEntry[] = [
      {
        id: "u1",
        role: "user",
        content: "question",
        requestId: null,
        status: "done",
        skills: [],
        tools: [],
      },
      {
        id: "a1",
        role: "assistant",
        content: "partial",
        requestId: "r1",
        status: "streaming",
        skills: [],
        tools: [
          {
            name: "search",
            status: "running",
            durationMs: null,
            result: "later",
          },
        ],
      },
    ];
    const saved = fromChatEntries(entries);
    expect(saved[1].status).toBe("cancelled");
    expect("requestId" in saved[1]).toBe(false);
    expect(saved[1].tools[0].status).toBe("error");
    expect(saved[1].tools[0].durationMs).toBeUndefined();
    expect(saved[1].tools[0].result).toBe("later");
  });

  it("turns a stored RFC 3339 date into a civil DateValue", () => {
    expect(historyDateValue("2026-11-04T12:30:00Z")).toEqual({
      start: "2026-11-04",
      end: "2026-11-04",
      precision: "DAY",
      qualifier: "EXACT",
      original: null,
    });
    expect(historyDateValue("")).toBeNull();
  });
});
