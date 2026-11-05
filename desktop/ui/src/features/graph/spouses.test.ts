import { describe, expect, it } from "vitest";
import type {
  AncestorGraph,
  DescendantGraph,
  Person,
  RelationshipEntity,
  Versioned,
} from "../../api/types";
import {
  EMPTY_SPOUSE_INDEX,
  SPOUSE_SESSION_KEY,
  buildSpouseIndex,
  decorateAncestorGraph,
  decorateDescendantGraph,
  readSpouseToggle,
  writeSpouseToggle,
  type SessionStorageLike,
} from "./spouses";
import { layoutDescendants } from "./layout";

function relationship(
  id: string,
  type: RelationshipEntity["type"],
  personId: string,
  relatedPersonId: string,
): Versioned<RelationshipEntity> {
  return {
    version: "v1",
    entity: {
      id,
      type,
      personId,
      relatedPersonId,
      notes: null,
    },
  };
}

function person(id: string, gender: Person["gender"] = "UNKNOWN"): Person {
  return {
    id,
    gender,
    names: [],
    birth: { start: null, end: null, precision: "UNKNOWN", qualifier: null, original: null },
    death: { start: null, end: null, precision: "UNKNOWN", qualifier: null, original: null },
    notes: null,
    externalIds: [],
  } as unknown as Person;
}

function descendantGraph(
  nodes: Array<[string, string, number]>,
): DescendantGraph {
  return {
    rootPersonId: nodes[0]?.[1] ?? "",
    generations: Math.max(0, ...nodes.map(([, , generation]) => generation)),
    nodes: nodes.map(([key, personId, generation]) => ({
      personId,
      occurrenceKey: key,
      generation,
      role: generation === 0 ? "ROOT" : "CHILD",
      adoptive: false,
    })),
    edges: [],
    truncated: false,
    pedigreeCollapse: false,
  };
}

function ancestorGraph(
  nodes: Array<[string, string | null, number, boolean?]>,
): AncestorGraph {
  return {
    rootPersonId: nodes[0]?.[1] ?? "",
    generations: Math.max(0, ...nodes.map(([, , generation]) => generation)),
    nodes: nodes.map(([key, personId, generation, placeholder]) => ({
      personId,
      occurrenceKey: key,
      generation,
      role: generation === 0 ? "ROOT" : "MOTHER",
      adoptive: false,
      placeholder: placeholder ?? false,
    })),
    edges: [],
    truncated: false,
    pedigreeCollapse: false,
  };
}

function people(...ids: string[]): Map<string, Person> {
  return new Map(ids.map((id) => [id, person(id)]));
}

function memoryStorage(initial: Record<string, string> = {}): SessionStorageLike & {
  values: Record<string, string>;
} {
  const values = { ...initial };
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value;
    },
  };
}

describe("buildSpouseIndex", () => {
  it("indexes SPOUSE and PARTNER rows in both directions", () => {
    const index = buildSpouseIndex([
      relationship("r1", "SPOUSE", "a", "b"),
      relationship("r2", "PARTNER", "c", "a"),
    ]);
    expect(index.partnersOf.get("a")).toEqual(["b", "c"]);
    expect(index.partnersOf.get("b")).toEqual(["a"]);
    expect(index.partnersOf.get("c")).toEqual(["a"]);
    expect(index.pairs.has("a|b")).toBe(true);
    expect(index.pairs.has("a|c")).toBe(true);
  });

  it("collapses reversed duplicates and self-links", () => {
    const index = buildSpouseIndex([
      relationship("r1", "SPOUSE", "a", "b"),
      relationship("r2", "SPOUSE", "b", "a"),
      relationship("r3", "PARTNER", "a", "a"),
    ]);
    expect(index.partnersOf.get("a")).toEqual(["b"]);
    expect(index.partnersOf.get("b")).toEqual(["a"]);
    expect(index.pairs.size).toBe(1);
  });

  it("keeps relationship order then id for several spouses", () => {
    const index = buildSpouseIndex([
      relationship("r1", "SPOUSE", "a", "z"),
      relationship("r2", "SPOUSE", "a", "m"),
      relationship("r3", "PARTNER", "m", "a"),
    ]);
    expect(index.partnersOf.get("a")).toEqual(["z", "m"]);
  });

  it("ignores non-spouse rows", () => {
    const index = buildSpouseIndex([
      relationship("r1", "PARENT_CHILD", "a", "b"),
      relationship("r2", "ADOPTIVE_PARENT_CHILD", "b", "c"),
    ]);
    expect([...index.partnersOf.keys()]).toEqual([]);
    expect(index.pairs.size).toBe(0);
  });
});

