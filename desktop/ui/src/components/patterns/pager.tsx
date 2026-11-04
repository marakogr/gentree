import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import "./patterns.css";

export type PagerProps = {
  /** Zero-based current page. */
  page: number;
  totalPages: number;
  /** Localized `Page X / Y` text. */
  label: string;
  previousLabel: string;
  nextLabel: string;
  disabled?: boolean;
  onPageChange: (page: number) => void;
  className?: string;
};

/** Footer pager shared by every list screen. */
export function Pager({
  page,
  totalPages,
  label,
  previousLabel,
  nextLabel,
  disabled = false,
  onPageChange,
  className,
}: PagerProps) {
  return (
    <div className={cn("ui-pager", className)}>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled || page === 0}
        onClick={() => onPageChange(Math.max(0, page - 1))}
      >
        {previousLabel}
      </Button>
      <span className="meta">{label}</span>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled || page + 1 >= totalPages}
        onClick={() => onPageChange(page + 1)}
      >
        {nextLabel}
      </Button>
    </div>
  );
}
