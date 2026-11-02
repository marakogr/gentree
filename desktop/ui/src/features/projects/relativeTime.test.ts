import { describe, expect, it } from "vitest";
import {
  STALE_BACKUP_DAYS,
  formatRelativeStamp,
  isStaleStamp,
} from "./relativeTime";

const NOW = new Date("2026-10-31T12:00:00.000Z");
const EMPTY = "\u2014";
const JUST_NOW = "just now";

function at(iso: string): string {
  return iso;
}

describe("formatRelativeStamp", () => {
  it("returns the empty label for missing and malformed stamps", () => {
    expect(formatRelativeStamp(null, "en", NOW, JUST_NOW, EMPTY)).toBe(EMPTY);
    expect(
      formatRelativeStamp(undefined, "en", NOW, JUST_NOW, EMPTY),
    ).toBe(EMPTY);
    expect(formatRelativeStamp("not a date", "en", NOW, JUST_NOW, EMPTY)).toBe(
      EMPTY,
    );
  });

  it("keeps the sub-minute case in the dictionary", () => {
    expect(
      formatRelativeStamp(
        at("2026-10-31T11:59:30.000Z"),
        "en",
        NOW,
        JUST_NOW,
        EMPTY,
      ),
    ).toBe(JUST_NOW);
    // Clock skew (a stamp slightly in the future) must not read "in 2 minutes".
    expect(
      formatRelativeStamp(
        at("2026-10-31T12:00:30.000Z"),
        "en",
        NOW,
        JUST_NOW,
        EMPTY,
      ),
    ).toBe(JUST_NOW);
  });

  it("switches between minutes, hours and days", () => {
    expect(
      formatRelativeStamp(
        at("2026-10-31T11:55:00.000Z"),
        "en",
        NOW,
        JUST_NOW,
        EMPTY,
      ),
    ).toBe("5 minutes ago");
    expect(
      formatRelativeStamp(
        at("2026-10-31T11:00:00.000Z"),
        "en",
        NOW,
        JUST_NOW,
        EMPTY,
      ),
    ).toBe("1 hour ago");
    expect(
      formatRelativeStamp(
        at("2026-10-28T12:00:00.000Z"),
        "en",
        NOW,
        JUST_NOW,
        EMPTY,
      ),
    ).toBe("3 days ago");
  });

  it("localizes the same stamp", () => {
    expect(
      formatRelativeStamp(
        at("2026-10-31T11:55:00.000Z"),
        "ru",
        NOW,
        JUST_NOW,
        EMPTY,
      ),
    ).toBe("5 минут назад");
    expect(
      formatRelativeStamp(
        at("2026-10-28T12:00:00.000Z"),
        "ru",
        NOW,
        JUST_NOW,
        EMPTY,
      ),
    ).toBe("3 дня назад");
  });
});

describe("isStaleStamp", () => {
  it("turns stale after the configured number of days", () => {
    const fresh = new Date(
      NOW.getTime() - (STALE_BACKUP_DAYS - 1) * 24 * 60 * 60 * 1000,
    ).toISOString();
    const stale = new Date(
      NOW.getTime() - (STALE_BACKUP_DAYS + 1) * 24 * 60 * 60 * 1000,
    ).toISOString();

    expect(isStaleStamp(fresh, NOW)).toBe(false);
    expect(isStaleStamp(stale, NOW)).toBe(true);
  });

  it("ignores missing and malformed stamps", () => {
    expect(isStaleStamp(null, NOW)).toBe(false);
    expect(isStaleStamp(undefined, NOW)).toBe(false);
    expect(isStaleStamp("not a date", NOW)).toBe(false);
  });
});
