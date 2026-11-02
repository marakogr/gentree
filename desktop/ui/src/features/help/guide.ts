import { HELP_STEPS, HELP_TOPICS } from "./topics";

/** Minimal translator shape, so the builder stays testable without i18next. */
export type Translate = (key: string) => string;

/**
 * Compact Markdown copy of the built-in guide. It is sent with every chat
 * request and appended to the system prompt, so the assistant can answer
 * questions about the interface, not only about the family data.
 *
 * Both this text and the Help screen read the same dictionary; keep the
 * section list in `topics.ts` as the single source of truth.
 */
export function buildGuideContext(t: Translate): string {
  const sections = HELP_TOPICS.map((topic) => {
    const steps = HELP_STEPS.map(
      (step) => `${step}. ${t(`help:topics.${topic.id}.step${step}`)}`,
    ).join("\n");
    return [
      `### ${t(`help:topics.${topic.id}.title`)}`,
      t(`help:topics.${topic.id}.summary`),
      steps,
      `${t("help:noteLabel")} ${t(`help:topics.${topic.id}.note`)}`,
    ].join("\n");
  });
  return [`# ${t("help:title")}`, ...sections].join("\n\n");
}
