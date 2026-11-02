import { describe, expect, it } from "vitest";
import {
  PERSON_NAVIGATION_ACTIONS,
  personNavigationLabelKey,
  personNavigationTarget,
} from "./actions";

describe("person navigation actions", () => {
  it("offers tree and timeline in a stable order", () => {
    expect(PERSON_NAVIGATION_ACTIONS).toEqual(["tree", "timeline"]);
  });

  it("maps the tree action to the graph tab with the person as root", () => {
    expect(personNavigationTarget("tree", "person-1")).toEqual({
      tab: "graph",
      personId: "person-1",
    });
  });

  it("maps the timeline action to the timeline tab focused on the person", () => {
    expect(personNavigationTarget("timeline", "person-2")).toEqual({
      tab: "timeline",
      personId: "person-2",
    });
  });

  it("points each action at its own label", () => {
    expect(personNavigationLabelKey("tree")).toBe("common:actions.openTree");
    expect(personNavigationLabelKey("timeline")).toBe(
      "common:actions.openTimeline",
    );
  });
});
