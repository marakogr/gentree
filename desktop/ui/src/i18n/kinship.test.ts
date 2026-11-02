import { describe, expect, it } from "vitest";
import type {
  Gender,
  KinshipDescriptor,
  KinshipEdge,
  KinshipEdgeKind,
  KinshipKind,
} from "../api/types";
import { describeChain, formatKinship } from "./kinship";

function descriptor(
  kind: KinshipKind,
  gender: Gender = "MALE",
  patch: Partial<KinshipDescriptor> = {},
): KinshipDescriptor {
  return {
    kind,
    gender,
    line: null,
    degree: 0,
    removed: 0,
    generationDelta: 0,
    viaSpouseGender: null,
    path: [],
    ...patch,
  };
}

/** Edges of a chain: `genders[i]` belongs to `p[i]`, `kinds[i]` links i → i+1. */
function chain(genders: Gender[], kinds: KinshipEdgeKind[]): KinshipEdge[] {
  return kinds.map((kind, index) => ({
    from: `p${index}`,
    to: `p${index + 1}`,
    kind,
    fromGender: genders[index],
    toGender: genders[index + 1],
    adoptive: false,
  }));
}

describe("formatKinship ru — property (свойство)", () => {
  it("distinguishes parents-in-law by the spouse gender", () => {
    // Жена → её отец/мать: тесть/тёща.
    expect(
      formatKinship(
        descriptor("PARENT_IN_LAW", "MALE", { viaSpouseGender: "FEMALE" }),
        "ru",
      ),
    ).toBe("тесть");
    expect(
      formatKinship(
        descriptor("PARENT_IN_LAW", "FEMALE", { viaSpouseGender: "FEMALE" }),
        "ru",
      ),
    ).toBe("тёща");
    // Муж → его отец/мать: свёкор/свекровь.
    expect(
      formatKinship(
        descriptor("PARENT_IN_LAW", "MALE", { viaSpouseGender: "MALE" }),
        "ru",
      ),
    ).toBe("свёкор");
    expect(
      formatKinship(
        descriptor("PARENT_IN_LAW", "FEMALE", { viaSpouseGender: "MALE" }),
        "ru",
      ),
    ).toBe("свекровь");
  });

  it("names siblings of the spouse by the spouse gender", () => {
    expect(
      formatKinship(
        descriptor("SIBLING_OF_SPOUSE", "MALE", { viaSpouseGender: "FEMALE" }),
        "ru",
      ),
    ).toBe("шурин");
    expect(
      formatKinship(
        descriptor("SIBLING_OF_SPOUSE", "FEMALE", { viaSpouseGender: "FEMALE" }),
        "ru",
      ),
    ).toBe("свояченица");
    expect(
      formatKinship(
        descriptor("SIBLING_OF_SPOUSE", "MALE", { viaSpouseGender: "MALE" }),
        "ru",
      ),
    ).toBe("деверь");
    expect(
      formatKinship(
        descriptor("SIBLING_OF_SPOUSE", "FEMALE", { viaSpouseGender: "MALE" }),
        "ru",
      ),
    ).toBe("золовка");
  });

  it("names spouses of siblings: сестра → зять, брат → невестка", () => {
    expect(
      formatKinship(
        descriptor("SPOUSE_OF_SIBLING", "MALE", { viaSpouseGender: "FEMALE" }),
        "ru",
      ),
    ).toBe("зять");
    expect(
      formatKinship(
        descriptor("SPOUSE_OF_SIBLING", "FEMALE", { viaSpouseGender: "MALE" }),
        "ru",
      ),
    ).toBe("невестка");
  });

  it("keeps the legacy SIBLING_IN_LAW direction table", () => {
    expect(
      formatKinship(
        descriptor("SIBLING_IN_LAW", "MALE", { viaSpouseGender: "MALE" }),
        "ru",
      ),
    ).toBe("деверь");
    expect(
      formatKinship(
        descriptor("SIBLING_IN_LAW", "FEMALE", { viaSpouseGender: "FEMALE" }),
        "ru",
      ),
    ).toBe("свояченица");
  });

  it("names child-in-law, свояк and ятровка", () => {
    expect(
      formatKinship(descriptor("CHILD_IN_LAW", "MALE"), "ru"),
    ).toBe("зять");
    expect(
      formatKinship(descriptor("CHILD_IN_LAW", "FEMALE"), "ru"),
    ).toBe("невестка");
    expect(
      formatKinship(descriptor("SPOUSE_OF_SPOUSES_SIBLING", "MALE"), "ru"),
    ).toBe("свояк");
    expect(
      formatKinship(descriptor("SPOUSE_OF_SPOUSES_SIBLING", "FEMALE"), "ru"),
    ).toBe("ятровка");
  });
});

