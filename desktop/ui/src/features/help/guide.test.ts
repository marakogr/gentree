import { describe, expect, it } from "vitest";
import { buildGuideContext } from "./guide";
import { HELP_STEPS, HELP_TOPICS } from "./topics";

/** Echoes the key, so the test asserts structure rather than translations. */
const t = (key: string) => key;

describe("buildGuideContext", () => {
  it("starts with the guide title", () => {
    expect(buildGuideContext(t).split("\n")[0]).toBe("# help:title");
  });

  it("renders every topic as a section with numbered steps and a note", () => {
    const guide = buildGuideContext(t);
    for (const topic of HELP_TOPICS) {
      expect(guide).toContain(`### help:topics.${topic.id}.title`);
      expect(guide).toContain(`help:topics.${topic.id}.summary`);
      for (const step of HELP_STEPS) {
        expect(guide).toContain(`${step}. help:topics.${topic.id}.step${step}`);
      }
      expect(guide).toContain(`help:noteLabel help:topics.${topic.id}.note`);
    }
  });

  it("keeps the sections in the declared order", () => {
    const guide = buildGuideContext(t);
    const positions = HELP_TOPICS.map((topic) =>
      guide.indexOf(`### help:topics.${topic.id}.title`),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(
      positions,
    );
  });

  it("separates sections with a blank line", () => {
    expect(buildGuideContext(t)).toContain(
      "\n\n### help:topics.start.title",
    );
  });
});
