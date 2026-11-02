import { describe, expect, it } from "vitest";
import type { DateValue } from "../api/types";
import {
  civilDateKey,
  dateValueToInput,
  daysInMonth,
  formatCivilDate,
  formatDateTyping,
  formatDateValue,
  parseCivilDate,
  parseDateInput,
  parseManualDateInput,
} from "./dates";

const t = (key: string, options: Record<string, unknown> = {}) =>
  `${key}|${JSON.stringify(options)}`;

const unknown: DateValue = {
  start: null,
  end: null,
  precision: "UNKNOWN",
  qualifier: "UNKNOWN",
  original: null,
};

const year = (value: number): DateValue => ({
  start: `${value}-01-01`,
  end: `${value + 1}-01-01`,
  precision: "YEAR",
  qualifier: "EXACT",
  original: null,
});

describe("formatDateValue", () => {
  it("formats a year without inventing a day (Intl)", () => {
    const expected = new Intl.DateTimeFormat("en", {
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(1950, 0, 1)));
    expect(formatDateValue(year(1950), "en", t)).toBe(expected);
  });

  it("uses Intl for full dates", () => {
    const value: DateValue = {
      start: "1980-03-05",
      end: "1980-03-06",
      precision: "DAY",
      qualifier: "EXACT",
      original: null,
    };
    const expected = new Intl.DateTimeFormat("en", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(1980, 2, 5)));
    expect(formatDateValue(value, "en", t)).toBe(expected);
  });

  it("keeps the original text for unknown dates", () => {
    expect(
      formatDateValue({ ...unknown, original: "circa 1900" }, "en", t),
    ).toBe("circa 1900");
    expect(formatDateValue(unknown, "en", t)).toBe(t("date.unknown"));
  });

  it("templates before/after/approximate without concatenation", () => {
    const bound: DateValue = {
      start: null,
      end: "1900-01-01",
      precision: "DAY",
      qualifier: "BEFORE",
      original: null,
    };
    const text = formatCivilDate("1900-01-01", "DAY", "en");
    expect(formatDateValue(bound, "en", t)).toBe(t("date.before", { date: text }));

    const after: DateValue = {
      ...bound,
      start: bound.end,
      end: null,
      qualifier: "AFTER",
    };
    expect(formatDateValue(after, "en", t)).toBe(t("date.after", { date: text }));

    const approximate: DateValue = {
      ...bound,
      qualifier: "APPROXIMATE",
    };
    expect(formatDateValue(approximate, "en", t)).toBe(
      t("date.approximate", { date: text }),
    );
  });

  it("renders an exclusive range end as the last visible day", () => {
    const range: DateValue = {
      start: "1950-01-01",
      end: "1950-02-01",
      precision: "DAY",
      qualifier: "RANGE",
      original: null,
    };
    expect(formatDateValue(range, "en", t)).toBe(
      t("date.range", {
        from: formatCivilDate("1950-01-01", "DAY", "en"),
        to: formatCivilDate("1950-01-31", "DAY", "en"),
      }),
    );
  });
});

describe("parseDateInput", () => {
  it("builds half-open bounds for each precision", () => {
    const day = parseDateInput("1950-03-05", "DAY");
    expect(day.ok && day.value.end).toBe("1950-03-06");

    const month = parseDateInput("1950-12", "MONTH");
    expect(month.ok && month.value.start).toBe("1950-12-01");
    expect(month.ok && month.value.end).toBe("1951-01-01");

    const year = parseDateInput("1950", "YEAR");
    expect(year.ok && year.value.start).toBe("1950-01-01");
    expect(year.ok && year.value.end).toBe("1951-01-01");
  });

  it("keeps unparsed text with UNKNOWN precision", () => {
    const parsed = parseDateInput("  spring, about 1900  ", "UNKNOWN");
    expect(parsed.ok && parsed.value).toEqual({
      ...unknown,
      original: "spring, about 1900",
    });
  });

  it("rejects invalid calendar dates and shapes", () => {
    expect(parseDateInput("2023-02-29", "DAY").ok).toBe(false);
    expect(parseDateInput("1950-13", "MONTH").ok).toBe(false);
    expect(parseDateInput("03-05-1950", "DAY").ok).toBe(false);
  });
});

