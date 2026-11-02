import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createEntityIndex, type EntityPerson } from "../features/chat/entityLinks";
import { parseMarkdown, renderInline } from "./Markdown";

describe("parseMarkdown", () => {
  it("parses headings, paragraphs and lists", () => {
    const blocks = parseMarkdown(
      "## Итог\n\nТекст с **жирным**.\n\n- один\n- два\n\n1. первый\n2. второй",
    );
    expect(blocks[0]).toEqual({ kind: "heading", level: 2, text: "Итог" });
    expect(blocks[1]).toEqual({
      kind: "paragraph",
      text: "Текст с **жирным**.",
    });
    expect(blocks[2]).toEqual({
      kind: "list",
      ordered: false,
      items: ["один", "два"],
    });
    expect(blocks[3]).toEqual({
      kind: "list",
      ordered: true,
      items: ["первый", "второй"],
    });
  });

  it("keeps fenced code verbatim and does not parse it as Markdown", () => {
    const blocks = parseMarkdown("```json\n{\"a\": 1}\n```");
    expect(blocks).toEqual([
      { kind: "code", language: "json", code: "{\"a\": 1}" },
    ]);
  });

  it("parses tables and quotes", () => {
    const blocks = parseMarkdown(
      "> цитата\n\n| Имя | Год |\n| --- | --- |\n| Иван | 1900 |",
    );
    expect(blocks[0]).toEqual({ kind: "quote", text: "цитата" });
    expect(blocks[1]).toEqual({
      kind: "table",
      header: ["Имя", "Год"],
      rows: [["Иван", "1900"]],
    });
  });

  it("renders raw HTML as literal text", () => {
    const blocks = parseMarkdown("<script>alert(1)</script>");
    expect(blocks).toEqual([
      { kind: "paragraph", text: "<script>alert(1)</script>" },
    ]);
  });

  it("keeps interrupted streams readable", () => {
    const blocks = parseMarkdown("**незакрытый");
    expect(blocks).toEqual([{ kind: "paragraph", text: "**незакрытый" }]);
  });
});

describe("inline person links", () => {
  const persons: EntityPerson[] = [
    {
      id: "p-1",
      names: [
        {
          surname: "Петров",
          given: "Иван",
          patronymic: "Иванович",
          prefix: null,
          suffix: null,
          nameType: "BIRTH",
          isPrimary: true,
        },
      ],
    },
  ];

  function flatten(nodes: ReactNode[]): ReactNode[] {
    return nodes.flat(Infinity) as ReactNode[];
  }

  it("turns a known full name into a link button", () => {
    const nodes = flatten(
      renderInline("Это Иван Петров.", {
        index: createEntityIndex(persons),
        onOpenPerson: () => undefined,
      }),
    );
    const buttons = nodes.filter(
      (node): node is ReactElement<{ className: string; children: ReactNode }> =>
        isValidElement(node) && node.type === "button",
    );
    expect(buttons).toHaveLength(1);
    expect(buttons[0].props.className).toBe("entity-link");
    expect(buttons[0].props.children).toBe("Иван Петров");
  });

  it("renders an explicit person link as a card button", () => {
    const nodes = flatten(
      renderInline("[Иван Петров](gentree://person/p-1)", {
        index: null,
        onOpenPerson: () => undefined,
        knownPersonIds: new Set(["p-1"]),
      }),
    );
    const buttons = nodes.filter(
      (node): node is ReactElement<{ className: string; children: ReactNode }> =>
        isValidElement(node) && node.type === "button",
    );
    expect(buttons).toHaveLength(1);
    expect(buttons[0].props.className).toBe("entity-link");
    expect(buttons[0].props.children).toBe("Иван Петров");
  });

  it("keeps a person link with an unknown id as plain text", () => {
    const nodes = flatten(
      renderInline("[Иван Петров](gentree://person/missing)", {
        index: null,
        onOpenPerson: () => undefined,
        knownPersonIds: new Set(["p-1"]),
      }),
    );
    const buttons = nodes.filter(
      (node) => isValidElement(node) && node.type === "button",
    );
    expect(buttons).toHaveLength(0);
    expect(nodes.join("")).toBe("Иван Петров");
  });

  it("renders a person link inside bold text alongside external links", () => {
    const nodes = flatten(
      renderInline(
        "**[Иван Петров](gentree://person/p-1)** и [архив](https://example.com)",
        { index: null, onOpenPerson: () => undefined, knownPersonIds: new Set(["p-1"]) },
      ),
    );
    const elements = nodes.filter((node): node is ReactElement => isValidElement(node));
    expect(elements.map((node) => node.type)).toEqual(["strong", "a"]);
  });

  it("does not nest links inside Markdown code or links", () => {
    const nodes = flatten(
      renderInline("`Иван Петров` и [Иван Петров](https://example.com)", {
        index: createEntityIndex(persons),
        onOpenPerson: () => undefined,
      }),
    );
    const buttons = nodes.filter(
      (node) => isValidElement(node) && node.type === "button",
    );
    expect(buttons).toHaveLength(0); // code span and link label stay plain
    const code = nodes.find(
      (node): node is ReactElement<{ children: ReactNode }> =>
        isValidElement(node) && node.type === "code",
    );
    expect(code?.props.children).toBe("Иван Петров");
  });
});
