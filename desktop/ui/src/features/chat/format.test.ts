import { describe, expect, it } from "vitest";
import { durationParts, isLocalProviderUrl } from "./format";

describe("durationParts", () => {
  it("keeps sub-second timings in milliseconds", () => {
    expect(durationParts(0, "ru")).toEqual({ unit: "ms", value: "0" });
    expect(durationParts(12, "en")).toEqual({ unit: "ms", value: "12" });
    expect(durationParts(999, "ru")).toEqual({ unit: "ms", value: "999" });
  });

  it("switches to seconds from one second and trims a trailing zero", () => {
    expect(durationParts(1000, "en")).toEqual({ unit: "s", value: "1" });
    expect(durationParts(1500, "en")).toEqual({ unit: "s", value: "1.5" });
    expect(durationParts(12000, "en")).toEqual({ unit: "s", value: "12" });
  });

  it("uses the locale decimal separator", () => {
    expect(durationParts(1240, "ru")).toEqual({ unit: "s", value: "1,2" });
    expect(durationParts(1240, "en")).toEqual({ unit: "s", value: "1.2" });
  });

  it("never renders negative or non-finite durations", () => {
    expect(durationParts(-5, "ru")).toEqual({ unit: "ms", value: "0" });
    expect(durationParts(Number.NaN, "ru")).toEqual({ unit: "ms", value: "0" });
  });
});

describe("isLocalProviderUrl", () => {
  it("accepts loopback hosts with any scheme, port or path", () => {
    expect(isLocalProviderUrl("http://localhost:11434/v1")).toBe(true);
    expect(isLocalProviderUrl("https://127.0.0.1:8443/v1")).toBe(true);
    expect(isLocalProviderUrl("http://[::1]:11434")).toBe(true);
    expect(isLocalProviderUrl("localhost:11434")).toBe(true);
    expect(isLocalProviderUrl("http://ollama.localhost")).toBe(true);
  });

  it("treats public and LAN endpoints as external", () => {
    expect(isLocalProviderUrl("https://api.openai.com/v1")).toBe(false);
    expect(isLocalProviderUrl("http://192.168.1.10:11434")).toBe(false);
    expect(isLocalProviderUrl("https://api.example.com")).toBe(false);
  });

  it("is conservative for empty or malformed values", () => {
    expect(isLocalProviderUrl("")).toBe(false);
    expect(isLocalProviderUrl("   ")).toBe(false);
    expect(isLocalProviderUrl("not a url")).toBe(false);
  });
});
