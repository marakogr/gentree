import { describe, expect, it } from "vitest";
import type { ParentEdges } from "./parents";
import { buildBloodTree, buildFullTree } from "./forest";

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
