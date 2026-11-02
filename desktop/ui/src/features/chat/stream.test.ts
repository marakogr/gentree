import { describe, expect, it } from "vitest";
import type { AppErrorEnvelope } from "../../api/types";
import {
  buildTranscript,
  initialChatState,
  reduceChat,
  type ChatStreamState,
} from "./stream";

function withTurn(requestId: string, content: string): ChatStreamState {
  const sent = reduceChat(initialChatState, {
    type: "send",
    requestId,
    userId: `user-${requestId}`,
    content,
  });
  return reduceChat(sent, {
    type: "done",
    requestId,
    content: `answer to ${content}`,
  });
}

describe("reduceChat", () => {
  it("appends deltas to the assistant entry of the matching request", () => {
    const sent = reduceChat(initialChatState, {
      type: "send",
      requestId: "r1",
      userId: "u1",
      content: "hello",
    });
    const first = reduceChat(sent, {
      type: "delta",
      requestId: "r1",
      delta: "Hel",
    });
    const second = reduceChat(first, {
      type: "delta",
      requestId: "r1",
      delta: "lo",
    });

    expect(second.messages).toHaveLength(2);
    expect(second.messages[1]).toMatchObject({
      role: "assistant",
      requestId: "r1",
      content: "Hello",
      status: "streaming",
    });
    expect(second.activeRequestId).toBe("r1");
  });

  it("ignores deltas for unknown or finished requests", () => {
    const sent = reduceChat(initialChatState, {
      type: "send",
      requestId: "r1",
      userId: "u1",
      content: "hello",
    });
    expect(
      reduceChat(sent, { type: "delta", requestId: "other", delta: "x" }),
    ).toBe(sent);

    const done = reduceChat(sent, {
      type: "done",
      requestId: "r1",
      content: "final",
    });
    expect(
      reduceChat(done, { type: "delta", requestId: "r1", delta: "x" }),
    ).toBe(done);
  });

  it("finalizes with the full content from done and clears the active request", () => {
    const sent = reduceChat(initialChatState, {
      type: "send",
      requestId: "r1",
      userId: "u1",
      content: "hello",
    });
    const done = reduceChat(sent, {
      type: "done",
      requestId: "r1",
      content: "complete answer",
    });

    expect(done.messages[1]).toMatchObject({
      content: "complete answer",
      status: "done",
    });
    expect(done.activeRequestId).toBeNull();
    expect(done.error).toBeNull();
  });

  it("stores the error code and stops the stream", () => {
    const error: AppErrorEnvelope = { code: "CHAT_UNAVAILABLE" };
    const sent = reduceChat(initialChatState, {
      type: "send",
      requestId: "r1",
      userId: "u1",
      content: "hello",
    });
    const failed = reduceChat(sent, { type: "error", requestId: "r1", error });

    expect(failed.messages[1].status).toBe("error");
    expect(failed.activeRequestId).toBeNull();
    expect(failed.error?.code).toBe("CHAT_UNAVAILABLE");
  });

  it("marks a request cancelled without an error banner", () => {
    const sent = reduceChat(initialChatState, {
      type: "send",
      requestId: "r1",
      userId: "u1",
      content: "hello",
    });
    const cancelled = reduceChat(sent, { type: "cancel", requestId: "r1" });

    expect(cancelled.messages[1].status).toBe("cancelled");
    expect(cancelled.activeRequestId).toBeNull();
    expect(cancelled.error).toBeNull();
  });

  it("treats a CHAT_CANCELLED error event as a cancel, not a failure", () => {
    const sent = reduceChat(initialChatState, {
      type: "send",
      requestId: "r1",
      userId: "u1",
      content: "hello",
    });
    const cancelled = reduceChat(sent, {
      type: "error",
      requestId: "r1",
      error: { code: "CHAT_CANCELLED" },
    });

    expect(cancelled.messages[1].status).toBe("cancelled");
    expect(cancelled.activeRequestId).toBeNull();
    expect(cancelled.error).toBeNull();
  });
});

