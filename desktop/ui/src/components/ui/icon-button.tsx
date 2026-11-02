import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Button as FluentButton } from "@fluentui/react-components";
import "./ui.css";

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Accessible name; also rendered as the native title. */
  label: string;
  children?: ReactNode;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    { label, className, children, type = "button", ...rest },
    ref,
  ) {
    // `ReactNode` allows booleans, Fluent's slot shorthand does not.
    const icon = typeof children === "boolean" ? undefined : children;
    return (
      <FluentButton
        {...rest}
        ref={ref}
        type={type}
        appearance="subtle"
        shape="rounded"
        icon={icon}
        className={className}
        aria-label={label}
        title={label}
      />
    );
  },
);