describe("formatKinship ru — step and distant kin", () => {
  it("names step relations", () => {
    expect(formatKinship(descriptor("STEP_PARENT", "MALE"), "ru")).toBe("отчим");
    expect(formatKinship(descriptor("STEP_PARENT", "FEMALE"), "ru")).toBe(
      "мачеха",
    );
    expect(formatKinship(descriptor("STEP_CHILD", "MALE"), "ru")).toBe("пасынок");
    expect(formatKinship(descriptor("STEP_CHILD", "FEMALE"), "ru")).toBe(
      "падчерица",
    );
    expect(formatKinship(descriptor("STEP_SIBLING", "MALE"), "ru")).toBe(
      "сводный брат",
    );
    expect(formatKinship(descriptor("STEP_SIBLING", "FEMALE"), "ru")).toBe(
      "сводная сестра",
    );
  });

  it("names cousins by degree and gender", () => {
    expect(
      formatKinship(descriptor("COUSIN", "MALE", { degree: 1 }), "ru"),
    ).toBe("двоюродный брат");
    expect(
      formatKinship(descriptor("COUSIN", "FEMALE", { degree: 1 }), "ru"),
    ).toBe("двоюродная сестра");
    expect(
      formatKinship(descriptor("COUSIN", "MALE", { degree: 2 }), "ru"),
    ).toBe("троюродный брат");
    expect(
      formatKinship(
        descriptor("COUSIN", "MALE", {
          degree: 2,
          removed: 1,
          generationDelta: 1,
        }),
        "ru",
      ),
    ).toBe("троюродный племянник");
  });

  it("names great-uncles and grand-nephews", () => {
    expect(formatKinship(descriptor("GREAT_UNCLE", "MALE"), "ru")).toBe(
      "двоюродный дед",
    );
    expect(formatKinship(descriptor("GREAT_AUNT", "FEMALE"), "ru")).toBe(
      "двоюродная бабка",
    );
    expect(formatKinship(descriptor("GRAND_NEPHEW", "MALE"), "ru")).toBe(
      "внучатый племянник",
    );
    expect(formatKinship(descriptor("GRAND_NIECE", "FEMALE"), "ru")).toBe(
      "внучатая племянница",
    );
  });

  it("repeats the пра- prefix by generationDelta", () => {
    expect(
      formatKinship(
        descriptor("GREAT_GRANDPARENT", "MALE", { generationDelta: 3 }),
        "ru",
      ),
    ).toBe("прадед");
    expect(
      formatKinship(
        descriptor("GREAT_GRANDPARENT", "MALE", { generationDelta: 4 }),
        "ru",
      ),
    ).toBe("прапрадед");
    expect(
      formatKinship(
        descriptor("GREAT_GRANDPARENT", "FEMALE", { generationDelta: 3 }),
        "ru",
      ),
    ).toBe("прабабка");
    expect(
      formatKinship(
        descriptor("GREAT_GRANDPARENT", "FEMALE", { generationDelta: 4 }),
        "ru",
      ),
    ).toBe("прапрабабка");
    expect(
      formatKinship(
        descriptor("GREAT_GRANDCHILD", "MALE", { generationDelta: -3 }),
        "ru",
      ),
    ).toBe("правнук");
    expect(
      formatKinship(
        descriptor("GREAT_GRANDCHILD", "FEMALE", { generationDelta: -4 }),
        "ru",
      ),
    ).toBe("праправнучка");
  });

  it("adds the parent line to uncle and aunt", () => {
    expect(
      formatKinship(
        descriptor("UNCLE", "MALE", { line: "PATERNAL" }),
        "ru",
      ),
    ).toBe("дядя по отцу");
    expect(
      formatKinship(
        descriptor("UNCLE", "MALE", { line: "MATERNAL" }),
        "ru",
      ),
    ).toBe("дядя по матери");
    expect(
      formatKinship(
        descriptor("AUNT", "FEMALE", { line: "MATERNAL" }),
        "ru",
      ),
    ).toBe("тётя по матери");
    expect(
      formatKinship(descriptor("AUNT", "FEMALE", { line: "PATERNAL" }), "ru"),
    ).toBe("тётя по отцу");
  });

  it("inverts the direction: тёща ↔ зять, дядя ↔ племянник", () => {
    const motherInLaw = formatKinship(
      descriptor("PARENT_IN_LAW", "FEMALE", { viaSpouseGender: "FEMALE" }),
      "ru",
    );
    const sonInLaw = formatKinship(
      descriptor("CHILD_IN_LAW", "MALE"),
      "ru",
    );
    expect([motherInLaw, sonInLaw]).toEqual(["тёща", "зять"]);

    const uncle = formatKinship(
      descriptor("UNCLE", "MALE", { line: "PATERNAL" }),
      "ru",
    );
    const nephew = formatKinship(descriptor("NEPHEW", "MALE"), "ru");
    expect([uncle, nephew]).toEqual(["дядя по отцу", "племянник"]);
  });
});

