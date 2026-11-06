import i18next from "i18next";
import { describe, expect, it } from "vitest";
import type { Translate } from "../../lib/dates";
import enTimeline from "../../i18n/locales/en/timeline.json";
import ruTimeline from "../../i18n/locales/ru/timeline.json";
import {
  brushWindow,
  buildAxisTicks,
  buildDensityBins,
  buildLineMarkers,
  clampWindow,
  clusterLineMarkers,
  computeLineWindow,
  computeMarkerWindow,
  computePersonWindow,
  dedupeEvents,
  formatLineDate,
  layoutLineLabels,
  lineDateKind,
  LINE_EDGE_PADDING,
  LINE_EMPTY_DATA_SPAN,
  lineIconKind,
  lineIntervalEnd,
  markerDomain,
  panWindow,
  partitionLineEvents,
  personEventIds,
  positionOnLine,
  relatedEventIds,
  zoomWindow,
} from "./line";
import type { ApiDate, TimelineEvent } from "./types";

const ru = await translator("ru");

async function translator(locale: "ru" | "en"): Promise<Translate> {
  const instance = i18next.createInstance();
  await instance.init({
    lng: locale,
    fallbackLng: false,
    defaultNS: "timeline",
    resources: {
      ru: { timeline: ruTimeline },
      en: { timeline: enTimeline },
    },
    interpolation: { escapeValue: false },
  });
  return (key, options) => String(instance.t(key, options ?? {}));
}

function date(
  start: string | null,
  qualifier: ApiDate["qualifier"] = "EXACT",
  precision: ApiDate["precision"] = "YEAR",
  end: string | null = start,
): ApiDate {
  return { start, end, precision, qualifier, original: null };
}

function event(
  id: string,
  type: string,
  options: {
    start?: string | null;
    end?: string | null;
    qualifier?: ApiDate["qualifier"];
    precision?: ApiDate["precision"];
    participants?: {
      personId: string;
      firstName: string | null;
      lastName: string | null;
      role: string;
    }[];
  } = {},
): TimelineEvent {
  return {
    id,
    type,
    title: null,
    description: null,
    place: null,
    date:
      options.start === null
        ? null
        : date(
            options.start ?? "1950-01-01T00:00:00.000Z",
            options.qualifier ?? "EXACT",
            options.precision ?? "YEAR",
            options.end === undefined
              ? (options.start ?? "1950-01-01T00:00:00.000Z")
              : options.end,
          ),
    participants: options.participants ?? [],
    mediaIds: [],
  };
}

describe("lineIconKind", () => {
  it("maps birth, marriage, death and unknown types", () => {
    expect(lineIconKind("BIRTH")).toBe("birth");
    expect(lineIconKind("BIRT")).toBe("birth");
    expect(lineIconKind("BAPTISM")).toBe("birth");
    expect(lineIconKind("MARRIAGE")).toBe("marriage");
    expect(lineIconKind("MARR")).toBe("marriage");
    expect(lineIconKind("DEATH")).toBe("death");
    expect(lineIconKind("BURIAL")).toBe("death");
    expect(lineIconKind("RESIDENCE")).toBe("other");
    expect(lineIconKind("TOTALLY_UNKNOWN")).toBe("other");
  });
});

describe("lineDateKind", () => {
  it("separates exact, approximate and range without inventing precision", () => {
    expect(lineDateKind(date("1950-01-01T00:00:00.000Z", "EXACT"))).toBe("exact");
    expect(lineDateKind(date("1950-01-01T00:00:00.000Z", "APPROXIMATE"))).toBe(
      "approximate",
    );
    expect(lineDateKind(date("1950-01-01T00:00:00.000Z", "RANGE"))).toBe("range");
    expect(lineDateKind(null)).toBe("approximate");
  });
});