describe("spouse session toggle", () => {
  it("is off when storage is missing", () => {
    expect(readSpouseToggle(null)).toBe(false);
    expect(() => writeSpouseToggle(true, null)).not.toThrow();
  });

  it("round-trips a session value", () => {
    const storage = memoryStorage();
    writeSpouseToggle(true, storage);
    expect(storage.values[SPOUSE_SESSION_KEY]).toBe("1");
    expect(readSpouseToggle(storage)).toBe(true);
    writeSpouseToggle(false, storage);
    expect(readSpouseToggle(storage)).toBe(false);
  });

  it("treats corrupt values as off", () => {
    expect(readSpouseToggle(memoryStorage({ [SPOUSE_SESSION_KEY]: "yes" }))).toBe(
      false,
    );
  });

  it("swallows storage exceptions", () => {
    const throwing: SessionStorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readSpouseToggle(throwing)).toBe(false);
    expect(() => writeSpouseToggle(true, throwing)).not.toThrow();
  });
});

describe("decoration", () => {
  it("adds the root spouse on the root generation", () => {
    const index = buildSpouseIndex([relationship("r1", "SPOUSE", "root", "wife")]);
    const view = decorateDescendantGraph(
      descendantGraph([["0", "root", 0]]),
      people("root", "wife"),
      index,
    );
    expect(view.graph.nodes).toHaveLength(2);
    const spouse = view.graph.nodes[1];
    expect(spouse.generation).toBe(0);
    expect(spouse.personId).toBe("wife");
    expect(view.spouseOf.get(spouse.occurrenceKey)).toBe("0");
    expect(view.spousePairs).toEqual([["0", spouse.occurrenceKey]]);
  });

  it("adds a relative's partner, not a second blood card", () => {
    const index = buildSpouseIndex([
      relationship("r1", "PARTNER", "sibling", "partner"),
    ]);
    const view = decorateDescendantGraph(
      descendantGraph([
        ["0", "root", 0],
        ["0.c0", "sibling", 1],
      ]),
      people("root", "sibling", "partner"),
      index,
    );
    expect(view.graph.nodes).toHaveLength(3);
    const spouse = view.graph.nodes[2];
    expect(spouse.generation).toBe(1);
    expect(view.spouseOf.get(spouse.occurrenceKey)).toBe("0.c0");
  });

  it("keeps one card per person for duplicate and reversed rows", () => {
    const index = buildSpouseIndex([
      relationship("r1", "SPOUSE", "root", "wife"),
      relationship("r2", "SPOUSE", "wife", "root"),
    ]);
    const view = decorateDescendantGraph(
      descendantGraph([["0", "root", 0]]),
      people("root", "wife"),
      index,
    );
    expect(view.graph.nodes.filter((node) => node.personId === "wife")).toHaveLength(
      1,
    );
    expect(view.spousePairs).toHaveLength(1);
  });

  it("only connects a spouse who is already a blood relative", () => {
    const index = buildSpouseIndex([
      relationship("r1", "SPOUSE", "cousinA", "cousinB"),
    ]);
    const view = decorateDescendantGraph(
      descendantGraph([
        ["0", "root", 0],
        ["0.c0", "cousinA", 1],
        ["0.c1", "cousinB", 1],
      ]),
      people("root", "cousinA", "cousinB"),
      index,
    );
    expect(view.graph.nodes).toHaveLength(3);
    expect(view.spouseOf.size).toBe(0);
    expect(view.spousePairs).toEqual([["0.c0", "0.c1"]]);
  });

  it("shows every spouse of one person deterministically", () => {
    const index = buildSpouseIndex([
      relationship("r1", "SPOUSE", "root", "first"),
      relationship("r2", "SPOUSE", "root", "second"),
    ]);
    const view = decorateDescendantGraph(
      descendantGraph([["0", "root", 0]]),
      people("root", "first", "second"),
      index,
    );
    const partners = view.graph.nodes
      .filter((node) => view.spouseOf.has(node.occurrenceKey))
      .map((node) => node.personId);
    expect(partners).toEqual(["first", "second"]);
    expect(new Set(view.graph.nodes.map((node) => node.occurrenceKey)).size).toBe(
      view.graph.nodes.length,
    );
  });

  it("never adds a spouse twice when there are several anchors", () => {
    const index = buildSpouseIndex([
      relationship("r1", "SPOUSE", "root", "wife"),
      relationship("r2", "SPOUSE", "sibling", "wife"),
    ]);
    const view = decorateDescendantGraph(
      descendantGraph([
        ["0", "root", 0],
        ["0.c0", "sibling", 1],
      ]),
      people("root", "sibling", "wife"),
      index,
    );
    expect(view.graph.nodes.filter((node) => node.personId === "wife")).toHaveLength(
      1,
    );
    expect(view.spousePairs).toHaveLength(2);
  });

  it("ignores a partner outside the loaded project and unknown gender", () => {
    const index = buildSpouseIndex([
      relationship("r1", "SPOUSE", "root", "missing"),
      relationship("r2", "SPOUSE", "root", "unknown"),
    ]);
    const view = decorateDescendantGraph(
      descendantGraph([["0", "root", 0]]),
      people("root", "unknown"),
      index,
    );
    expect(view.graph.nodes).toHaveLength(2);
    expect(view.graph.nodes[1].role).toBe("CHILD");
  });

  it("returns the base graph unchanged without spouse data", () => {
    const graph = descendantGraph([["0", "root", 0]]);
    const view = decorateDescendantGraph(graph, people("root"), EMPTY_SPOUSE_INDEX);
    expect(view.graph).toEqual(graph);
    expect(view.spouseOf.size).toBe(0);
    expect(view.spousePairs).toEqual([]);
  });

  it("adds ancestor spouses in the anchor generation", () => {
    const index = buildSpouseIndex([
      relationship("r1", "SPOUSE", "grandpa", "secondWife"),
    ]);
    const view = decorateAncestorGraph(
      ancestorGraph([
        ["0", "root", 0],
        ["0.f", "father", 1],
        ["0.f.f", "grandpa", 2],
      ]),
      people("root", "father", "grandpa", "secondWife"),
      index,
    );
    const spouse = view.graph.nodes.find((node) => node.personId === "secondWife");
    expect(spouse?.generation).toBe(2);
    expect(spouse?.placeholder).toBe(false);
    expect(view.spouseOf.get(spouse?.occurrenceKey ?? "")).toBe("0.f.f");
  });

  it("skips a placeholder parent and keeps the real root spouse", () => {
    const index = buildSpouseIndex([
      relationship("r1", "SPOUSE", "root", "wife"),
    ]);
    const view = decorateAncestorGraph(
      ancestorGraph([
        ["0", "root", 0],
        ["0.m", null, 1, true],
      ]),
      people("root", "wife"),
      index,
    );
    expect(view.graph.nodes).toHaveLength(3);
    expect(view.spouseOf.size).toBe(1);
    expect(view.spouseOf.get(view.graph.nodes[2].occurrenceKey)).toBe("0");
  });
});

