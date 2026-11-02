//! Safe, dependency-free Markdown for chat answers.
//!
//! The model output is untrusted text, so this renderer builds React elements
//! instead of HTML: there is no `dangerouslySetInnerHTML`, raw HTML is shown
//! as text, and external links are limited to `http(s)`. It covers the subset
//! the chat prompt asks for: headings, paragraphs, lists, quotes, fenced code,
//! tables, bold/italic/inline code, strikethrough and links.
//!
//! Person mentions are rendered as buttons. The assistant emits explicit
//! `[Name](gentree://person/<id>)` links, and plain full names are linkified by
//! `entityLinks` as a fallback. Linkification runs only on plain inline text, so
//! code spans, fenced code and Markdown links never nest another link inside
//! themselves.

import { createElement, Fragment, useMemo, type ReactNode } from "react";
import {
  createEntityIndex,
  type EntityIndex,
  type EntityPerson,
} from "../features/chat/entityLinks";

export type MarkdownBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; language: string; code: string }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "rule" };

export type MarkdownProps = {
  text: string;
  /** Known persons; when omitted, mentions stay plain text. */
  persons?: readonly EntityPerson[];
  /** Required together with `persons` for mentions to be clickable. */
  onOpenPerson?: (personId: string) => void;
};

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let index = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join("\n").trim();
    if (text !== "") blocks.push({ kind: "paragraph", text });
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index];

    const fence = /^\s*```([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      const language = fence[1] ?? "";
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ kind: "code", language, code: code.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        text: heading[2].trim(),
      });
      index += 1;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line)) {
      flushParagraph();
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushParagraph();
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", text: quote.join("\n").trim() });
      continue;
    }

    const unordered = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const isOrdered = ordered !== null;
      const items: string[] = [];
      while (index < lines.length) {
        const match = isOrdered
          ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[index])
          : /^\s*[-*+]\s+(.*)$/.exec(lines[index]);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      blocks.push({ kind: "list", ordered: isOrdered, items });
      continue;
    }

    if (line.includes("|") && looksLikeTableSeparator(lines[index + 1])) {
      flushParagraph();
      const header = splitTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes("|")) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  flushParagraph();
  return blocks;
}

function looksLikeTableSeparator(line: string | undefined): boolean {
  if (line === undefined) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell));
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

const INLINE_TOKEN =
  /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|`[^`]+`|\[[^\]]+\]\((?:https?:\/\/|gentree:\/\/person\/)[^)\s]+\)|~~[^~]+~~)/g;

/** `[label](gentree://person/<id>)`: the only non-http link the chat renders. */
const PERSON_LINK = /^\[([^\]]+)\]\(gentree:\/\/person\/([^)\s]+)\)$/;

type InlineContext = {
  index: EntityIndex | null;
  onOpenPerson?: (personId: string) => void;
  /** When known, a link id not in this set stays plain text. */
  knownPersonIds?: ReadonlySet<string>;
};

/** Renders plain inline text, turning known person names into link buttons. */
function renderPlain(
  text: string,
  context: InlineContext,
  keyPrefix: string,
): ReactNode {
  if (context.index === null || context.onOpenPerson === undefined) return text;
  const openPerson = context.onOpenPerson;
  return context.index.linkify(text).map((segment, index) => {
    if (segment.personId === undefined) return segment.text;
    const personId = segment.personId;
    return (
      <button
        key={`${keyPrefix}-person-${index}`}
        type="button"
        className="entity-link"
        onClick={() => openPerson(personId)}
      >
        {segment.text}
      </button>
    );
  });
}

