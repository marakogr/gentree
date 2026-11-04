import { useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import { cn } from "../../lib/utils";
import {
  roundSplitterWidth,
  splitterKeyTarget,
  splitterPointerWidth,
  type SplitterBounds,
} from "./splitter";
import "./patterns.css";

export type SplitterProps = {
  /** Accessible name, already translated by the screen. */
  label: string;
  /** Current position in percent. */
  width: number;
  bounds: SplitterBounds;
  /** The measured grid that the width is a percentage of. */
  containerRef: RefObject<HTMLElement | null>;
  /** Live width while dragging or on a keyboard step. */
  onWidthChange: (width: number) => void;
  /** Called on pointer release, keyboard step and double click. */
  onCommit: (width: number) => void;
  onResizingChange?: (resizing: boolean) => void;
  className?: string;
};

/**
 * Vertical splitter for a master-detail grid.
 *
 * All geometry and keyboard rules live in `splitter.ts`; this component only
 * wires pointer capture, the ARIA separator and the callbacks.
 */
export function Splitter({
  label,
  width,
  bounds,
  containerRef,
  onWidthChange,
  onCommit,
  onResizingChange,
  className,
}: SplitterProps) {
  const [resizing, setResizing] = useState(false);
  // Mirror the live width so a commit never depends on a pending render.
  const liveWidth = useRef(width);
  liveWidth.current = width;

  const widthFromPointer = (clientX: number): boolean => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return false;
    const next = splitterPointerWidth(
      clientX,
      rect.left,
      rect.width,
      bounds,
    );
    if (next === null) return false;
    liveWidth.current = next;
    onWidthChange(next);
    return true;
  };

  const stopResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizing) return;
    setResizing(false);
    onResizingChange?.(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onCommit(roundSplitterWidth(liveWidth.current, bounds));
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
    onResizingChange?.(true);
    widthFromPointer(event.clientX);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizing) return;
    widthFromPointer(event.clientX);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = splitterKeyTarget(
      event.key,
      width,
      bounds,
      event.shiftKey,
    );
    if (target === null) return;
    event.preventDefault();
    liveWidth.current = target;
    onWidthChange(target);
    onCommit(roundSplitterWidth(target, bounds));
  };

  return (
    <div
      className={cn("ui-splitter", resizing && "ui-splitter-active", className)}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stopResize}
      onPointerCancel={stopResize}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        liveWidth.current = bounds.defaultWidth;
        onWidthChange(bounds.defaultWidth);
        onCommit(bounds.defaultWidth);
      }}
    />
  );
}
