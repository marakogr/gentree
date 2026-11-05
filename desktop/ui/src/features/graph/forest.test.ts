import { describe, expect, it } from "vitest";
import type { ParentEdges } from "./parents";
import { buildBloodTree, buildFullTree } from "./forest";
import { decorateDescendantGraph, type SpouseIndex } from "./spouses";
import { layoutDescendants } from "./layout";

function person(id: string, gender: "MALE" | "FEMALE" | "UNKNOWN" = "UNKNOWN") {
  return { id, gender };
}

function parentsOf(entries: Record<string, [string, string?]>): ParentEdges {
  const map = new Map<string, { parentId: string; adoptive: boolean }[]>();
  for (const [child, [first, second]] of Object.entries(entries)) {
    map.set(child, [
      { parentId: first, adoptive: false },
      ...(second ? [{ parentId: second, adoptive: false }] : []),
    ]);
  }
  return map;
}

describe("buildFullTree", () => {
  it("keeps every person and connects a child to one primary parent", () => {
    const tree = buildFullTree(
      [person("grandpa"), person("father", "MALE"), person("child")],
      parentsOf({ father: ["grandpa"], child: ["father"] }),
    );
    expect(tree.graph.nodes.map((node) => node.occurrenceKey)).toEqual([
      "grandpa",
      "father",
      "child",
    ]);
    expect(tree.graph.edges).toHaveLength(2);
    expect(tree.extraEdges).toEqual([]);
    expect(tree.graph.rootPersonId).toBe("");
    expect(
      tree.graph.nodes.find((node) => node.occurrenceKey === "father")
        ?.generation,
    ).toBe(1);
  });

  it("returns a second parent link as an extra edge, not a second placement", () => {
    const tree = buildFullTree(
      [person("father", "MALE"), person("mother", "FEMALE"), person("child")],
      parentsOf({ child: ["mother", "father"] }),
    );
    expect(tree.graph.edges).toHaveLength(1);
    expect(tree.graph.edges[0].parentKey).toBe("father");
    expect(tree.extraEdges).toHaveLength(1);
    expect(tree.extraEdges[0].parentKey).toBe("mother");
  });

  it("places unconnected people as their own roots and still covers them", () => {
    const tree = buildFullTree(
      [person("a"), person("b"), person("c")],
      parentsOf({ c: ["b"] }),
    );
    expect(tree.graph.nodes).toHaveLength(3);
    expect(tree.graph.edges).toHaveLength(1);
    const roots = tree.graph.nodes
      .filter((node) => node.generation === 0)
      .map((node) => node.occurrenceKey)
      .sort();
    expect(roots).toEqual(["a", "b"]);
  });

  it("keeps both parents of a child on one generation", () => {
    // The father has parents of his own, the mother does not, and the mother
    // owns the child's placement band (smaller id). Both must still share a
    // level, with the child one level below them.
    const tree = buildFullTree(
      [
        person("grandpa", "MALE"),
        person("grandma", "FEMALE"),
        person("anna", "FEMALE"),
        person("boris", "MALE"),
        person("kid"),
      ],
      parentsOf({
        boris: ["grandpa", "grandma"],
        kid: ["anna", "boris"],
      }),
    );
    const generation = (id: string) =>
      tree.graph.nodes.find((node) => node.occurrenceKey === id)?.generation;
    expect(generation("grandpa")).toBe(0);
    expect(generation("grandma")).toBe(0);
    expect(generation("anna")).toBe(1);
    expect(generation("boris")).toBe(1);
    expect(generation("kid")).toBe(2);
    // Alignment does not move the placement edge to the second parent.
    expect(tree.graph.edges).toHaveLength(2);
    expect(
      tree.graph.edges.find((edge) => edge.childKey === "kid")?.parentKey,
    ).toBe("anna");
    expect(
      tree.extraEdges.map((edge) => `${edge.parentKey}>${edge.childKey}`).sort(),
    ).toEqual(["boris>kid", "grandpa>boris"]);
  });

  it("lays the aligned parents out on one row with the child below", () => {
    const tree = buildFullTree(
      [
        person("grandpa", "MALE"),
        person("grandma", "FEMALE"),
        person("anna", "FEMALE"),
        person("boris", "MALE"),
        person("kid"),
      ],
      parentsOf({
        boris: ["grandpa", "grandma"],
        kid: ["anna", "boris"],
      }),
    );
    const layout = layoutDescendants(tree.graph, {
      extraEdges: tree.extraEdges,
    });
    const y = (id: string) =>
      layout.nodes.find((node) => node.personId === id)?.y ?? -1;
    expect(y("anna")).toBe(y("boris"));
    expect(y("kid")).toBeGreaterThan(y("anna"));
  });

  it("still places a single-parent child below that parent", () => {
    const tree = buildFullTree(
      [person("parent"), person("child")],
      parentsOf({ child: ["parent"] }),
    );
    const generation = (id: string) =>
      tree.graph.nodes.find((node) => node.occurrenceKey === id)?.generation;
    expect(generation("parent")).toBe(0);
    expect(generation("child")).toBe(1);
  });

  it("gives every card a level when co-parents form a cycle", () => {
    // a is a parent of the child, b is a parent of a and of the child: a and b
    // are one co-parent unit, so the cycle collapses and the child stays below.
    const tree = buildFullTree(
      [person("a"), person("b"), person("child")],
      parentsOf({ a: ["b"], child: ["a", "b"] }),
    );
    const generation = (id: string) =>
      tree.graph.nodes.find((node) => node.occurrenceKey === id)?.generation;
    expect(tree.graph.nodes).toHaveLength(3);
    expect(generation("a")).toBe(generation("b"));
    expect(generation("child")).toBe((generation("a") ?? 0) + 1);
  });

  it("keeps a plain two-person cycle deterministic and fully covered", () => {
    const parents = parentsOf({ a: ["b"], b: ["a"] });
    const tree = buildFullTree([person("a"), person("b")], parents);
    expect(tree.graph.nodes).toHaveLength(2);
    for (const node of tree.graph.nodes) {
      expect(Number.isInteger(node.generation)).toBe(true);
      expect(node.generation).toBeGreaterThanOrEqual(0);
    }
    expect(buildFullTree([person("a"), person("b")], parents)).toEqual(tree);
  });

  it("is deterministic for equal input", () => {
    const persons = [person("a"), person("b"), person("c")];
    const parents = parentsOf({ b: ["a"], c: ["a"] });
    expect(buildFullTree(persons, parents)).toEqual(
      buildFullTree(persons, parents),
    );
  });
});

