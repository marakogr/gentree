import { useEffect, useId } from "react";
import type { ReactNode, RefObject } from "react";
import {
  Dialog as FluentDialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";

export type DialogProps = {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  busy?: boolean;
  size?: "sm" | "md" | "lg" | "full";
  /** Keeps the title for assistive tech but renders its own heading inside. */
  titleHidden?: boolean;
  footer?: ReactNode;
  children: ReactNode;
  initialFocusRef?: RefObject<HTMLElement>;
};

// The old overlay reserved a 24px gutter on each side. Each size now has a
// definite width, capped by the viewport, so a dialog never depends on its
// content to become wide or narrow.
const useStyles = makeStyles({
  surface: {
    maxWidth: "calc(100vw - 48px)",
    minWidth: 0,
  },
  sm: {
    width: "420px",
  },
  md: {
    width: "560px",
  },
  lg: {
    width: "720px",
  },
  body: {
    minWidth: 0,
    overflowY: "auto",
  },
  // Fluent gives DialogContent `margin: -4px; padding: 4px; overflow-y: auto`.
  // The negative margin widens it past the surface by 8px, and the computed
  // `overflow-x: auto` turns that into a permanent horizontal scrollbar. Reset
  // it: the surface padding is the gutter, the content never exceeds it, and
  // real horizontal content keeps its own scroll container.
  content: {
    margin: 0,
    padding: 0,
    minWidth: 0,
  },
  full: {
    maxWidth: "1120px",
    maxHeight: "88vh",
  },
  titleHidden: {
    position: "absolute",
    width: "1px",
    height: "1px",
    margin: "-1px",
    padding: 0,
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    whiteSpace: "nowrap",
    border: 0,
  },
  description: {
    display: "block",
    marginBottom: tokens.spacingVerticalM,
    color: tokens.colorNeutralForeground2,
  },
});

export function Dialog({
  open,
  title,
  description,
  onClose,
  busy = false,
  size = "md",
  titleHidden = false,
  footer,
  children,
  initialFocusRef,
}: DialogProps): ReactNode {
  const styles = useStyles();
  const descriptionId = useId();

  // Fluent focuses the first focusable element on open. When the caller asks
  // for a specific target, override that after the dialog has been painted.
  useEffect(() => {
    if (!open) return undefined;
    const preferred = initialFocusRef?.current;
    if (!preferred) return undefined;

    const frame = window.requestAnimationFrame(() => {
      if (preferred.isConnected) preferred.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, initialFocusRef]);

  // Preserve the old unmount-on-close contract: no surface stays in the DOM
  // and Fluent's focus trap restores focus to the trigger on unmount.
  if (!open) return null;

  return (
    <FluentDialog
      open={open}
      modalType="modal"
      onOpenChange={(_event, data) => {
        // Escape and backdrop clicks both land here; busy dialogs stay open.
        if (!data.open && !busy) onClose();
      }}
    >
      <DialogSurface
        className={mergeClasses(styles.surface, styles[size])}
        aria-busy={busy || undefined}
        aria-describedby={description ? descriptionId : undefined}
      >
        <DialogBody aria-busy={busy || undefined} className={styles.body}>
          <DialogTitle className={titleHidden ? styles.titleHidden : undefined}>
            {title}
          </DialogTitle>
          <DialogContent className={styles.content}>
            {description ? (
              <Text
                id={descriptionId}
                size={300}
                className={styles.description}
              >
                {description}
              </Text>
            ) : null}
            {children}
          </DialogContent>
          {footer ? <DialogActions>{footer}</DialogActions> : null}
        </DialogBody>
      </DialogSurface>
    </FluentDialog>
  );
}
