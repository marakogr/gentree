import { describe, expect, it } from "vitest";
import {
  COLUMN_WIDTH_MAX,
  COLUMN_WIDTH_MIN,
  columnWidthStyle,
  columnWidthsStorageKey,
  clampColumnWidth,
  readColumnWidths,
  sanitizeColumnWidths,
  withColumnWidth,
  withoutColumn,
  writeColumnWidths,
  type ColumnWidthStorage,
} from "./tableColumns";

/** localStorage stand-in; can simulate a broken getItem/setItem. */
function fakeStorage(initial: Record<string, string> = {}): ColumnWidthStorage & {
  values: Record<string, string>;
  failRead: boolean;
  failWrite: boolean;
} {
  const values = { ...initial };
  const storage = {
    values,
    failRead: false,
    failWrite: false,
    getItem(key: string): string | null {
      if (storage.failRead) throw new Error("blocked");
      return values[key] ?? null;
    },
    setItem(key: string, value: string): void {
      if (storage.failWrite) throw new Error("QuotaExceededError");
      values[key] = value;
    },
  };
  return storage;
}

describe("clampColumnWidth", () => {
  it("keeps widths inside the allowed range", () => {
    expect(clampColumnWidth(COLUMN_WIDTH_MIN)).toBe(COLUMN_WIDTH_MIN);
    expect(clampColumnWidth(COLUMN_WIDTH_MAX)).toBe(COLUMN_WIDTH_MAX);
    expect(clampColumnWidth(320)).toBe(320);
  });

  it("clamps the extremes instead of rejecting them", () => {
    expect(clampColumnWidth(-400)).toBe(COLUMN_WIDTH_MIN);
    expect(clampColumnWidth(0)).toBe(COLUMN_WIDTH_MIN);
    expect(clampColumnWidth(5000)).toBe(COLUMN_WIDTH_MAX);
  });

  it("rounds fractions and survives non-finite input", () => {
    expect(clampColumnWidth(200.4)).toBe(200);
    expect(clampColumnWidth(200.6)).toBe(201);
    expect(clampColumnWidth(Number.NaN)).toBe(COLUMN_WIDTH_MIN);
    expect(clampColumnWidth(Number.POSITIVE_INFINITY)).toBe(COLUMN_WIDTH_MIN);
  });
});

describe("sanitizeColumnWidths", () => {
  it("keeps numeric widths only and clamps them", () => {
    expect(
      sanitizeColumnWidths({ name: 320, years: 10, bad: "wide", skip: null }),
    ).toEqual({ name: 320, years: COLUMN_WIDTH_MIN });
  });

  it("collapses anything that is not a plain object", () => {
    expect(sanitizeColumnWidths(null)).toEqual({});
    expect(sanitizeColumnWidths([320])).toEqual({});
    expect(sanitizeColumnWidths("320")).toEqual({});
    expect(sanitizeColumnWidths({ "": 200 })).toEqual({});
    expect(sanitizeColumnWidths({ name: Number.NaN })).toEqual({});
  });
});

describe("column width maps", () => {
  it("sets one width without touching the others", () => {
    const before = { name: 300 };
    const after = withColumnWidth(before, "years", 5000);
    expect(after).toEqual({ name: 300, years: COLUMN_WIDTH_MAX });
    expect(before).toEqual({ name: 300 });
  });

  it("drops an override so the default width comes back", () => {
    const widths = { name: 300, years: 140 };
    expect(withoutColumn(widths, "name")).toEqual({ years: 140 });
    expect(withoutColumn(widths, "parents")).toBe(widths);
  });

  it("renders an inline style only for stored widths", () => {
    expect(columnWidthStyle({ date: 176 }, "date")).toEqual({
      width: "176px",
    });
    expect(columnWidthStyle({ date: 176 }, "person")).toBeUndefined();
  });
});

describe("column width storage", () => {
  it("namespaces one key per project and screen", () => {
    expect(columnWidthsStorageKey("p1", "persons")).toBe(
      "gentree.columns.v1.p1.persons",
    );
    expect(columnWidthsStorageKey("p1", "events")).not.toBe(
      columnWidthsStorageKey("p1", "persons"),
    );
    expect(columnWidthsStorageKey("p2", "persons")).not.toBe(
      columnWidthsStorageKey("p1", "persons"),
    );
  });

  it("round-trips widths", () => {
    const storage = fakeStorage();
    writeColumnWidths("p1", "persons", { name: 320, actions: 96 }, storage);
    expect(readColumnWidths("p1", "persons", storage)).toEqual({
      name: 320,
      actions: 96,
    });
  });

  it("does not leak widths between screens", () => {
    const storage = fakeStorage();
    writeColumnWidths("p1", "persons", { name: 320 }, storage);
    expect(readColumnWidths("p1", "events", storage)).toEqual({});
  });

  it("heals broken JSON and invalid values", () => {
    const key = columnWidthsStorageKey("p1", "events");
    expect(
      readColumnWidths("p1", "events", fakeStorage({ [key]: "{not json" })),
    ).toEqual({});
    expect(
      readColumnWidths(
        "p1",
        "events",
        fakeStorage({ [key]: JSON.stringify({ date: 5, type: "wide" }) }),
      ),
    ).toEqual({ date: COLUMN_WIDTH_MIN });
  });

  it("survives blocked storage on both directions", () => {
    const storage = fakeStorage();
    storage.failRead = true;
    expect(readColumnWidths("p1", "persons", storage)).toEqual({});

    const writing = fakeStorage();
    writing.failWrite = true;
    expect(() =>
      writeColumnWidths("p1", "persons", { name: 320 }, writing),
    ).not.toThrow();
  });
});
