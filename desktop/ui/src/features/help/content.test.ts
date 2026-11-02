import { describe, expect, it } from "vitest";
import enHelp from "../../i18n/locales/en/help.json";
import ruHelp from "../../i18n/locales/ru/help.json";
import { HELP_PROJECT_SCREENS, HELP_SECTIONS, HELP_STEPS, HELP_TOPICS } from "./topics";

type Dictionaries = { topics: Record<string, Record<string, unknown>> };

/** Every article needs a title, a summary, three steps and a note. */
const ARTICLE_KEYS = [
  "title",
  "summary",
  "note",
  ...HELP_STEPS.map((step) => `step${step}`),
];

const CHROME_KEYS = [
  "title",
  "searchPlaceholder",
  "searchLabel",
  "topicsLabel",
  "allTopics",
  "searchResultsLabel",
  "startTour",
  "noResults",
  "resultsCount",
  "openScreen",
  "openProjectFirst",
  "stepsLabel",
  "noteLabel",
];

describe("guide content", () => {
  for (const [locale, dictionary] of [
    ["en", enHelp],
    ["ru", ruHelp],
  ] as const) {
    it(`has every article in ${locale}`, () => {
      const topics = (dictionary as Dictionaries).topics;
      expect(Object.keys(topics).sort()).toEqual(
        HELP_TOPICS.map((topic) => topic.id).sort(),
      );
      for (const topic of HELP_TOPICS) {
        const article = topics[topic.id];
        expect(article, `${locale}:${topic.id}`).toBeDefined();
        for (const key of ARTICLE_KEYS) {
          const value = article[key];
          expect(typeof value, `${locale}:${topic.id}.${key}`).toBe("string");
          expect(
            (value as string).trim(),
            `${locale}:${topic.id}.${key}`,
          ).not.toBe("");
        }
      }
    });

    it(`has the guide chrome in ${locale}`, () => {
      for (const key of CHROME_KEYS) {
        expect(typeof dictionary[key as keyof typeof dictionary]).toBe("string");
      }
      for (const section of HELP_SECTIONS) {
        expect(
          typeof (dictionary as { sections: Record<string, unknown> }).sections[
            section
          ],
        ).toBe("string");
      }
    });
  }

  it("assigns every topic to a declared, non-empty section", () => {
    const covered = HELP_TOPICS.map((topic) => topic.section);
    for (const section of HELP_SECTIONS) {
      expect(covered).toContain(section);
    }
    expect(new Set(covered).size).toBe(HELP_SECTIONS.length);
  });

  it("only marks project screens as blocked without a project", () => {
    for (const topic of HELP_TOPICS) {
      if (topic.screen === "projects") {
        expect(HELP_PROJECT_SCREENS.has(topic.screen)).toBe(false);
      }
    }
  });
});
