import { describe, expect, it } from "vitest";
import { cardHoverLabel } from "./hover";

const UNKNOWN = "Kinship unknown";

function label(
  input: Partial<Parameters<typeof cardHoverLabel>[0]> = {},
): string {
  return cardHoverLabel({
    hasRoot: true,
    isRoot: false,
    kinshipLabel: null,
    unknownLabel: UNKNOWN,
    ...input,
  });
}

describe("cardHoverLabel", () => {
  it("shows only the kinship to the root", () => {
    expect(label({ kinshipLabel: "grandson" })).toBe("grandson");
    expect(label({ kinshipLabel: "cousin sister" })).toBe("cousin sister");
  });

  it("never joins a second fragment with a separator", () => {
    const text = label({ kinshipLabel: "niece" });
    expect(text).not.toContain("·");
    expect(text).not.toContain(",");
    expect(text.split(" ")).toHaveLength(1);
  });

  it("stays empty for the root", () => {
    expect(label({ isRoot: true, kinshipLabel: "grandson" })).toBe("");
  });

  it("stays empty without a root", () => {
    expect(label({ hasRoot: false, kinshipLabel: "grandson" })).toBe("");
    expect(label({ hasRoot: false })).toBe("");
  });

  it("uses the neutral value for an unknown kinship", () => {
    expect(label()).toBe(UNKNOWN);
    expect(label({ kinshipLabel: "" })).toBe(UNKNOWN);
  });
});