describe("formatLineDate", () => {
  it("prints human day, month and year values", () => {
    expect(
      formatLineDate(date("1938-01-25T00:00:00.000Z", "EXACT", "DAY"), ru),
    ).toBe("25 янв 1938");
    expect(
      formatLineDate(date("1938-01-01T00:00:00.000Z", "EXACT", "MONTH"), ru),
    ).toBe("янв 1938");
    expect(formatLineDate(date("1938-01-01T00:00:00.000Z"), ru)).toBe("1938");
  });

  it("marks approximate and range dates without ISO", () => {
    expect(
      formatLineDate(date("1912-01-01T00:00:00.000Z", "APPROXIMATE"), ru),
    ).toBe("≈1912");
    expect(
      formatLineDate(
        date(
          "1910-01-01T00:00:00.000Z",
          "RANGE",
          "YEAR",
          "1915-01-01T00:00:00.000Z",
        ),
        ru,
      ),
    ).toBe("1910–1915");
    expect(formatLineDate(date(null, "UNKNOWN", "UNKNOWN"), ru)).toBe(
      "дата неизвестна",
    );
  });

  it("localizes the labels for English", async () => {
    const en = await translator("en");
    expect(formatLineDate(date("1938-01-01T00:00:00.000Z", "EXACT", "MONTH"), en)).toBe(
      "Jan 1938",
    );
    expect(formatLineDate(date(null, "UNKNOWN", "UNKNOWN"), en)).toBe(
      "date unknown",
    );
  });
});

describe("partitionLineEvents", () => {
  it("never puts one event in both lists and moves unparsable dated rows", () => {
    const dated = event("e1", "BIRTH", { start: "1950-01-01T00:00:00.000Z" });
    const broken = event("e2", "OTHER", { start: null });
    const undated = event("e3", "OTHER", { start: null });
    const result = partitionLineEvents([dated, broken, dated], [undated, broken]);
    expect(result.dated.map((item) => item.id)).toEqual(["e1"]);
    expect(result.undated.map((item) => item.id)).toEqual(["e2", "e3"]);
  });
});

describe("buildLineMarkers", () => {
  it("creates one marker per dated event, sorted by time", () => {
    const later = event("e2", "MARRIAGE", { start: "1970-01-01T00:00:00.000Z" });
    const earlier = event("e1", "BIRTH", { start: "1950-01-01T00:00:00.000Z" });
    const markers = buildLineMarkers([later, earlier], ru);
    expect(markers.map((marker) => marker.event.id)).toEqual(["e1", "e2"]);
    expect(markers[0]?.label).toBe("1950");
  });

  it("skips undated events and dedupes by id", () => {
    const dated = event("e1", "BIRTH");
    const undated = event("e2", "OTHER", { start: null });
    const markers = buildLineMarkers([dated, undated, dated], ru);
    expect(markers).toHaveLength(1);
  });

  it("carries the main participant, interval and date kind", () => {
    const ev = event("e1", "BIRTH", {
      start: "1950-06-01T00:00:00.000Z",
      qualifier: "APPROXIMATE",
      precision: "MONTH",
      participants: [
        { personId: "p1", firstName: "Иван", lastName: "Первый", role: "CHILD" },
      ],
    });
    const marker = buildLineMarkers([ev], ru)[0];
    expect(marker?.dateKind).toBe("approximate");
    expect(marker?.mainParticipant?.firstName).toBe("Иван");
    expect(marker?.icon).toBe("birth");
    expect(marker?.end?.getMonth()).toBe(6);
  });

  it("derives a visual interval end from precision when the API has none", () => {
    const start = new Date(1950, 5, 1);
    expect(
      lineIntervalEnd(
        date("1950-06-01T00:00:00.000Z", "EXACT", "YEAR", null),
        start,
      )?.getFullYear(),
    ).toBe(1951);
    expect(
      lineIntervalEnd(
        date("1950-06-01T00:00:00.000Z", "EXACT", "MONTH", null),
        start,
      )?.getMonth(),
    ).toBe(6);
    expect(
      lineIntervalEnd(
        date("1950-06-01T00:00:00.000Z", "EXACT", "DAY", null),
        start,
      )?.getDate(),
    ).toBe(2);
  });
});

