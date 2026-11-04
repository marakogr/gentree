// Timeline-local filter controls. Person, scope and type live in the shared
// event filter row; only the generation limit stays local to the timeline.

import { makeStyles, shorthands, tokens } from "@fluentui/react-components";
import { cn } from "../../lib/utils";
import { useTimelineTranslate } from "./i18n";
import { MAX_GENERATIONS } from "./scope";
import "./timeline-filters.css";

// Fluent tokens for the compact filter strip; layout stays on Tailwind.
const useStyles = makeStyles({
  field: {
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    ":hover": {
      ...shorthands.borderColor(tokens.colorNeutralStroke1Hover),
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "2px",
    },
  },
});

export interface TimelineGenerationsProps {
  generations: number;
  onGenerationsChange: (generations: number) => void;
}

/** Generation limit next to the shared event filters. */
export function TimelineGenerations({
  generations,
  onGenerationsChange,
}: TimelineGenerationsProps) {
  const t = useTimelineTranslate();
  const styles = useStyles();

  return (
    <label className="timeline-filter-label">
      <span className="shrink-0">{t("filters.generations")}</span>
      <input
        type="number"
        min={1}
        max={MAX_GENERATIONS}
        value={generations}
        data-testid="line-generations"
        onChange={(event) => onGenerationsChange(Number(event.target.value))}
        className={cn(
          styles.field,
          "h-7 w-16 rounded-md px-2 py-0 text-[11px] outline-none",
        )}
      />
    </label>
  );
}