describe("buildBloodTree", () => {
  const persons = [
    person("grandpa", "MALE"),
    person("grandma", "FEMALE"),
    person("father", "MALE"),
    person("mother", "FEMALE"),
    person("root", "MALE"),
    person("sister", "FEMALE"),
    person("halfBrother", "MALE"),
    person("stepMother", "FEMALE"),
    person("aunt", "FEMALE"),
    person("cousin", "MALE"),
    person("wife", "FEMALE"),
    person("child", "MALE"),
    person("stepchild"),
    person("adopted"),
  ];
  const parents = parentsOf({
    father: ["grandpa", "grandma"],
    aunt: ["grandpa", "grandma"],
    root: ["father", "mother"],
    sister: ["father", "mother"],
    halfBrother: ["father", "stepMother"],
    cousin: ["aunt"],
    child: ["root", "wife"],
    stepchild: ["wife"],
  });
  const withAdoptive: ParentEdges = new Map([
    ...parents,
    ["adopted", [{ parentId: "root", adoptive: true }]],
  ]);

  it("keeps every person connected by blood and drops spouses and adoptees", () => {
    const tree = buildBloodTree(persons, withAdoptive, "root");
    const ids = tree.graph.nodes.map((node) => node.occurrenceKey).sort();
    expect(ids).toEqual([
      "aunt",
      "child",
      "cousin",
      "father",
      "grandma",
      "grandpa",
      "halfBrother",
      "mother",
      "root",
      "sister",
    ]);
    expect(ids).not.toContain("wife");
    expect(ids).not.toContain("stepMother");
    expect(ids).not.toContain("stepchild");
    expect(ids).not.toContain("adopted");
    expect(tree.graph.rootPersonId).toBe("root");
  });

  it("places the selected root in the middle of its blood component", () => {
    const tree = buildBloodTree(persons, parents, "root");
    const generation = (id: string) =>
      tree.graph.nodes.find((node) => node.occurrenceKey === id)?.generation;
    expect(generation("grandpa")).toBe(0);
    expect(generation("father")).toBe(1);
    expect(generation("root")).toBe(2);
    expect(generation("sister")).toBe(2);
    expect(generation("aunt")).toBe(1);
    expect(generation("cousin")).toBe(2);
    expect(
      tree.graph.nodes.find((node) => node.occurrenceKey === "root")?.role,
    ).toBe("ROOT");
  });

  it("keeps the root's mother and father on one generation", () => {
    const tree = buildBloodTree(
      [
        person("grandpa", "MALE"),
        person("grandma", "FEMALE"),
        person("anna", "FEMALE"),
        person("boris", "MALE"),
        person("kid"),
      ],
      parentsOf({ boris: ["grandpa", "grandma"], kid: ["anna", "boris"] }),
      "kid",
    );
    const generation = (id: string) =>
      tree.graph.nodes.find((node) => node.occurrenceKey === id)?.generation;
    expect(generation("anna")).toBe(generation("boris"));
    expect(generation("boris")).toBe(1);
    expect(generation("kid")).toBe(2);
  });

  it("returns a single card when the root has no blood links", () => {
    const tree = buildBloodTree(
      [person("root"), person("wife")],
      parentsOf({}),
      "root",
    );
    expect(tree.graph.nodes.map((node) => node.occurrenceKey)).toEqual([
      "root",
    ]);
    expect(tree.graph.edges).toEqual([]);
  });

  it("is deterministic for equal input", () => {
    expect(buildBloodTree(persons, parents, "root")).toEqual(
      buildBloodTree(persons, parents, "root"),
    );
  });
});

