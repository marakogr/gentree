import { describe, expect, it } from "vitest";
import {
  blockingViolations,
  boundaryViolations,
  classifyPath,
  compareAllowlist,
  countOccurrences,
  duplicateCssBlocks,
  exportedNames,
  formatObserved,
  importSpecifiers,
  kitPurityViolations,
  parseAllowlist,
  rawPrimitiveCount,
  rawTableCount,
  resolveImport,
  styleViolations,
  utilityClassCount,
} from "./ui-kit-rules.mjs";

describe("classifyPath", () => {
  it("maps the layers", () => {
    expect(classifyPath("src/components/ui/button.tsx")).toBe("primitives");
    expect(classifyPath("src/components/patterns/page.tsx")).toBe("patterns");
    expect(classifyPath("src/components/filters/FilterBar.tsx")).toBe("patterns");
    expect(classifyPath("src/components/Markdown.tsx")).toBe("shared");
    expect(classifyPath("src/features/persons/PersonsPage.tsx")).toBe("features");
    expect(classifyPath("src/api/client.ts")).toBe("api");
    expect(classifyPath("src/lib/dates.ts")).toBe("lib");
  });

  it("marks tests before their layer", () => {
    expect(classifyPath("src/features/persons/helpers.test.ts")).toBe("test");
    expect(classifyPath("src/components/ui/helpers.test.ts")).toBe("test");
  });

  it("normalises windows separators", () => {
    expect(classifyPath("src\\components\\ui\\button.tsx")).toBe("primitives");
  });
});

describe("countOccurrences", () => {
  it("counts every match and ignores overlapping empty matches", () => {
    expect(countOccurrences("<button></button><select>", /<(?:button|select)\b/g)).toBe(2);
    expect(countOccurrences("abc", /x*/g)).toBe(4);
  });
});

describe("imports", () => {
  it("collects both import forms once", () => {
    const text = 'import a from "./a";\nimport { b } from "./b";\nimport "./c";';
    expect(importSpecifiers(text).sort()).toEqual(["./a", "./b", "./c"]);
  });

  it("resolves relative imports", () => {
    expect(resolveImport("src/components/ui/button.tsx", "../../api/types")).toBe(
      "src/api/types",
    );
    expect(resolveImport("src/features/x/y.tsx", "../helpers")).toBe(
      "src/features/helpers",
    );
    expect(resolveImport("src/features/x/y.tsx", "react")).toBeNull();
  });
});

describe("boundaryViolations", () => {
  it("fails a component importing a feature or the API", () => {
    const text = [
      'import { projectsApi } from "../api/client";',
      'import { ProjectDialog } from "../features/projects/ProjectDialog";',
    ].join("\n");
    expect(boundaryViolations("src/components/SidebarProject.tsx", text)).toBe(2);
  });

  it("allows a feature importing shared patterns", () => {
    const text = 'import { Button } from "../../components/ui/button";';
    expect(boundaryViolations("src/features/persons/PersonsPage.tsx", text)).toBe(0);
  });

  it("fails a primitive importing a pattern", () => {
    const text = 'import { PageShell } from "../patterns/page-shell";';
    expect(boundaryViolations("src/components/ui/button.tsx", text)).toBe(1);
  });

  it("fails a pure helper importing a component but not a React hook", () => {
    expect(
      boundaryViolations(
        "src/lib/format.ts",
        'import { Button } from "../components/ui/button";',
      ),
    ).toBe(1);
    expect(
      boundaryViolations(
        "src/lib/useThing.ts",
        'import { useState } from "react";\nimport { Button } from "../components/ui/button";',
      ),
    ).toBe(0);
  });
});

describe("raw controls", () => {
  it("counts native controls and hand-written dialogs", () => {
    const text = '<button /><select /><div role="dialog" /><input />';
    expect(rawPrimitiveCount(text)).toBe(4);
  });

  it("does not count Fluent components", () => {
    expect(rawPrimitiveCount("<Button /><Dialog />")).toBe(0);
  });

  it("counts raw tables separately", () => {
    expect(rawTableCount("<table><tbody /></table>")).toBe(1);
    expect(rawTableCount("<Table><TableBody /></Table>")).toBe(0);
  });
});

describe("kit purity", () => {
  it("fails translations and domain imports in the kit", () => {
    const text = [
      'import { useTranslation } from "react-i18next";',
      'import type { Person } from "../api/types";',
      "const { t } = useTranslation();",
    ].join("\n");
    expect(kitPurityViolations("src/components/Card.tsx", text)).toBe(3);
  });

  it("allows a screen to translate", () => {
    expect(
      kitPurityViolations(
        "src/features/persons/PersonsPage.tsx",
        'import { useTranslation } from "react-i18next";',
      ),
    ).toBe(0);
  });
});