describe("computeLineWindow", () => {
  it("covers the loaded events plus the ten percent edge padding", () => {
    const first = new Date(1950, 0, 1);
    const last = new Date(1981, 0, 1);
    const span = last.getTime() - first.getTime();
    const window = computeLineWindow(
      [
        event("e1", "BIRTH", { start: "1950-01-01T00:00:00.000Z" }),
        event("e2", "DEATH", { start: "1980-01-01T00:00:00.000Z" }),
      ],
      ru,
    );
    expect(window).not.toBeNull();
    if (window === null) return;
    expect(window.start.getTime()).toBeCloseTo(
      first.getTime() - span * 0.1,
      -3,
    );
    expect(window.end.getTime()).toBeCloseTo(last.getTime() + span * 0.1, -3);
  });

  it("pads the marker interval of a single point", () => {
    const start = new Date(1950, 0, 1);
    const end = new Date(1951, 0, 1);
    const span = end.getTime() - start.getTime();
    const window = computeLineWindow(
      [event("e1", "BIRTH", { start: "1950-01-01T00:00:00.000Z" })],
      ru,
    );
    expect(window?.start.getTime()).toBeCloseTo(
      start.getTime() - span * 0.1,
      -3,
    );
    expect(window?.end.getTime()).toBeCloseTo(end.getTime() + span * 0.1, -3);
  });

  it("returns null for an empty or undated set", () => {
    expect(computeLineWindow([], ru)).toBeNull();
    expect(
      computeLineWindow([event("e1", "OTHER", { start: null })], ru),
    ).toBeNull();
  });
});

describe("markerDomain", () => {
  const markers = buildLineMarkers(
    [
      event("e1", "BIRTH", { start: "1900-01-01T00:00:00.000Z" }),
      event("e2", "DEATH", { start: "1980-06-15T00:00:00.000Z" }),
    ],
    ru,
  );
  const firstStart = new Date(1900, 0, 1).getTime();
  const lastEnd = new Date(1981, 0, 1).getTime();

  it("spans the earliest start to the latest interval end, without padding", () => {
    const domain = markerDomain(markers);
    expect(domain?.start.getTime()).toBe(firstStart);
    expect(domain?.end.getTime()).toBe(lastEnd);
  });

  it("is a navigation reference, not the initial fit", () => {
    const domain = markerDomain(markers);
    const window = computeMarkerWindow(markers);
    expect(window).not.toBeNull();
    if (window === null || domain === null) return;
    expect(domain.start.getTime()).toBe(firstStart);
    expect(domain.end.getTime()).toBe(lastEnd);
    expect(window.start.getTime()).toBeLessThan(firstStart);
    expect(window.end.getTime()).toBeGreaterThan(lastEnd);
  });

  it("keeps future-only markers as their own domain", () => {
    const future = buildLineMarkers(
      [
        event("f1", "BIRTH", { start: "2100-01-01T00:00:00.000Z" }),
        event("f2", "DEATH", { start: "2110-06-15T00:00:00.000Z" }),
      ],
      ru,
    );
    const domain = markerDomain(future);
    expect(domain?.start.getTime()).toBe(new Date(2100, 0, 1).getTime());
    expect(domain?.end.getTime()).toBe(new Date(2111, 0, 1).getTime());
  });

  it("always returns a non-empty domain when a marker exists", () => {
    const point = buildLineMarkers(
      [
        event("p1", "OTHER", {
          start: "1950-01-01T00:00:00.000Z",
          precision: "UNKNOWN",
        }),
      ],
      ru,
    );
    const domain = markerDomain(point);
    expect(domain).not.toBeNull();
    if (domain === null) return;
    // No measurable data span: one day keeps the single marker navigable.
    expect(domain.end.getTime() - domain.start.getTime()).toBe(24 * 3600_000);
    // The initial fit still centres a readable fallback span on it.
    const window = computeMarkerWindow(point);
    expect(window).not.toBeNull();
    if (window === null) return;
    expect(window.end.getTime() - window.start.getTime()).toBe(
      LINE_EMPTY_DATA_SPAN,
    );
  });

  it("returns null without dated markers", () => {
    expect(markerDomain([])).toBeNull();
    expect(computeMarkerWindow([])).toBeNull();
  });
});

