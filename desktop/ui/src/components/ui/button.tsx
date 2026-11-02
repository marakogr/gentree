import { forwardRef, useId } from "react";
import type { ButtonHTMLAttributes } from "react";
import {
  Button as FluentButton,
  Spinner,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import "./ui.css";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  loading?: boolean;
  /** Shown as `title` and exposed through `aria-describedby` while disabled. */
  disabledReason?: string;
};

// Fluent v9 has no `appearance="danger"`, so the destructive variant is a
// token preset applied on top of `appearance="primary"`.
const useStyles = makeStyles({
  danger: {
    ":not(:disabled)": {
      backgroundColor: tokens.colorStatusDangerBackground3,
      color: tokens.colorNeutralForegroundOnBrand,
    },
    ":not(:disabled):hover": {
      backgroundColor: tokens.colorStatusDangerBackground3Hover,
      color: tokens.colorNeutralForegroundOnBrand,
    },
    ":not(:disabled):active": {
      backgroundColor: tokens.colorStatusDangerBackground3Pressed,
      color: tokens.colorNeutralForegroundOnBrand,
    },
  },
});

const APPEARANCE = {
  primary: "primary",
  secondary: "secondary",
  ghost: "subtle",
  danger: "primary",
} as const;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "secondary",
      size = "md",
      loading = false,
      disabledReason,
      disabled,
      className,
      children,
      title,
      type = "button",
      ...rest
    },
    ref,
  ) {
    const styles = useStyles();
    const reasonId = useId();
    const isDisabled = Boolean(disabled) || loading;
    const describedBy =
      [rest["aria-describedby"], disabledReason ? reasonId : null]
        .filter(Boolean)
        .join(" ") || undefined;
    return (
      <FluentButton
        {...rest}
        ref={ref}
        type={type}
        appearance={APPEARANCE[variant]}
        size={size === "sm" ? "small" : "medium"}
        className={
          variant === "danger"
            ? [styles.danger, className].filter(Boolean).join(" ")
            : className
        }
        disabled={isDisabled}
        aria-busy={loading || undefined}
        aria-describedby={describedBy}
        title={disabledReason ?? title}
        icon={loading ? <Spinner size="tiny" aria-hidden="true" /> : undefined}
      >
        <span className="btn-label">{children}</span>
        {disabledReason ? (
          <span id={reasonId} className="ui-sr-only" aria-hidden="true">
            {disabledReason}
          </span>
        ) : null}
      </FluentButton>
    );
  },
);
