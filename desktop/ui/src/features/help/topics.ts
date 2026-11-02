import type { ShellTab } from "../../lib/navigation";

/** Guide index groups, in reading order. */
export type HelpSectionId = "basics" | "explore" | "tools";

/** One guide section and the screen it explains. */
export type HelpTopic = {
  id: string;
  screen: ShellTab;
  section: HelpSectionId;
};

/** Section order on the index page; labels live in the dictionary. */
export const HELP_SECTIONS: readonly HelpSectionId[] = [
  "basics",
  "explore",
  "tools",
];

export const HELP_TOPICS: readonly HelpTopic[] = [
  { id: "start", screen: "projects", section: "basics" },
  { id: "people", screen: "persons", section: "basics" },
  { id: "relations", screen: "persons", section: "basics" },
  { id: "events", screen: "events", section: "basics" },
  { id: "tree", screen: "graph", section: "explore" },
  { id: "find", screen: "search", section: "explore" },
  { id: "data", screen: "projects", section: "tools" },
  { id: "assistant", screen: "chat", section: "tools" },
];

/** Every section has three numbered steps in the dictionaries. */
export const HELP_STEPS = [1, 2, 3] as const;

/** Screens that need an open project; the guide explains them but cannot open them. */
export const HELP_PROJECT_SCREENS: ReadonlySet<ShellTab> = new Set<ShellTab>([
  "persons",
  "events",
  "graph",
  "path",
  "timeline",
  "search",
  "chat",
]);