describe("computePersonWindow", () => {
  it("wraps only the events of the requested person, with edge padding", () => {
    const p1 = { personId: "p1", firstName: null, lastName: null, role: "SUBJECT" };
    const markers = buildLineMarkers(
      [
        event("e1", "BIRTH", { start: "1900-01-01T00:00:00.000Z", participants: [p1] }),
        event("e2", "DEATH", { start: "1980-01-01T00:00:00.000Z", participants: [p1] }),
        event("e3", "OTHER", { start: "2000-01-01T00:00:00.000Z" }),
      ],
      ru,
    );
    const firstStart = new Date(1900, 0, 1).getTime();
    const lastEnd = new Date(1981, 0, 1).getTime();
    const span = lastEnd - firstStart;
    const window = computePersonWindow(markers, "p1");
    expect(window?.start.getTime()).toBeCloseTo(
      firstStart - span * LINE_EDGE_PADDING,
      -3,
    );
    expect(window?.end.getTime()).toBeCloseTo(
      lastEnd + span * LINE_EDGE_PADDING,
      -3,
    );
    // The third event belongs to nobody else in view, so it stays outside.
    expect(window?.end.getTime()).toBeLessThan(
      new Date(2000, 0, 1).getTime(),
    );
  });

  it("returns null without a person or events", () => {
    expect(computePersonWindow([], null)).toBeNull();
    expect(computePersonWindow(buildLineMarkers([], ru), "p1")).toBeNull();
  });
});

describe("positionOnLine / pan / zoom / brush", () => {
  const window = { start: new Date(1900, 0, 1), end: new Date(2000, 0, 1) };

  it("maps the midpoint and both edges", () => {
    expect(positionOnLine(new Date(1950, 0, 1), window)).toBeCloseTo(0.5);
    expect(positionOnLine(new Date(1900, 0, 1), window)).toBe(0);
    expect(positionOnLine(new Date(2000, 0, 1), window)).toBe(1);
    expect(positionOnLine(new Date(1899, 11, 31), window)).toBeNull();
    expect(positionOnLine(new Date(2000, 0, 2), window)).toBeNull();
  });

  it("pans by a fraction of the span", () => {
    const span = window.end.getTime() - window.start.getTime();
    const panned = panWindow(window, 0.25);
    expect(panned.start.getTime()).toBe(window.start.getTime() + span * 0.25);
    expect(panned.end.getTime() - panned.start.getTime()).toBe(span);
  });

  it("zooms around the middle and around an anchor", () => {
    const originalSpan = window.end.getTime() - window.start.getTime();
    const middle = zoomWindow(window, 0.5);
    expect(middle.end.getTime() - middle.start.getTime()).toBe(originalSpan / 2);
    expect(middle.start.getTime() + originalSpan / 4).toBeCloseTo(
      window.start.getTime() + originalSpan / 2,
    );
    const anchored = zoomWindow(window, 0.5, 1);
    expect(anchored.end.getTime()).toBe(window.end.getTime());
  });

  it("rejects degenerate factors and returns the window unchanged", () => {
    expect(zoomWindow(window, 0)).toEqual(window);
    expect(zoomWindow(window, Number.NaN)).toEqual(window);
  });

  it("turns two brush fractions into a non-empty window", () => {
    const span = window.end.getTime() - window.start.getTime();
    const brushed = brushWindow(window, 0.2, 0.5);
    expect(brushed.start.getTime()).toBeCloseTo(
      window.start.getTime() + span * 0.2,
      0,
    );
    expect(brushed.end.getTime()).toBeCloseTo(
      window.start.getTime() + span * 0.5,
      0,
    );
    const tiny = brushWindow(window, 0.5, 0.5);
    expect(tiny.end.getTime() - tiny.start.getTime()).toBeGreaterThan(0);
  });
});

