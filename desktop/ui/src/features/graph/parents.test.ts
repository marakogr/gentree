import { describe, expect, it } from "vitest";
import type { RelationshipEntity, RelationshipType, Versioned } from "../../api/types";
import { parentEdgesFromRelationships } from "./parents";

let nextId = 0;

function edge(
  parent: string,
  child: string,
  type: RelationshipType = "PARENT_CHILD",
): Versioned<RelationshipEntity> {
  nextId += 1;
  return {
    version: `v${nextId}`,
    entity: {
      id: `r${nextId}`,
      type,
      personId: parent,
      relatedPersonId: child,
      notes: null,
    },
  };
}

describe("parentEdgesFromRelationships", () => {
  it("builds child -> parents without duplicates", () => {
    const rows = [
      edge("father", "child"),
      edge("mother", "child"),
      edge("father", "sibling"),
      edge("father", "child", "ADOPTIVE_PARENT_CHILD"), // duplicate parent, ignored
    ];

    const parents = parentEdgesFromRelationships(rows);
    expect(parents.get("child")).toEqual([
      { parentId: "father", adoptive: false },
      { parentId: "mother", adoptive: false },
    ]);
    expect(parents.get("sibling")).toEqual([
      { parentId: "father", adoptive: false },
    ]);
  });

  it("keeps the adoptive flag and ignores unrelated relationship types", () => {
    const parents = parentEdgesFromRelationships([
      edge("father", "child", "ADOPTIVE_PARENT_CHILD"),
      edge("partner", "child", "SPOUSE"),
    ]);
    expect(parents.get("child")).toEqual([
      { parentId: "father", adoptive: true },
    ]);
  });
});
