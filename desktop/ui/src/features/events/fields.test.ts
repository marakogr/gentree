import { describe, expect, it } from "vitest";
import {
  BUILTIN_EVENT_FIELDS,
  eventDetailEntries,
  resolveEventFields,
  retainDetailsForTypeChange,
  type CustomEventFieldGroup,
} from "./fields";

/** Built-in label stub; real labels come from the `event` i18n namespace. */
const label = (key: string) => `label:${key}`;

const groups: CustomEventFieldGroup[] = [
  {
    type: "EDUCATION",
    fields: [
      { key: "thesis", label: "Thesis" },
      { key: "advisor", label: "Advisor", multiline: true },
    ],
  },
  {
    type: "occupation",
    fields: [{ key: "military_rank", label: "Military rank" }],
  },
  {
    type: "University",
    fields: [{ key: "department", label: "Department" }],
  },
  {
    type: "OTHER",
    fields: [{ key: "source", label: "Source" }],
  },
];

describe("BUILTIN_EVENT_FIELDS", () => {
  it("matches the core registry per event type", () => {
    const keys = (type: keyof typeof BUILTIN_EVENT_FIELDS) =>
      BUILTIN_EVENT_FIELDS[type].map((field) => field.key);

    expect(keys("BIRTH")).toEqual(["birth_certificate", "hospital"]);
    expect(keys("DEATH")).toEqual(["cause", "death_certificate"]);
    expect(keys("MARRIAGE")).toEqual([
      "marriage_certificate",
      "marriage_rite",
      "officiant",
    ]);
    expect(keys("DIVORCE")).toEqual([
      "reason",
      "court",
      "divorce_certificate",
    ]);
    expect(keys("BURIAL")).toEqual([
      "cemetery",
      "grave",
      "burial_rite",
      "burial_officiant",
    ]);
    expect(keys("RESIDENCE")).toEqual(["address"]);
    expect(keys("OCCUPATION")).toEqual(["position", "employer"]);
    expect(keys("EDUCATION")).toEqual([
      "institution",
      "faculty",
      "specialty",
      "qualification",
    ]);
    expect(keys("OTHER")).toEqual([]);
  });
});

describe("resolveEventFields", () => {
  it("puts built-in keys first and configured fields after them", () => {
    const fields = resolveEventFields("EDUCATION", null, groups, label);
    expect(fields.map((field) => field.key)).toEqual([
      "institution",
      "faculty",
      "specialty",
      "qualification",
      "thesis",
      "advisor",
    ]);
    expect(fields[0]).toEqual({
      key: "institution",
      label: "label:institution",
      multiline: false,
      custom: false,
    });
    expect(fields[4]).toEqual({
      key: "thesis",
      label: "Thesis",
      multiline: false,
      custom: true,
    });
    expect(fields[5].multiline).toBe(true);
  });

  it("matches a group type case-insensitively", () => {
    const fields = resolveEventFields("OCCUPATION", null, groups, label);
    expect(fields.map((field) => field.key)).toEqual([
      "position",
      "employer",
      "military_rank",
    ]);
  });

  it("uses the custom type group for OTHER and falls back to OTHER", () => {
    const matched = resolveEventFields("OTHER", "university", groups, label);
    expect(matched.map((field) => field.key)).toEqual(["department"]);
    expect(matched[0].label).toBe("Department");

    const fallback = resolveEventFields("OTHER", "Award", groups, label);
    expect(fallback.map((field) => field.key)).toEqual(["source"]);

    const plain = resolveEventFields("OTHER", null, groups, label);
    expect(plain.map((field) => field.key)).toEqual(["source"]);
  });

  it("returns no fields for OTHER without any matching group", () => {
    expect(resolveEventFields("OTHER", null, [], label)).toEqual([]);
  });

  it("skips duplicate keys without losing registry order", () => {
    const duplicated: CustomEventFieldGroup[] = [
      {
        type: "BIRTH",
        fields: [
          { key: "hospital", label: "Hospital again" },
          { key: "custom", label: "Custom" },
          { key: "custom", label: "Custom again" },
        ],
      },
    ];
    const fields = resolveEventFields("BIRTH", null, duplicated, label);
    expect(fields.map((field) => field.key)).toEqual([
      "birth_certificate",
      "hospital",
      "custom",
    ]);
    expect(fields[1].label).toBe("label:hospital");
  });
});

describe("retainDetailsForTypeChange", () => {
  it("keeps shared and unknown keys and drops old-type-only fields", () => {
    const kept = retainDetailsForTypeChange(
      ["shared", "old_only"],
      ["shared", "new_only"],
      { shared: "A", old_only: "B", legacy_key: "C" },
    );
    expect(kept).toEqual({ shared: "A", legacy_key: "C" });
  });

  it("does not carry a certificate or rite into another event type", () => {
    const kept = retainDetailsForTypeChange(
      BUILTIN_EVENT_FIELDS.BIRTH.map((field) => field.key),
      BUILTIN_EVENT_FIELDS.DEATH.map((field) => field.key),
      { birth_certificate: "A", hospital: "B", legacy_key: "C" },
    );
    expect(kept).toEqual({ legacy_key: "C" });
  });

  it("keeps everything a new type does not describe", () => {
    expect(
      retainDetailsForTypeChange(["address"], [], { address: "A", extra: "B" }),
    ).toEqual({ extra: "B" });
  });
});

describe("eventDetailEntries", () => {
  it("lists known fields in registry order and raw keys last", () => {
    const entries = eventDetailEntries(
      {
        type: "EDUCATION",
        originalType: null,
        details: {
          thesis: "On local history",
          faculty: "History",
          legacy_note: "Kept",
          institution: "  State University  ",
          specialty: "   ",
        },
      },
      groups,
      label,
    );
    expect(entries).toEqual([
      { key: "institution", label: "label:institution", value: "State University" },
      { key: "faculty", label: "label:faculty", value: "History" },
      { key: "thesis", label: "Thesis", value: "On local history" },
      { key: "legacy_note", label: "legacy_note", value: "Kept" },
    ]);
  });

  it("returns nothing for an event without details", () => {
    expect(
      eventDetailEntries({ type: "BIRTH", originalType: null }, groups, label),
    ).toEqual([]);
  });
});