describe("navigation bounds", () => {
  const DAY = 24 * 3600_000;
  const markers = buildLineMarkers(
    [
      event("e1", "BIRTH", { start: "1900-01-01T00:00:00.000Z" }),
      event("e2", "DEATH", { start: "1980-01-01T00:00:00.000Z" }),
    ],
    ru,
  );
  const domain = markerDomain(markers);
  if (domain === null) throw new Error("expected a data domain");
  const firstStart = new Date(1900, 0, 1).getTime();
  const lastTime = new Date(1980, 0, 1).getTime();

  const overlaps = (next: { start: Date; end: Date }) =>
    next.end.getTime() > domain.start.getTime() &&
    next.start.getTime() < domain.end.getTime();

  it("lets the first event be centred", () => {
    const span = 20 * 366 * DAY;
    const centred = {
      start: new Date(firstStart - span / 2),
      end: new Date(firstStart + span / 2),
    };
    expect(clampWindow(centred, domain)).toEqual(centred);
    expect(positionOnLine(new Date(firstStart), centred)).toBeCloseTo(0.5);
    expect(centred.start.getTime()).toBeLessThan(domain.start.getTime());
  });

  it("lets the last event be centred", () => {
    const span = 20 * 366 * DAY;
    const centred = {
      start: new Date(lastTime - span / 2),
      end: new Date(lastTime + span / 2),
    };
    expect(clampWindow(centred, domain)).toEqual(centred);
    expect(positionOnLine(new Date(lastTime), centred)).toBeCloseTo(0.5);
    // Much of that window is past the data; only the overlap rule matters.
    expect(centred.end.getTime()).toBeGreaterThan(domain.end.getTime());
    expect(overlaps(centred)).toBe(true);
  });

  it("stops panning once no event would stay in view", () => {
    const window = { start: new Date(1950, 0, 1), end: new Date(1970, 0, 1) };
    const span = window.end.getTime() - window.start.getTime();
    const left = panWindow(window, -10, domain);
    expect(left.end.getTime()).toBeGreaterThan(domain.start.getTime());
    expect(left.end.getTime()).toBeLessThanOrEqual(domain.start.getTime() + DAY);
    expect(left.start.getTime()).toBeLessThan(domain.start.getTime());
    expect(left.end.getTime() - left.start.getTime()).toBe(span);
    const right = panWindow(window, 10, domain);
    expect(right.start.getTime()).toBeLessThan(domain.end.getTime());
    expect(right.start.getTime()).toBeGreaterThanOrEqual(
      domain.end.getTime() - DAY,
    );
    expect(right.end.getTime() - right.start.getTime()).toBe(span);
  });

  it("keeps at least one event in view for every zoom anchor", () => {
    const window = { start: new Date(1950, 0, 1), end: new Date(1970, 0, 1) };
    for (const factor of [0.1, 0.5, 2, 10]) {
      for (const anchor of [0, 0.5, 1]) {
        expect(overlaps(zoomWindow(window, factor, anchor, domain))).toBe(true);
      }
    }
  });

  it("keeps a window wider than the data while it still overlaps", () => {
    const wide = { start: new Date(1800, 0, 1), end: new Date(2100, 0, 1) };
    expect(clampWindow(wide, domain)).toEqual(wide);
  });

  it("does not invent a range without events", () => {
    const window = { start: new Date(1950, 0, 1), end: new Date(1960, 0, 1) };
    expect(clampWindow(window, null)).toEqual(window);
    expect(markerDomain([])).toBeNull();
  });

  it("applies the same overlap rule to future-only data", () => {
    const future = buildLineMarkers(
      [
        event("f1", "BIRTH", { start: "2100-01-01T00:00:00.000Z" }),
        event("f2", "DEATH", { start: "2110-01-01T00:00:00.000Z" }),
      ],
      ru,
    );
    const futureDomain = markerDomain(future);
    if (futureDomain === null) throw new Error("expected a future domain");
    const futureLast = new Date(2110, 0, 1).getTime();
    const span = 8 * 366 * DAY;
    const centred = {
      start: new Date(futureLast - span / 2),
      end: new Date(futureLast + span / 2),
    };
    expect(clampWindow(centred, futureDomain)).toEqual(centred);
    const before = panWindow(
      { start: new Date(2101, 0, 1), end: new Date(2109, 0, 1) },
      -10,
      futureDomain,
    );
    expect(before.end.getTime()).toBeGreaterThan(
      futureDomain.start.getTime(),
    );
    expect(before.end.getTime()).toBeLessThanOrEqual(
      futureDomain.start.getTime() + DAY,
    );
  });
});

