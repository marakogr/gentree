import { describe, expect, it } from "vitest";
import type { RelationshipEntity } from "../../api/types";
import { relationDirection, relationLabelKey } from "./relationLabel";

type Row = Pick<RelationshipEntity, "type" | "personId" | "relatedPersonId">;

function row(type: Row["type"], personId: string, relatedPersonId: string): Row {
  return { type, personId, relatedPersonId };
}

describe("relationDirection", () => {
  it("calls the related person a child when the open person is the parent", () => {
    expect(relationDirection(row("PARENT_CHILD", "me", "other"), "me")).toBe(
      "child",
    );
  });

  it("calls the related person a parent when the open person is the child", () => {
    expect(relationDirection(row("PARENT_CHILD", "other", "me"), "me")).toBe(
      "parent",
    );
  });

  it("keeps the same direction for an adoptive parent link", () => {
    expect(
      relationDirection(row("ADOPTIVE_PARENT_CHILD", "me", "other"), "me"),
    ).toBe("child");
    expect(
      relationDirection(row("ADOPTIVE_PARENT_CHILD", "other", "me"), "me"),
    ).toBe("parent");
  });

  it("labels a spouse or partner edge in both directions", () => {
    expect(relationDirection(row("SPOUSE", "me", "other"), "me")).toBe("spouse");
    expect(relationDirection(row("SPOUSE", "other", "me"), "me")).toBe("spouse");
    expect(relationDirection(row("PARTNER", "me", "other"), "me")).toBe(
      "partner",
    );
  });
});

describe("relationLabelKey", () => {
  it("uses the parent label of the related person's gender", () => {
    expect(relationLabelKey("PARENT_CHILD", "parent", "MALE")).toBe(
      "relationship:relation.father",
    );
    expect(relationLabelKey("PARENT_CHILD", "parent", "FEMALE")).toBe(
      "relationship:relation.mother",
    );
    expect(relationLabelKey("PARENT_CHILD", "parent", "UNKNOWN")).toBe(
      "relationship:relation.parent",
    );
  });

  it("uses the child label of the related person's gender", () => {
    expect(relationLabelKey("PARENT_CHILD", "child", "MALE")).toBe(
      "relationship:relation.son",
    );
    expect(relationLabelKey("PARENT_CHILD", "child", "FEMALE")).toBe(
      "relationship:relation.daughter",
    );
    expect(relationLabelKey("PARENT_CHILD", "child", "UNKNOWN")).toBe(
      "relationship:relation.child",
    );
  });

  it("keeps the adoption visible in both directions", () => {
    expect(relationLabelKey("ADOPTIVE_PARENT_CHILD", "parent", "MALE")).toBe(
      "relationship:relation.adoptiveFather",
    );
    expect(relationLabelKey("ADOPTIVE_PARENT_CHILD", "parent", "FEMALE")).toBe(
      "relationship:relation.adoptiveMother",
    );
    expect(relationLabelKey("ADOPTIVE_PARENT_CHILD", "child", "FEMALE")).toBe(
      "relationship:relation.adoptedDaughter",
    );
    expect(relationLabelKey("ADOPTIVE_PARENT_CHILD", "child", "UNKNOWN")).toBe(
      "relationship:relation.adoptedChild",
    );
  });

  it("uses the spouse label of the related person's gender", () => {
    expect(relationLabelKey("SPOUSE", "spouse", "MALE")).toBe(
      "relationship:relation.husband",
    );
    expect(relationLabelKey("SPOUSE", "spouse", "FEMALE")).toBe(
      "relationship:relation.wife",
    );
    expect(relationLabelKey("SPOUSE", "spouse", "UNKNOWN")).toBe(
      "relationship:relation.spouse",
    );
  });

  it("keeps a partner edge gender-neutral", () => {
    expect(relationLabelKey("PARTNER", "partner", "MALE")).toBe(
      "relationship:relation.partner",
    );
    expect(relationLabelKey("PARTNER", "partner", "UNKNOWN")).toBe(
      "relationship:relation.partner",
    );
  });

  it("distinguishes the two directions on the same edge", () => {
    const edge = row("PARENT_CHILD", "parent-1", "child-1");
    expect(
      relationLabelKey(
        edge.type,
        relationDirection(edge, "child-1"),
        "MALE",
      ),
    ).toBe("relationship:relation.father");
    expect(
      relationLabelKey(edge.type, relationDirection(edge, "parent-1"), "MALE"),
    ).toBe("relationship:relation.son");
  });
});