describe("blood tree with spouses", () => {
  it("adds spouses without changing blood membership or generations", () => {
    const persons = [
      person("grandpa", "MALE"),
      person("grandma", "FEMALE"),
      person("root", "MALE"),
      person("sister", "FEMALE"),
      person("wife", "FEMALE"),
      person("child", "MALE"),
    ];
    const parents = parentsOf({
      root: ["grandpa", "grandma"],
      sister: ["grandpa", "grandma"],
      child: ["root", "wife"],
    });
    const tree = buildBloodTree(persons, parents, "root");
    const before = new Map(
      tree.graph.nodes.map((node) => [node.occurrenceKey, node.generation]),
    );
    const index: SpouseIndex = {
      partnersOf: new Map([["root", ["wife"]]]),
      pairs: new Set(["root|wife"]),
    };
    const lookup = new Map(persons.map((item) => [item.id, item]));
    const view = decorateDescendantGraph(tree.graph, lookup, index);

    for (const [key, generation] of before) {
      const stillThere = view.graph.nodes.find(
        (node) => node.occurrenceKey === key,
      );
      expect(stillThere?.generation).toBe(generation);
    }
    const wife = view.graph.nodes.find((node) => node.personId === "wife");
    expect(wife?.generation).toBe(before.get("root"));
    expect(view.spouseOf.get(wife?.occurrenceKey ?? "")).toBe("root");

    const layout = layoutDescendants(view.graph, {
      extraEdges: tree.extraEdges,
      spouseOf: view.spouseOf,
      spousePairs: view.spousePairs,
    });
    expect(
      layout.nodes.filter((node) => node.personId === "child"),
    ).toHaveLength(1);
    expect(
      layout.nodes.filter((node) => node.personId === "wife"),
    ).toHaveLength(1);
  });
});
