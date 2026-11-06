import { Badge, Text } from "@fluentui/react-components";
import type { ReportCountKey } from "./helpers";

/**
 * Count badges reuse the neutral `informative` tint of the rest of the UI.
 * The default brand tint turns into a dark blue chip on the dark preview
 * surface, so the tone is pinned here instead of relying on the default.
 */
export const IMPORT_BADGE_TONE = "informative" as const;

export type ImportPreviewProps = {
  counts: { key: ReportCountKey; label: string }[];
  /** Warning/issue summary; `null` hides the line. */
  notes: string | null;
  /** Media-copy notice; `null` hides the line. */
  mediaNotice: string | null;
};

/**
 * Dry-run preview of an import: four record counters, an optional warning
 * summary and an optional media notice. Pure presentation, so the badge tone is
 * testable without mounting the dialog.
 */
export function ImportPreview({
  counts,
  notes,
  mediaNotice,
}: ImportPreviewProps) {
  return (
    <div className="import-preview">
      <div className="import-counts">
        {counts.map(({ key, label }) => (
          <Badge
            key={key}
            appearance="tint"
            color={IMPORT_BADGE_TONE}
            size="medium"
          >
            {label}
          </Badge>
        ))}
      </div>
      {notes ? (
        <Text as="p" size={200} className="import-muted">
          {notes}
        </Text>
      ) : null}
      {mediaNotice ? (
        <Text as="p" size={200} className="import-muted">
          {mediaNotice}
        </Text>
      ) : null}
    </div>
  );
}
