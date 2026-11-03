// Pure sidebar model for the app shell: which items exist, in what order and
// which one is highlighted. No DOM, no IPC.

/** Screens the shell can show. Import is a modal of the projects page. */
export type ShellTab =
  | "projects"
  | "persons"
  | "events"
  | "map"
  | "graph"
  | "path"
  | "timeline"
  | "search"
  | "chat"
  | "help"
  | "settings";

/** Icon ids resolved to lucide components by the shell (kept DOM-free here). */
export type NavIcon =
  | "projects"
  | "persons"
  | "events"
  | "map"
  | "tree"
  | "relation"
  | "timeline"
  | "search"
  | "chat"
  | "help"
  | "settings";

export type NavItem = {
  id: ShellTab;
  labelKey: string;
  icon: NavIcon;
};

/** Where a click on the project name goes: the project's default tab. */
export const DEFAULT_PROJECT_TAB: ShellTab = "persons";

export const GLOBAL_NAV: readonly NavItem[] = [
  { id: "projects", labelKey: "app.navProjects", icon: "projects" },
];

export const PROJECT_NAV: readonly NavItem[] = [
  { id: "persons", labelKey: "app.navPersons", icon: "persons" },
  { id: "events", labelKey: "app.navEvents", icon: "events" },
  { id: "map", labelKey: "app.navMap", icon: "map" },
  { id: "timeline", labelKey: "app.navTimeline", icon: "timeline" },
  { id: "graph", labelKey: "app.navTree", icon: "tree" },
  { id: "search", labelKey: "app.navSearch", icon: "search" },
  { id: "path", labelKey: "app.navRelation", icon: "relation" },
  { id: "chat", labelKey: "app.navChat", icon: "chat" },
];

/** Pinned above settings; the built-in guide is always available. */
export const HELP_NAV: NavItem = {
  id: "help",
  labelKey: "app.navHelp",
  icon: "help",
};

/** Pinned to the bottom of the sidebar; always available. */
export const SETTINGS_NAV: NavItem = {
  id: "settings",
  labelKey: "app.navSettings",
  icon: "settings",
};

export type SidebarModel = {
  global: readonly NavItem[];
  project: readonly NavItem[];
  footer: readonly NavItem[];
};

/** Project tabs are hidden until a project is open; global items stay. */
export function sidebarModel(projectOpen: boolean): SidebarModel {
  return {
    global: GLOBAL_NAV,
    project: projectOpen ? PROJECT_NAV : [],
    footer: [HELP_NAV, SETTINGS_NAV],
  };
}

/** A shell location: the highlighted sidebar item and the rendered screen. */
export type SidebarLocation = { screen: ShellTab };

export function shellLocation(tab: ShellTab): SidebarLocation {
  return { screen: tab };
}

/** Highlighted item. */
export function activeNavId(location: SidebarLocation): ShellTab {
  return location.screen;
}

/** Breadcrumb target when the user lands on a screen from another one. */
export type BackOrigin = Exclude<ShellTab, "settings">;

const BACK_LABEL_KEYS: Record<BackOrigin, string> = {
  projects: "back.projects",
  persons: "back.persons",
  events: "back.events",
  map: "back.map",
  graph: "back.graph",
  path: "back.relation",
  timeline: "back.timeline",
  search: "back.search",
  chat: "back.chat",
  help: "back.help",
};

export function backLabelKey(origin: BackOrigin): string {
  return BACK_LABEL_KEYS[origin];
}

/** Origin to remember for a one-way jump; `null` when it is the same screen. */
export function backOrigin(
  from: ShellTab,
  to: ShellTab,
): BackOrigin | null {
  if (from === to || from === "settings") return null;
  return from;
}
