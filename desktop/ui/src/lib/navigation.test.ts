import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_TAB,
  HELP_NAV,
  PROJECT_NAV,
  SETTINGS_NAV,
  activeNavId,
  backLabelKey,
  backOrigin,
  shellLocation,
  sidebarModel,
} from "./navigation";

describe("sidebarModel", () => {
  it("keeps global items and hides project tabs until a project opens", () => {
    const closed = sidebarModel(false);
    expect(closed.global.map((item) => item.id)).toEqual(["projects"]);
    expect(closed.project).toEqual([]);
    expect(closed.footer).toEqual([HELP_NAV, SETTINGS_NAV]);
  });

  it("maps the project tabs in the documented order", () => {
    const open = sidebarModel(true);
    expect(open.project.map((item) => item.id)).toEqual([
      "persons",
      "events",
      "map",
      "graph",
      "timeline",
      "path",
      "search",
      "chat",
    ]);
    expect(open.project.map((item) => item.labelKey)).toEqual([
      "app.navPersons",
      "app.navEvents",
      "app.navMap",
      "app.navTree",
      "app.navTimeline",
      "app.navRelation",
      "app.navSearch",
      "app.navChat",
    ]);
    expect(open.project.map((item) => item.icon)).toEqual([
      "persons",
      "events",
      "map",
      "tree",
      "timeline",
      "relation",
      "search",
      "chat",
    ]);
    expect(open.global.map((item) => item.id)).toEqual(["projects"]);
    expect(open.footer.map((item) => item.id)).toEqual(["help", "settings"]);
  });

  it("has no standalone import item and defaults to persons", () => {
    const ids: string[] = [
      ...sidebarModel(true).global,
      ...PROJECT_NAV,
      SETTINGS_NAV,
    ].map((item) => item.id);
    expect(ids).not.toContain("import");
    expect(DEFAULT_PROJECT_TAB).toBe("persons");
    expect(PROJECT_NAV.some((item) => item.id === DEFAULT_PROJECT_TAB)).toBe(
      true,
    );
    expect(new Set(PROJECT_NAV.map((item) => item.labelKey)).size).toBe(
      PROJECT_NAV.length,
    );
  });
});

describe("backOrigin", () => {
  it("remembers the origin for a cross-screen jump", () => {
    expect(backOrigin("search", "persons")).toBe("search");
    expect(backOrigin("timeline", "persons")).toBe("timeline");
    expect(backOrigin("chat", "persons")).toBe("chat");
  });

  it("does not add a breadcrumb for same-screen or settings jumps", () => {
    expect(backOrigin("persons", "persons")).toBeNull();
    expect(backOrigin("settings", "persons")).toBeNull();
  });

  it("maps every origin to a breadcrumb key", () => {
    for (const origin of [
      "projects",
      "persons",
      "events",
      "map",
      "graph",
      "path",
      "timeline",
      "search",
      "chat",
      "help",
    ] as const) {
      expect(backLabelKey(origin)).toMatch(/^back\./);
    }
  });
});

describe("activeNavId", () => {
  it("highlights the projects item for the projects screen", () => {
    expect(activeNavId(shellLocation("projects"))).toBe("projects");
  });

  it("maps every other screen to its own item", () => {
    expect(activeNavId(shellLocation("persons"))).toBe("persons");
    expect(activeNavId(shellLocation("chat"))).toBe("chat");
    expect(activeNavId(shellLocation("settings"))).toBe("settings");
  });

  it("never activates a project tab while the projects page is open", () => {
    const active = activeNavId(shellLocation("projects"));
    expect(PROJECT_NAV.some((item) => item.id === active)).toBe(false);
  });
});
