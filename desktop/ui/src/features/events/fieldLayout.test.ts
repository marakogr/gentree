import { describe, expect, it } from "vitest";
import type { ResolvedEventField } from "./fields";
import { layoutEventFields } from "./fieldLayout";

function field(
  key: string,
  options: { multiline?: boolean; custom?: boolean } = {},
): ResolvedEventField {
  return {
    key,
    label: `label:${key}`,
    multiline: options.multiline ?? false,
    custom: options.custom ?? false,
  };
}

const spans = (type: Parameters<typeof layoutEventFields>[0], keys: string[]) =>
  layoutEventFields(type, keys.map((key) => field(key))).map((cell) => [
    cell.key,
    cell.span,
  ]);

describe("layoutEventFields", () => {
  it("lays out birth and death facts in two columns", () => {
    expect(spans("BIRTH", ["birth_certificate", "hospital"])).toEqual([
      ["birth_certificate", 1],
      ["hospital", 1],
    ]);
    expect(spans("DEATH", ["cause", "death_certificate"])).toEqual([
      ["cause", 1],
      ["death_certificate", 1],
    ]);
  });

  it("puts the marriage officiant on its own row when no act record exists", () => {
    expect(
      spans("MARRIAGE", [
        "marriage_certificate",
        "marriage_rite",
        "officiant",
      ]),
    ).toEqual([
      ["marriage_certificate", 1],
      ["marriage_rite", 1],
      ["officiant", 2],
    ]);
  });

  it("pairs the officiant with a configured act record", () => {
    expect(
      spans("MARRIAGE", [
        "marriage_certificate",
        "marriage_rite",
        "officiant",
        "act_record",
      ]),
    ).toEqual([
      ["marriage_certificate", 1],
      ["marriage_rite", 1],
      ["officiant", 1],
      ["act_record", 1],
    ]);
  });

  it("reads divorce as certificate | court and a full-width reason", () => {
    expect(
      spans("DIVORCE", ["reason", "court", "divorce_certificate"]),
    ).toEqual([
      ["divorce_certificate", 1],
      ["court", 1],
      ["reason", 2],
    ]);
  });

  it("lays out burial as a 2x2 grid", () => {
    expect(
      spans("BURIAL", [
        "cemetery",
        "grave",
        "burial_rite",
        "burial_officiant",
      ]),
    ).toEqual([
      ["cemetery", 1],
      ["grave", 1],
      ["burial_rite", 1],
      ["burial_officiant", 1],
    ]);
  });

  it("gives the residence address and multiline custom fields a full row", () => {
    expect(spans("RESIDENCE", ["address"])).toEqual([["address", 2]]);
    expect(
      layoutEventFields("EDUCATION", [
        field("institution"),
        field("faculty"),
        field("thesis", { multiline: true }),
      ]).map((cell) => [cell.key, cell.span]),
    ).toEqual([
      ["institution", 1],
      ["faculty", 1],
      ["thesis", 2],
    ]);
  });

  it("keeps configured fields after built-ins and never drops an unknown key", () => {
    expect(
      spans("OCCUPATION", ["position", "employer", "military_rank"]),
    ).toEqual([
      ["position", 1],
      ["employer", 1],
      ["military_rank", 1],
    ]);
  });

  it("pairs custom fields of a custom type", () => {
    expect(spans("OTHER", ["source", "award"])).toEqual([
      ["source", 1],
      ["award", 1],
    ]);
  });
});
