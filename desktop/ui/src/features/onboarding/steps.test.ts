import { describe, expect, it } from "vitest";
import { PROJECT_NAV } from "../../lib/navigation";
import { adjacentStep, isLastStep, tourSteps } from "./steps";

describe("tourSteps", () => {
  it("starts with the welcome, projects and create steps without a project", () => {
    expect(tourSteps(false).map((step) => step.id)).toEqual([
      "welcome",
      "projects",
      "create",
      "finish",
    ]);
  });

  it("drops the create step once a project is open and keeps the screen tour", () => {
    const ids = tourSteps(true).map((step) => step.id);
    expect(ids).not.toContain("create");
    expect(ids[0]).toBe("welcome");
    expect(ids.slice(-2)).toEqual(["help", "finish"]);
    expect(ids).toContain("personsAdd");
    expect(ids).toContain("eventsAdd");
  });

  it("explains every project tab once", () => {
    const ids = tourSteps(true).map((step) => step.id);
    for (const id of [
      "persons",
      "events",
      "map",
      "graph",
      "timeline",
      "path",
      "search",
      "chat",
    ] as const) {
      expect(ids).toContain(id);
    }
  });

  it("follows the sidebar order so the tour never jumps back and forth", () => {
    const visited: string[] = [];
    for (const step of tourSteps(true)) {
      const screen = step.screen;
      if (!screen || screen === "projects" || screen === "help") continue;
      if (visited[visited.length - 1] !== screen) visited.push(screen);
    }
    expect(visited).toEqual(PROJECT_NAV.map((item) => item.id));
  });
});

describe("adjacentStep", () => {
  it("moves both ways and stops at the ends", () => {
    const steps = tourSteps(true);
    expect(adjacentStep(steps, "welcome", 1)?.id).toBe("projects");
    expect(adjacentStep(steps, "welcome", -1)).toBeNull();
    expect(adjacentStep(steps, "finish", 1)).toBeNull();
    expect(adjacentStep(steps, "finish", -1)?.id).toBe("help");
  });

  it("returns null for an unknown id", () => {
    expect(adjacentStep(tourSteps(true), "missing" as never, 1)).toBeNull();
  });
});

describe("isLastStep", () => {
  it("recognizes the finish step in both states", () => {
    expect(isLastStep(tourSteps(false), "finish")).toBe(true);
    expect(isLastStep(tourSteps(true), "finish")).toBe(true);
    expect(isLastStep(tourSteps(true), "welcome")).toBe(false);
  });
});
