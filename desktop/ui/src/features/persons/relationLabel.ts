// Direction-aware labels for a relationship row on a person's card. The label
// describes the *other* person, so the same edge reads "father" on the child's
// card and "son" on the parent's card. Gender comes from the stored person;
// nothing is inferred from a name.

import type {
  Gender,
  RelationshipEntity,
  RelationshipType,
} from "../../api/types";

/** Who the related person is to the open person. */
export type RelatedRole = "parent" | "child" | "spouse" | "partner";

type DirectionalType = "PARENT_CHILD" | "ADOPTIVE_PARENT_CHILD";
type GenderTerms = Record<Gender, string>;

const BLOOD_TERMS: Record<
  DirectionalType,
  Record<"parent" | "child", GenderTerms>
> = {
  PARENT_CHILD: {
    parent: { MALE: "father", FEMALE: "mother", UNKNOWN: "parent" },
    child: { MALE: "son", FEMALE: "daughter", UNKNOWN: "child" },
  },
  ADOPTIVE_PARENT_CHILD: {
    parent: {
      MALE: "adoptiveFather",
      FEMALE: "adoptiveMother",
      UNKNOWN: "adoptiveParent",
    },
    child: {
      MALE: "adoptedSon",
      FEMALE: "adoptedDaughter",
      UNKNOWN: "adoptedChild",
    },
  },
};

const SPOUSE_TERMS: GenderTerms = {
  MALE: "husband",
  FEMALE: "wife",
  UNKNOWN: "spouse",
};

/**
 * Which end of `row` the open person is on. `PARENT_CHILD` stores the parent as
 * `personId`, so the related person is a child when the open person is the
 * source and a parent otherwise. Any row that does not mention the open person
 * is treated as "child", the previous default.
 */
export function relationDirection(
  row: Pick<RelationshipEntity, "type" | "personId" | "relatedPersonId">,
  personId: string,
): RelatedRole {
  if (row.type === "SPOUSE") return "spouse";
  if (row.type === "PARTNER") return "partner";
  return row.relatedPersonId === personId ? "parent" : "child";
}

/** i18n key (`relationship:relation.*`) for the related person's label. */
export function relationLabelKey(
  type: RelationshipType,
  role: RelatedRole,
  gender: Gender,
): string {
  if (role === "partner") return "relationship:relation.partner";
  if (role === "spouse") return `relationship:relation.${SPOUSE_TERMS[gender]}`;
  const terms = BLOOD_TERMS[
    type === "ADOPTIVE_PARENT_CHILD" ? "ADOPTIVE_PARENT_CHILD" : "PARENT_CHILD"
  ];
  return `relationship:relation.${terms[role][gender]}`;
}
