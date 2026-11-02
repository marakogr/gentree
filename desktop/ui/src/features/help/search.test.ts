import { describe, expect, it } from "vitest";
import {
  filterHelpEntries,
  matchesHelpQuery,
  normalizeHelpText,
} from "./search";

describe("normalizeHelpText", () => {
  it("folds case, accents and ё", () => {
    expect(normalizeHelpText("  Ёлка  Événement ")).toBe("елка evenement");
    expect(normalizeHelpText("ДЕРЕВО")).toBe("дерево");
  });
});

describe("matchesHelpQuery", () => {
  it("requires every word, in any order", () => {
    const text = "Добавить событие: тип, дата, место и участники";
    expect(matchesHelpQuery(text, "событие")).toBe(true);
    expect(matchesHelpQuery(text, "место дата")).toBe(true);
    expect(matchesHelpQuery(text, "место фото")).toBe(false);
  });

  it("ignores punctuation and matches word fragments", () => {
    expect(matchesHelpQuery("Как добавить человека?", "добав")).toBe(true);
    expect(matchesHelpQuery("Как добавить человека?", "человека,")).toBe(true);
    expect(matchesHelpQuery("Как добавить человека?", "как?")).toBe(true);
  });

  it("matches nothing for an empty or punctuation-only query", () => {
    expect(matchesHelpQuery("Любое описание", "")).toBe(false);
    expect(matchesHelpQuery("Любое описание", "  ,.! ")).toBe(false);
  });
});

describe("filterHelpEntries", () => {
  it("keeps the declared order and returns only matching ids", () => {
    const entries = [
      { id: "start", text: "Проект — это папка на диске" },
      { id: "events", text: "Событие: дата и место" },
      { id: "tree", text: "Дерево от выбранного человека" },
    ];
    expect(filterHelpEntries(entries, "человек")).toEqual(["tree"]);
    expect(filterHelpEntries(entries, "место")).toEqual(["events"]);
    expect(filterHelpEntries(entries, "нет такого")).toEqual([]);
  });
});