describe("buildAxisTicks", () => {
  function windowOfYears(years: number) {
    return {
      start: new Date(1900, 0, 1),
      end: new Date(1900 + years, 0, 1),
    };
  }

  it("uses years for a ten-year range and never overlaps labels", () => {
    const ticks = buildAxisTicks(windowOfYears(10), 800, ru);
    expect(ticks.length).toBeGreaterThanOrEqual(8);
    expect(ticks.every((tick) => tick.unit === "year")).toBe(true);
    const xs = ticks.map((tick) =>
      positionOnLine(tick.time, windowOfYears(10)),
    );
    for (let index = 1; index < xs.length; index += 1) {
      expect(((xs[index] ?? 0) - (xs[index - 1] ?? 0)) * 800).toBeGreaterThanOrEqual(58);
    }
  });

  it("uses decades for a hundred-year range", () => {
    const ticks = buildAxisTicks(windowOfYears(100), 800, ru);
    expect(ticks[1]?.time.getFullYear()).toBe(1910);
    expect(ticks.length).toBeLessThanOrEqual(12);
    expect(ticks.every((tick) => tick.unit === "year")).toBe(true);
  });

  it("uses centuries for a thousand-year range", () => {
    const ticks = buildAxisTicks(windowOfYears(1000), 800, ru);
    expect(ticks[1]?.time.getFullYear()).toBe(2000);
    expect(ticks.length).toBeLessThanOrEqual(12);
  });

  it("switches to months when zoomed into a few years", () => {
    const ticks = buildAxisTicks(
      { start: new Date(1950, 0, 1), end: new Date(1952, 0, 1) },
      800,
      ru,
    );
    expect(ticks.some((tick) => tick.unit === "month")).toBe(true);
    expect(ticks.some((tick) => tick.label.includes("1950"))).toBe(true);
  });
});

describe("buildDensityBins", () => {
  const window = { start: new Date(1900, 0, 1), end: new Date(2000, 0, 1) };

  it("aggregates markers into equal bins", () => {
    const markers = buildLineMarkers(
      [
        event("e1", "BIRTH", { start: "1950-01-01T00:00:00.000Z" }),
        event("e2", "DEATH", { start: "1950-02-01T00:00:00.000Z" }),
        event("e3", "OTHER", { start: "1990-01-01T00:00:00.000Z" }),
      ],
      ru,
    );
    const bins = buildDensityBins(markers, window, 5);
    expect(bins).toHaveLength(5);
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(3);
    expect(Math.max(...bins.map((bin) => bin.count))).toBe(2);
    expect(bins[2]?.weight).toBe(1);
  });

  it("returns no bins for a degenerate window", () => {
    expect(buildDensityBins([], { start: window.end, end: window.start })).toEqual(
      [],
    );
  });
});

describe("clusterLineMarkers", () => {
  const window = { start: new Date(1900, 0, 1), end: new Date(2000, 0, 1) };

  it("collapses dense markers into one cluster and keeps isolated ones", () => {
    const events = [
      event("e1", "BIRTH", { start: "1950-01-01T00:00:00.000Z" }),
      event("e2", "BIRTH", { start: "1950-01-02T00:00:00.000Z" }),
      event("e3", "DEATH", { start: "1990-01-01T00:00:00.000Z" }),
    ];
    const clusters = clusterLineMarkers(buildLineMarkers(events, ru), window, 800);
    expect(clusters.some((cluster) => cluster.count === 2)).toBe(true);
    expect(clusters.some((cluster) => cluster.count === 1)).toBe(true);
  });

  it("keeps the selected event separate from a cluster", () => {
    const events = [
      event("e1", "BIRTH", { start: "1950-01-01T00:00:00.000Z" }),
      event("e2", "BIRTH", { start: "1950-01-02T00:00:00.000Z" }),
    ];
    const clusters = clusterLineMarkers(
      buildLineMarkers(events, ru),
      window,
      800,
      { isolateId: "e1" },
    );
    expect(clusters).toHaveLength(2);
    expect(
      clusters.some(
        (cluster) => cluster.count === 1 && cluster.markers[0]?.event.id === "e1",
      ),
    ).toBe(true);
  });

  it("keeps a single marker unclustered", () => {
    const clusters = clusterLineMarkers(
      buildLineMarkers([event("e1", "BIRTH")], ru),
      window,
      800,
    );
    expect(clusters[0]?.count).toBe(1);
  });
});