describe("styles", () => {
  it("counts raw colours and Tailwind utilities in kit files", () => {
    expect(styleViolations("src/components/ui/a.tsx", 'color: "#fff";')).toBe(1);
    expect(styleViolations("src/components/ui/a.tsx", 'className="flex gap-2"')).toBe(1);
    expect(
      styleViolations("src/components/ui/a.tsx", 'className="year-range-track-block"'),
    ).toBe(0);
  });

  it("ignores feature stylesheets", () => {
    expect(styleViolations("src/features/persons/persons.css", "color: #fff;")).toBe(0);
  });

  it("counts utility tokens as whole class names only", () => {
    expect(utilityClassCount('className="items-center"')).toBe(1);
    expect(utilityClassCount('className="card-head"')).toBe(0);
  });
});

describe("exports and duplicate CSS", () => {
  it("reads declaration and list exports", () => {
    const names = exportedNames(
      'export function A() {}\nexport const B = 1;\nexport type C = string;\nexport { D as E };',
    );
    expect(names.sort()).toEqual(["A", "B", "C", "E"]);
  });

  it("finds byte-identical rules", () => {
    const block = "{ display: flex; align-items: center; justify-content: space-between; }";
    const files = [
      { file: "src/a.css", text: `.a ${block}` },
      { file: "src/b.css", text: `.a ${block}\n.a ${block}` },
    ];
    const duplicates = duplicateCssBlocks(files);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].file).toBe("src/b.css");
    expect(duplicates[0].count).toBe(2);
  });

  it("does not treat a shared body under different selectors as a duplicate", () => {
    const block = "{ display: flex; align-items: center; justify-content: space-between; }";
    const files = [
      { file: "src/a.css", text: `.a ${block}` },
      { file: "src/b.css", text: `.b ${block}` },
    ];
    expect(duplicateCssBlocks(files)).toEqual([]);
  });

  it("ignores tiny blocks and comments", () => {
    const files = [
      { file: "src/a.css", text: ".a { color: red; }" },
      { file: "src/b.css", text: "/* x */\n.b { color: red; }" },
    ];
    expect(duplicateCssBlocks(files)).toEqual([]);
  });
});

describe("allowlist", () => {
  const valid = {
    version: 1,
    entries: [
      { rule: "raw-primitive", file: "src/features/a.tsx", count: 2, reason: "legacy" },
    ],
  };

  it("parses a valid allowlist", () => {
    expect(parseAllowlist(valid)).toEqual({ entries: valid.entries, problems: [] });
  });

  it("reports malformed entries instead of throwing", () => {
    const parsed = parseAllowlist({
      version: 1,
      entries: [
        { rule: "unknown", file: "a", count: 1, reason: "x" },
        { rule: "style", file: "", count: 1, reason: "x" },
        { rule: "style", file: "a", count: -1, reason: "x" },
        { rule: "style", file: "a", count: 1, reason: "" },
      ],
    });
    expect(parsed.entries).toEqual([]);
    expect(parsed.problems).toHaveLength(4);
  });

  it("fails a raised count but passes a lowered one as stale", () => {
    const raised = compareAllowlist(
      [{ rule: "raw-primitive", file: "src/features/a.tsx", count: 3 }],
      valid.entries,
    );
    expect(raised.ok).toBe(false);
    expect(raised.violations[0]).toMatchObject({ allowed: 2, count: 3 });

    const lowered = compareAllowlist(
      [{ rule: "raw-primitive", file: "src/features/a.tsx", count: 1 }],
      valid.entries,
    );
    expect(lowered.ok).toBe(true);
    expect(lowered.stale[0]).toMatchObject({ count: 2, observed: 1 });
  });

  it("fails a new unlisted file and reports a vanished one", () => {
    const result = compareAllowlist(
      [{ rule: "raw-primitive", file: "src/features/new.tsx", count: 1 }],
      valid.entries,
    );
    expect(result.violations).toHaveLength(1);
    expect(result.stale[0].observed).toBe(0);
  });

  it("filters violations by blocking rule", () => {
    const result = {
      violations: [
        { rule: "boundaries", file: "a", count: 1 },
        { rule: "style", file: "b", count: 1 },
      ],
      stale: [],
      ok: false,
    };
    expect(blockingViolations(result, new Set(["style"]))).toHaveLength(1);
    expect(blockingViolations(result, new Set(["*"]))).toHaveLength(2);
  });

  it("formats stable rule/file/count lines", () => {
    expect(
      formatObserved([
        { rule: "style", file: "b.tsx", count: 1 },
        { rule: "boundaries", file: "a.tsx", count: 2 },
        { rule: "style", file: "c.tsx", count: 0 },
      ]),
    ).toEqual(["boundaries a.tsx 2", "style b.tsx 1"]);
  });
});
