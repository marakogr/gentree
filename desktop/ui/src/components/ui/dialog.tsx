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
import { DismissRegular } from "@fluentui/react-icons";
import { IconButton } from "./icon-button";

export type DialogProps = {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  busy?: boolean;
  size?: "sm" | "md" | "lg" | "full";
  /** Keeps the title for assistive tech but renders its own heading inside. */
  titleHidden?: boolean;
  /**
   * Localized accessible name for the header close control. When omitted no
   * close control is rendered; the footer still owns its Cancel action.
   */
  closeLabel?: string;
  footer?: ReactNode;
  children: ReactNode;
  initialFocusRef?: RefObject<HTMLElement>;
};

// The old overlay reserved a 24px gutter on each side. Each size now has a
// definite width, capped by the viewport, so a dialog never depends on its
// content to become wide or narrow.
const useStyles = makeStyles({
  // The surface is the flex column that owns the height budget. Fluent only
  // caps DialogBody with a viewport-based `max-height`; since the surface is
  // `height: fit-content`, a tall form could grow the body past the surface
  // and paint its actions outside the frame. A constrained flex surface shrinks
  // the body instead.
  surface: {
    display: "flex",
    flexDirection: "column",
    maxWidth: "calc(100vw - 48px)",
    minWidth: 0,
    overflow: "hidden",
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
  // A long dialog must scroll its body instead of pushing the footer outside
  // the window. Fluent lays DialogBody out as a grid whose `1fr` content row
  // keeps its content height when only `max-height` bounds the body, so the
  // actions row could leave the surface. A flex column with a shrinkable
  // content row keeps the footer inside the surface at any height.
  body: {
    display: "flex",
    flexDirection: "column",
    flex: "1 1 auto",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
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
    minHeight: 0,
    flex: "1 1 auto",
    overflowY: "auto",
    overflowX: "hidden",
    overscrollBehavior: "contain",
  },
  // The footer is not part of the scroll area, so its buttons stay reachable
  // while the content above scrolls.
  actions: {
    flexShrink: 0,
    justifyContent: "flex-end",
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
  // The optional header close control sits on the title row, outside the
  // scrollable content, at the far right. The title keeps its width and wraps.
  head: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
  },
  headTitle: {
    flex: "1 1 auto",
    minWidth: 0,
  },
  close: {
    flexShrink: 0,
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
  closeLabel,
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
          {closeLabel ? (
            <div className={mergeClasses("ui-dialog-head", styles.head)}>
              <DialogTitle
                className={mergeClasses(
                  styles.headTitle,
                  titleHidden ? styles.titleHidden : undefined,
                )}
              >
                {title}
              </DialogTitle>
              <IconButton
                className={mergeClasses("ui-dialog-close", styles.close)}
                label={closeLabel}
                onClick={onClose}
                disabled={busy}
              >
                <DismissRegular aria-hidden="true" />
              </IconButton>
            </div>
          ) : (
            <DialogTitle className={titleHidden ? styles.titleHidden : undefined}>
              {title}
            </DialogTitle>
          )}
          <DialogContent
            className={mergeClasses("ui-dialog-content", styles.content)}
          >
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
          {footer ? (
            <DialogActions
              className={mergeClasses("ui-dialog-footer", styles.actions)}
            >
              {footer}
            </DialogActions>
          ) : null}
        </DialogBody>
      </DialogSurface>
    </FluentDialog>
  );
}