describe("spouse view stress", () => {
  it("lays out hundreds of people and multiple marriages without duplicates or overlap", () => {
    const members = Array.from({ length: 300 }, (_, index) => `p${index}`);
    const lookup = new Map(
      members.map((id) => [id, person(id, "UNKNOWN")]),
    );
    const graph: DescendantGraph = {
      rootPersonId: "p0",
      generations: 1,
      nodes: [
        {
          personId: "p0",
          occurrenceKey: "0",
          generation: 0,
          role: "ROOT",
          adoptive: false,
        },
        ...members.slice(1).map((id, index) => ({
          personId: id,
          occurrenceKey: `0.c${index}`,
          generation: 1,
          role: "CHILD" as const,
          adoptive: false,
        })),
      ],
      edges: members.slice(1).map((_, index) => ({
        parentKey: "0",
        childKey: `0.c${index}`,
        adoptive: false,
      })),
      truncated: false,
      pedigreeCollapse: false,
    };
    const partnersOf = new Map<string, string[]>();
    const pairs = new Set<string>();
    const link = (left: string, right: string) => {
      const leftList = partnersOf.get(left) ?? [];
      leftList.push(right);
      partnersOf.set(left, leftList);
      const rightList = partnersOf.get(right) ?? [];
      rightList.push(left);
      partnersOf.set(right, rightList);
      pairs.add(left < right ? `${left}|${right}` : `${right}|${left}`);
    };
    members.slice(1).forEach((id, index) => {
      const spouse = `s${index}`;
      lookup.set(spouse, person(spouse, "UNKNOWN"));
      link(id, spouse);
      if (index % 5 === 0) {
        const second = `s${index}b`;
        lookup.set(second, person(second, "UNKNOWN"));
        link(id, second);
      }
    });
    const view = decorateDescendantGraph(
      graph,
      lookup,
      { partnersOf, pairs },
    );
    const layout = layoutDescendants(view.graph, {
      spouseOf: view.spouseOf,
      spousePairs: view.spousePairs,
    });

    expect(new Set(layout.nodes.map((node) => node.occurrenceKey)).size).toBe(
      layout.nodes.length,
    );
    expect(layout.nodes.length).toBeGreaterThan(500);

    const rows = new Map<number, typeof layout.nodes>();
    for (const node of layout.nodes) {
      const row = rows.get(node.generation) ?? [];
      row.push(node);
      rows.set(node.generation, row);
    }
    for (const row of rows.values()) {
      const sorted = [...row].sort((left, right) => left.x - right.x);
      for (let index = 1; index < sorted.length; index += 1) {
        expect(sorted[index].x).toBeGreaterThanOrEqual(
          sorted[index - 1].x + sorted[index - 1].width,
        );
      }
    }

    expect(
      layoutDescendants(view.graph, {
        spouseOf: view.spouseOf,
        spousePairs: view.spousePairs,
      }),
    ).toEqual(layout);
  });
});
