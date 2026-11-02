import { Text } from "@fluentui/react-components";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import "./ui.css";

export type EmptyStateProps = {
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
};

export function EmptyState({
  text,
  actionLabel,
  onAction,
  compact = false,
}: EmptyStateProps) {
  return (
    <div className={cn("empty-state", compact && "empty-state-compact")}>
      <Text as="p" className="empty-state-text">
        {text}
      </Text>
      {actionLabel && onAction ? (
        <Button variant="secondary" size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}