describe("tool calls", () => {
  function sent(requestId = "r1") {
    return reduceChat(initialChatState, {
      type: "send",
      requestId,
      userId: `user-${requestId}`,
      content: "who is Petrov?",
    });
  }

  it("closes a running call and keeps the list after done", () => {
    const running = reduceChat(sent(), {
      type: "tool",
      requestId: "r1",
      name: "search",
      status: "running",
    });
    expect(running.messages[1].tools).toEqual([
      { name: "search", status: "running", durationMs: null },
    ]);

    const ok = reduceChat(running, {
      type: "tool",
      requestId: "r1",
      name: "search",
      status: "ok",
      durationMs: 12,
    });
    expect(ok.messages[1].tools).toEqual([
      { name: "search", status: "ok", durationMs: 12 },
    ]);

    const done = reduceChat(ok, {
      type: "done",
      requestId: "r1",
      content: "Found one person.",
    });
    expect(done.messages[1].tools).toEqual([
      { name: "search", status: "ok", durationMs: 12 },
    ]);
  });

  it("keeps repeated calls with the same name in call order", () => {
    let state = sent();
    for (const durationMs of [3, 7]) {
      state = reduceChat(state, {
        type: "tool",
        requestId: "r1",
        name: "get_person",
        status: "running",
      });
      state = reduceChat(state, {
        type: "tool",
        requestId: "r1",
        name: "get_person",
        status: "ok",
        durationMs,
      });
    }

    expect(state.messages[1].tools).toEqual([
      { name: "get_person", status: "ok", durationMs: 3 },
      { name: "get_person", status: "ok", durationMs: 7 },
    ]);
  });

  it("records a failed call without stopping the stream", () => {
    const running = reduceChat(sent(), {
      type: "tool",
      requestId: "r1",
      name: "get_project",
      status: "running",
    });
    const failed = reduceChat(running, {
      type: "tool",
      requestId: "r1",
      name: "get_project",
      status: "error",
      durationMs: 4,
    });

    expect(failed.messages[1].tools).toEqual([
      { name: "get_project", status: "error", durationMs: 4 },
    ]);
    expect(failed.messages[1].status).toBe("pending");
  });

  it("appends a completion that lost its running event", () => {
    const state = reduceChat(sent(), {
      type: "tool",
      requestId: "r1",
      name: "list_projects",
      status: "ok",
      durationMs: 1,
    });
    expect(state.messages[1].tools).toEqual([
      { name: "list_projects", status: "ok", durationMs: 1 },
    ]);
  });

  it("ignores tool events for unknown or finished requests", () => {
    const sentState = sent();
    expect(
      reduceChat(sentState, {
        type: "tool",
        requestId: "other",
        name: "search",
        status: "running",
      }),
    ).toBe(sentState);

    const done = reduceChat(sentState, {
      type: "done",
      requestId: "r1",
      content: "answer",
    });
    expect(
      reduceChat(done, {
        type: "tool",
        requestId: "r1",
        name: "search",
        status: "running",
      }),
    ).toBe(done);
  });
});

describe("skills", () => {
  it("stores the selected skills on the matching assistant entry", () => {
    const sent = reduceChat(initialChatState, {
      type: "send",
      requestId: "r1",
      userId: "u1",
      content: "сколько бабушек?",
    });
    const withSkills = reduceChat(sent, {
      type: "skill",
      requestId: "r1",
      skills: ["core", "family-relations"],
    });

    expect(withSkills.messages[1].skills).toEqual([
      "core",
      "family-relations",
    ]);
    expect(
      reduceChat(withSkills, {
        type: "skill",
        requestId: "other",
        skills: ["core"],
      }),
    ).toBe(withSkills);
  });
});

describe("message ordering", () => {
  it("keeps user/assistant pairs in send order across several turns", () => {
    const first = withTurn("r1", "first");
    const secondInput = reduceChat(first, {
      type: "send",
      requestId: "r2",
      userId: "u2",
      content: "second",
    });
    const second = reduceChat(secondInput, {
      type: "done",
      requestId: "r2",
      content: "answer to second",
    });

    expect(
      second.messages.map((message) => `${message.role}:${message.content}`),
    ).toEqual([
      "user:first",
      "assistant:answer to first",
      "user:second",
      "assistant:answer to second",
    ]);
    expect(second.activeRequestId).toBeNull();
  });

  it("builds the transcript from completed turns only, in order", () => {
    const first = withTurn("r1", "first");
    const pending = reduceChat(first, {
      type: "send",
      requestId: "r2",
      userId: "u2",
      content: "second",
    });
    const cancelled = reduceChat(pending, {
      type: "cancel",
      requestId: "r2",
    });
    const next = buildTranscript(cancelled.messages, "  third  ");

    expect(next).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "answer to first" },
      { role: "user", content: "third" },
    ]);
  });
});
