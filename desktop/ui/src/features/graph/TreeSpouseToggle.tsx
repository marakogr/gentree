import { Button } from "@fluentui/react-components";

type Props = {
  pressed: boolean;
  disabled?: boolean;
  label: string;
  hint: string;
  onToggle: () => void;
};

/**
 * Two-state toolbar control for the spouse layer. Kept separate so its
 * pressed state and accessible label can be rendered without the canvas.
 */
export default function TreeSpouseToggle({
  pressed,
  disabled = false,
  label,
  hint,
  onToggle,
}: Props) {
  return (
    <Button
      appearance={pressed ? "primary" : "secondary"}
      aria-pressed={pressed}
      disabled={disabled}
      title={hint}
      onClick={onToggle}
    >
      {label}
    </Button>
  );
}