describe("describeChain ru", () => {
  it("describes a cousin's husband", () => {
    const edges = chain(
      ["MALE", "MALE", "MALE", "MALE", "FEMALE", "MALE"],
      ["PARENT", "PARENT", "CHILD", "CHILD", "SPOUSE"],
    );
    expect(describeChain(edges, "ru")).toBe("муж двоюродной сестры");
  });

  it("describes a wife's father", () => {
    const edges = chain(["MALE", "FEMALE", "MALE"], ["SPOUSE", "PARENT"]);
    expect(describeChain(edges, "ru")).toBe("отец жены");
  });

  it("describes a brother's daughter", () => {
    const edges = chain(
      ["MALE", "MALE", "MALE", "FEMALE"],
      ["PARENT", "CHILD", "CHILD"],
    );
    expect(describeChain(edges, "ru")).toBe("дочь брата");
  });

  it("never returns an empty string", () => {
    expect(describeChain([], "ru")).toBe("родственник");
    expect(
      describeChain(chain(["UNKNOWN", "UNKNOWN"], ["PARENT"]), "ru"),
    ).not.toBe("");
  });
});

describe("formatKinship UNKNOWN fallback", () => {
  it("uses the descriptive chain when edges are present", () => {
    const edges = chain(["MALE", "FEMALE", "MALE"], ["SPOUSE", "PARENT"]);
    expect(
      formatKinship(descriptor("UNKNOWN", "MALE", { edges }), "ru"),
    ).toBe("отец жены");
    expect(
      formatKinship(descriptor("UNKNOWN", "MALE", { edges }), "ru"),
    ).not.toBe("родственник");
  });

  it("keeps the id path fallback when there are no edges", () => {
    expect(formatKinship(descriptor("UNKNOWN", "MALE"), "ru")).toBe(
      "родственник",
    );
    expect(
      formatKinship(descriptor("UNKNOWN", "MALE", { path: ["a", "b"] }), "ru"),
    ).toBe("родственник (путь: a → b)");
    expect(
      formatKinship(
        descriptor("UNKNOWN", "MALE", { path: ["a", "b"] }),
        "ru",
        (id) => (id === "a" ? "Анна" : "Борис"),
      ),
    ).toBe("родственник (путь: Анна → Борис)");
  });
});

describe("formatKinship en", () => {
  it("names core, in-law and step terms", () => {
    expect(formatKinship(descriptor("FATHER"), "en")).toBe("father");
    expect(formatKinship(descriptor("MOTHER", "FEMALE"), "en")).toBe("mother");
    expect(
      formatKinship(
        descriptor("PARENT_IN_LAW", "FEMALE", { viaSpouseGender: "FEMALE" }),
        "en",
      ),
    ).toBe("mother-in-law");
    expect(
      formatKinship(descriptor("CHILD_IN_LAW", "MALE"), "en"),
    ).toBe("son-in-law");
    expect(formatKinship(descriptor("STEP_PARENT", "FEMALE"), "en")).toBe(
      "stepmother",
    );
  });

  it("names cousins by degree and removed", () => {
    expect(
      formatKinship(descriptor("COUSIN", "MALE", { degree: 1 }), "en"),
    ).toBe("first cousin");
    expect(
      formatKinship(
        descriptor("COUSIN", "FEMALE", {
          degree: 2,
          removed: 1,
          generationDelta: -1,
        }),
        "en",
      ),
    ).toBe("second cousin once removed");
    expect(
      formatKinship(descriptor("COUSIN", "MALE", { degree: 1, removed: 3 }), "en"),
    ).toBe("distant cousin");
  });

  it("repeats the great- prefix and the parent line", () => {
    expect(
      formatKinship(
        descriptor("GREAT_GRANDPARENT", "MALE", { generationDelta: 3 }),
        "en",
      ),
    ).toBe("great-grandfather");
    expect(
      formatKinship(
        descriptor("GREAT_GRANDPARENT", "MALE", { generationDelta: 4 }),
        "en",
      ),
    ).toBe("great-great-grandfather");
    expect(
      formatKinship(
        descriptor("UNCLE", "MALE", { line: "MATERNAL" }),
        "en",
      ),
    ).toBe("uncle on the mother's side");
  });

  it("describes chains with possessives", () => {
    const edges = chain(
      ["MALE", "MALE", "MALE", "MALE", "FEMALE", "MALE"],
      ["PARENT", "PARENT", "CHILD", "CHILD", "SPOUSE"],
    );
    expect(describeChain(edges, "en")).toBe("first cousin's husband");
    expect(formatKinship(descriptor("UNKNOWN"), "en")).toBe("relative");
  });
});
