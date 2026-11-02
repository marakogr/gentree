import { DeleteRegular } from "@fluentui/react-icons";
import { Button } from "./button";

export type BulkBarProps = {
  /** Already localised "selected: N" label. */
  selectedLabel: string;
  deleteLabel: string;
  onDelete: () => void;
};

/** Compact selection summary shown above a table with checkboxes. */
export function BulkBar({
  selectedLabel,
  deleteLabel,
  onDelete,
}: BulkBarProps) {
  return (
    <div className="bulk-bar" role="status">
      <span className="bulk-bar-count">{selectedLabel}</span>
      <Button variant="ghost" size="sm" onClick={onDelete}>
        <DeleteRegular fontSize={16} aria-hidden="true" />
        {deleteLabel}
      </Button>
    </div>
  );
}
