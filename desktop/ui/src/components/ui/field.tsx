import { cloneElement, isValidElement, useId } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  Label,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { cn } from "../../lib/utils";
import "./ui.css";

export type FieldProps = {
  label: string;
  htmlFor: string;
  error?: string | null;
  hint?: string;
  required?: boolean;
  children: ReactNode;
};

type FieldControlProps = {
  id?: string;
  required?: boolean;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
};

// Wiring stays local instead of using Fluent `Field`: some children are still
// native input/select, others are already Fluent Input/Select, so one
// `cloneElement` contract covers both. Fluent owns only the text rendering
// below, while the legacy `field*` classes remain as page-CSS hooks.
const useStyles = makeStyles({
  label: {
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightMedium,
    lineHeight: tokens.lineHeightBase300,
  },
  required: {
    color: tokens.colorStatusDangerForeground1,
  },
  hint: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
  error: {
    color: tokens.colorStatusDangerForeground1,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
});

export function Field({
  label,
  htmlFor,
  error,
  hint,
  required = false,
  children,
}: FieldProps) {
  const styles = useStyles();
  const generatedId = useId();
  const hintId = `${htmlFor}-${generatedId}-hint`;
  const errorId = `${htmlFor}-${generatedId}-error`;
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") ||
    undefined;

  let content: ReactNode = children;
  if (isValidElement(children)) {
    const control = children as ReactElement<FieldControlProps>;
    content = cloneElement(control, {
      id: control.props.id ?? htmlFor,
      required: required || control.props.required || undefined,
      "aria-describedby":
        [control.props["aria-describedby"], describedBy]
          .filter(Boolean)
          .join(" ") || undefined,
      "aria-invalid": error ? true : control.props["aria-invalid"],
    });
  }

  return (
    <div className={cn("field", error && "field-invalid")}>
      <Label
        className={mergeClasses("field-label", styles.label)}
        htmlFor={htmlFor}
      >
        <span>{label}</span>
        {required ? (
          <span
            className={mergeClasses("field-required", styles.required)}
            aria-hidden="true"
          >
            *
          </span>
        ) : null}
      </Label>
      {content}
      {hint ? (
        <Text
          as="p"
          id={hintId}
          className={mergeClasses("field-hint", styles.hint)}
        >
          {hint}
        </Text>
      ) : null}
      {error ? (
        <Text
          as="p"
          id={errorId}
          role="alert"
          className={mergeClasses("field-error", styles.error)}
        >
          {error}
        </Text>
      ) : null}
    </div>
  );
}