describe("parseManualDateInput", () => {
  it("normalises canonical and dotted day text", () => {
    expect(parseManualDateInput("1950-03-05", "DAY")).toBe("1950-03-05");
    expect(parseManualDateInput(" 5.3.1950 ", "DAY")).toBe("1950-03-05");
    expect(parseManualDateInput("05.03.1950", "DAY")).toBe("1950-03-05");
    expect(parseManualDateInput("1950-3-5", "DAY")).toBe("1950-03-05");
  });

  it("accepts only the units of the chosen precision", () => {
    expect(parseManualDateInput("1950-03", "MONTH")).toBe("1950-03");
    expect(parseManualDateInput("1950-3", "MONTH")).toBe("1950-03");
    expect(parseManualDateInput("1950", "YEAR")).toBe("1950");
    expect(parseManualDateInput("50", "YEAR")).toBe("0050");
    expect(parseManualDateInput("1950-03-05", "MONTH")).toBeNull();
    expect(parseManualDateInput("1950", "MONTH")).toBeNull();
    expect(parseManualDateInput("1950-03", "DAY")).toBeNull();
    expect(parseManualDateInput("05.03.1950", "MONTH")).toBeNull();
  });

  it("checks the calendar, including leap days", () => {
    expect(parseManualDateInput("29.02.2024", "DAY")).toBe("2024-02-29");
    expect(parseManualDateInput("2024-02-29", "DAY")).toBe("2024-02-29");
    expect(parseManualDateInput("29.02.2023", "DAY")).toBeNull();
    expect(parseManualDateInput("1900-02-29", "DAY")).toBeNull();
    expect(parseManualDateInput("31.04.1950", "DAY")).toBeNull();
    expect(parseManualDateInput("1950-13", "MONTH")).toBeNull();
    expect(parseManualDateInput("0000", "YEAR")).toBeNull();
  });

  it("returns null for empty, incomplete or unknown input", () => {
    expect(parseManualDateInput("", "DAY")).toBeNull();
    expect(parseManualDateInput("   ", "DAY")).toBeNull();
    expect(parseManualDateInput("1950-", "DAY")).toBeNull();
    expect(parseManualDateInput("05.03", "DAY")).toBeNull();
    expect(parseManualDateInput("nonsense", "DAY")).toBeNull();
    expect(parseManualDateInput("1950-03-05", "UNKNOWN")).toBeNull();
  });
});

describe("dateValueToInput", () => {
  it("round-trips the visible part per precision", () => {
    expect(dateValueToInput(year(1950))).toBe("1950");
    const month = parseDateInput("1950-03", "MONTH");
    expect(month.ok && dateValueToInput(month.value)).toBe("1950-03");
    const day = parseDateInput("1950-03-05", "DAY");
    expect(day.ok && dateValueToInput(day.value)).toBe("1950-03-05");
    expect(dateValueToInput({ ...unknown, original: "circa 1900" })).toBe(
      "circa 1900",
    );
  });
});

describe("formatDateTyping", () => {
  it("inserts separators for a day date while typing", () => {
    expect(formatDateTyping("1980", "DAY")).toBe("1980");
    expect(formatDateTyping("198005", "DAY")).toBe("1980-05");
    expect(formatDateTyping("19800512", "DAY")).toBe("1980-05-12");
  });

  it("keeps month and year precision to their own units", () => {
    expect(formatDateTyping("19800512", "MONTH")).toBe("1980-05");
    expect(formatDateTyping("19800512", "YEAR")).toBe("1980");
  });

  it("does not reorder a dotted day entry", () => {
    expect(formatDateTyping("12.05.1980", "DAY")).toBe("12.05.1980");
  });

  it("drops stray separators so a pasted ISO date stays canonical", () => {
    expect(formatDateTyping("1980-05-12", "DAY")).toBe("1980-05-12");
    expect(formatDateTyping("", "DAY")).toBe("");
  });
});

describe("civil date helpers", () => {
  it("parses ISO dates and compares by key", () => {
    const date = parseCivilDate("1950-03-05");
    expect(date).toBe("1950-03-05");
    expect(date && civilDateKey(date)).toBe(19500305);
    expect(parseCivilDate("1950-3-5")).toBeNull();
    expect(parseCivilDate("nonsense")).toBeNull();
  });

  it("knows leap years", () => {
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
  });
});