describe("layoutLineLabels", () => {
  const window = { start: new Date(1900, 0, 1), end: new Date(2000, 0, 1) };

  it("places labels without intersections and prioritises the selection", () => {
    const events = Array.from({ length: 24 }, (_, index) =>
      event(`e${index}`, index % 3 === 0 ? "BIRTH" : "OTHER", {
        start: `${1910 + index * 3}-01-01T00:00:00.000Z`,
      }),
    );
    const clusters = clusterLineMarkers(buildLineMarkers(events, ru), window, 800);
    const labels = layoutLineLabels(clusters, 800, {
      axisY: 210,
      selectedEventId: "e12",
      rootPersonId: null,
      focusPersonId: null,
      maxRows: 3,
      t: ru,
    });
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.some((label) => label.eventId === "e12")).toBe(true);
    for (const label of labels) {
      expect(label.x).toBeGreaterThanOrEqual(0);
      expect(label.x + label.width).toBeLessThanOrEqual(800);
      expect(label.y).toBeGreaterThanOrEqual(0);
    }
    for (let index = 0; index < labels.length; index += 1) {
      for (let other = index + 1; other < labels.length; other += 1) {
        const a = labels[index];
        const b = labels[other];
        if (a === undefined || b === undefined || a.side !== b.side) continue;
        const overlapX = a.x < b.x + b.width + 6 && a.x + a.width + 6 > b.x;
        const overlapY = a.y < b.y + b.height + 2 && a.y + a.height + 2 > b.y;
        expect(overlapX && overlapY).toBe(false);
      }
    }
  });

  it("keeps bottom labels below the axis tick labels", () => {
    const events = Array.from({ length: 12 }, (_, index) =>
      event(`e${index}`, "OTHER", {
        start: `${1910 + index * 7}-01-01T00:00:00.000Z`,
      }),
    );
    const clusters = clusterLineMarkers(
      buildLineMarkers(events, ru),
      window,
      800,
    );
    const labels = layoutLineLabels(clusters, 800, {
      axisY: 210,
      axisLabelHeight: 24,
      maxRows: 3,
      t: ru,
    });
    const bottom = labels.filter((label) => label.side === "bottom");
    expect(bottom.length).toBeGreaterThan(0);
    for (const label of bottom) {
      expect(label.y).toBeGreaterThanOrEqual(210 + 24);
      expect(label.leader.y).toBe(210 + 24);
    }
  });

  it("drops candidates that do not fit instead of overlapping", () => {
    const events = Array.from({ length: 40 }, (_, index) =>
      event(`e${index}`, "OTHER", {
        start: `${1900 + index * 2}-01-01T00:00:00.000Z`,
      }),
    );
    const clusters = clusterLineMarkers(buildLineMarkers(events, ru), window, 280);
    const labels = layoutLineLabels(clusters, 280, {
      axisY: 160,
      maxRows: 2,
      t: ru,
    });
    expect(labels.length).toBeLessThanOrEqual(4);
  });
});

describe("relatedEventIds / personEventIds / dedupeEvents", () => {
  const shared = { personId: "p1", firstName: null, lastName: null, role: "SUBJECT" };
  const ev1 = event("e1", "BIRTH", { participants: [shared] });
  const ev2 = event("e2", "OTHER", { participants: [shared] });
  const ev3 = event("e3", "OTHER", {
    participants: [{ personId: "p2", firstName: null, lastName: null, role: "SUBJECT" }],
  });

  it("finds other events sharing a participant with the selection", () => {
    expect(relatedEventIds([ev1, ev2, ev3], "e1")).toEqual(new Set(["e2"]));
    expect(relatedEventIds([ev1, ev2, ev3], null)).toEqual(new Set());
  });

  it("highlights the person's own events", () => {
    const family = event("e4", "MARRIAGE", {
      participants: [
        shared,
        { personId: "p3", firstName: null, lastName: null, role: "SPOUSE" },
      ],
    });
    const all = [ev1, ev2, ev3, family];
    expect(personEventIds(all, "p1")).toEqual(new Set(["e1", "e2", "e4"]));
    expect(personEventIds(all, null)).toEqual(new Set());
  });

  it("dedupes events by id, keeping order", () => {
    const a = event("a", "BIRTH");
    const b = event("b", "OTHER");
    expect(dedupeEvents([a, b, a, a]).map((item) => item.id)).toEqual(["a", "b"]);
  });
});

describe("timeline dictionary", () => {
  it("uses Russian plural forms for clusters and counts", () => {
    expect(ru("clusterCount", { count: 2 })).toBe("2 события");
    expect(ru("clusterCount", { count: 5 })).toBe("5 событий");
    expect(ru("line.countDated", { count: 5 })).toBe(
      "5 датированных событий",
    );
  });
});