/** Renders inline Markdown; raw HTML stays literal text. */
export function renderInline(
  text: string,
  context: InlineContext = { index: null },
): ReactNode[] {
  const pieces = text.split(INLINE_TOKEN);
  return pieces.map((piece, index) => {
    const key = `${index}-${piece.slice(0, 12)}`;
    if (piece.startsWith("**") && piece.endsWith("**")) {
      return <strong key={key}>{renderInline(piece.slice(2, -2), context)}</strong>;
    }
    if (piece.startsWith("__") && piece.endsWith("__")) {
      return <strong key={key}>{renderInline(piece.slice(2, -2), context)}</strong>;
    }
    if (piece.startsWith("~~") && piece.endsWith("~~")) {
      return <del key={key}>{renderInline(piece.slice(2, -2), context)}</del>;
    }
    if (piece.startsWith("`") && piece.endsWith("`") && piece.length > 1) {
      return <code key={key}>{piece.slice(1, -1)}</code>;
    }
    if (piece.startsWith("*") && piece.endsWith("*") && piece.length > 1) {
      return <em key={key}>{renderInline(piece.slice(1, -1), context)}</em>;
    }
    if (piece.startsWith("_") && piece.endsWith("_") && piece.length > 1) {
      return <em key={key}>{renderInline(piece.slice(1, -1), context)}</em>;
    }
    const personLink = PERSON_LINK.exec(piece);
    if (personLink) {
      const label = personLink[1];
      const personId = personLink[2];
      const openPerson = context.onOpenPerson;
      const known = context.knownPersonIds;
      if (openPerson !== undefined && (known === undefined || known.has(personId))) {
        return (
          <button
            key={key}
            type="button"
            className="entity-link"
            onClick={() => openPerson(personId)}
          >
            {label}
          </button>
        );
      }
      // Unknown id or no card handler: show the name, never a dead link.
      return label;
    }
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(piece);
    if (link) {
      return (
        <a key={key} href={link[2]} target="_blank" rel="noreferrer">
          {link[1]}
        </a>
      );
    }
    return renderPlain(piece, context, `${key}-text`);
  });
}

function renderParagraph(
  text: string,
  key: string,
  context: InlineContext,
): ReactNode {
  const lines = text.split("\n");
  return (
    <p key={key}>
      {lines.map((line, index) => (
        <Fragment key={`${key}-${index}`}>
          {index > 0 ? <br /> : null}
          {renderInline(line, context)}
        </Fragment>
      ))}
    </p>
  );
}

export function Markdown({ text, persons, onOpenPerson }: MarkdownProps) {
  const blocks = parseMarkdown(text);
  const index = useMemo(
    () =>
      persons !== undefined && persons.length > 0
        ? createEntityIndex(persons)
        : null,
    [persons],
  );
  const knownPersonIds = useMemo(
    () => (persons === undefined ? undefined : new Set(persons.map((person) => person.id))),
    [persons],
  );
  const context: InlineContext = { index, onOpenPerson, knownPersonIds };

  return (
    <div className="markdown chat-text">
      {blocks.map((block, blockIndex) => {
        const key = `block-${blockIndex}`;
        switch (block.kind) {
          case "paragraph":
            return renderParagraph(block.text, key, context);
          case "heading":
            return createElement(
              `h${Math.min(block.level, 6)}`,
              { key },
              renderInline(block.text, context),
            );
          case "list": {
            const items = block.items.map((item, itemIndex) => (
              <li key={`${key}-${itemIndex}`}>
                {renderInline(item, context)}
              </li>
            ));
            return block.ordered ? (
              <ol key={key}>{items}</ol>
            ) : (
              <ul key={key}>{items}</ul>
            );
          }
          case "quote":
            return (
              <blockquote key={key}>
                {renderParagraph(block.text, key, context)}
              </blockquote>
            );
          case "code":
            return (
              <pre key={key} className="md-code">
                <code>{block.code}</code>
              </pre>
            );
          case "table":
            return (
              <div key={key} className="md-table-wrap">
                <table className="md-table">
                  <thead>
                    <tr>
                      {block.header.map((cell, cellIndex) => (
                        <th key={`${key}-h-${cellIndex}`}>
                          {renderInline(cell, context)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={`${key}-r-${rowIndex}`}>
                        {row.map((cell, cellIndex) => (
                          <td key={`${key}-r-${rowIndex}-${cellIndex}`}>
                            {renderInline(cell, context)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "rule":
            return <hr key={key} />;
        }
      })}
    </div>
  );
}
