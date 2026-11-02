import type { ReactNode } from "react";
import {
  InteractionTag,
  InteractionTagPrimary,
  InteractionTagSecondary,
  Tag,
  TagGroup,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { DismissRegular } from "@fluentui/react-icons";

export type ChipProps = {
  children: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
  /** Accessible name for the remove button; required when `onRemove` is set. */
  removeLabel?: string;
  tone?: "neutral" | "accent";
};

const useStyles = makeStyles({
  // Compact chips must not overflow the filter row; Fluent truncates the text.
  tag: {
    maxWidth: "100%",
  },
  // Applied filter: a raised neutral chip, slightly darker than the page
  // surface. The old brand fill turned almost black against the blue accent.
  filterTag: {
    backgroundImage: `linear-gradient(180deg, ${tokens.colorNeutralBackground1}, ${tokens.colorNeutralBackground2})`,
    color: tokens.colorNeutralForeground1,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow2,
  },
  // Selected filter option: a readable brand tint, not a filled dark row.
  selected: {
    backgroundColor: "color-mix(in oklab, var(--primary) 14%, var(--card))",
    color: "var(--foreground)",
    border: `${tokens.strokeWidthThin} solid var(--primary)`,
    boxShadow: tokens.shadow2,
    ":hover": {
      backgroundColor: "color-mix(in oklab, var(--primary) 20%, var(--card))",
      color: "var(--foreground)",
      border: `${tokens.strokeWidthThin} solid var(--primary)`,
    },
    ":active": {
      backgroundColor: "color-mix(in oklab, var(--primary) 26%, var(--card))",
      color: "var(--foreground)",
      border: `${tokens.strokeWidthThin} solid var(--primary)`,
    },
    "@media (forced-colors: active)": {
      backgroundColor: "Highlight",
      color: "HighlightText",
    },
  },
});

export function Chip({
  children,
  selected = false,
  onClick,
  onRemove,
  removeLabel,
  tone = "neutral",
}: ChipProps) {
  const styles = useStyles();
  const appearance = tone === "accent" ? "brand" : "outline";

  // Removable only: Fluent Tag dismissible is itself a button, so the
  // accessible name is `removeLabel` and Delete/Backspace work out of the box.
  if (onRemove && !onClick) {
    return (
      <TagGroup role="group" size="small" onDismiss={() => onRemove()}>
        <Tag
          className={mergeClasses(styles.tag, styles.filterTag)}
          appearance="outline"
          size="small"
          dismissible
          aria-label={removeLabel}
          title={removeLabel}
        >
          {children}
        </Tag>
      </TagGroup>
    );
  }

  // Clickable (optionally removable): a real button inside InteractionTag, with
  // `aria-pressed` for the selected filter state.
  if (onClick) {
    return (
      <InteractionTag className={styles.tag} appearance="outline" size="small">
        <InteractionTagPrimary
          className={selected ? styles.selected : undefined}
          hasSecondaryAction={Boolean(onRemove)}
          aria-pressed={selected}
          onClick={() => onClick()}
        >
          {children}
        </InteractionTagPrimary>
        {onRemove ? (
          <InteractionTagSecondary
            aria-label={removeLabel}
            aria-labelledby={undefined}
            title={removeLabel}
            onClick={() => onRemove()}
          >
            <DismissRegular aria-hidden="true" />
          </InteractionTagSecondary>
        ) : null}
      </InteractionTag>
    );
  }

  return (
    <Tag className={styles.tag} appearance={appearance} size="small">
      {children}
    </Tag>
  );
}
