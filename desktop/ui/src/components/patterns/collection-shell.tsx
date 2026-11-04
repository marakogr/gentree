import { useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Splitter } from "./splitter-view";
import {
  commitCollectionWidth,
  readCollectionWidth,
} from "./collectionLayout";
import type { SplitterBounds } from "./splitter";
import "./patterns.css";

export type CollectionShellProps = {
  /** Persisted width from the section filters, e.g. `filters.listWidth`. */
  storedWidth: unknown;
  /** Writes the rounded width back, e.g. into the section filters map. */
  onCommitWidth: (stored: string) => void;
  bounds: SplitterBounds;
  /** Accessible name of the splitter, already translated. */
  splitterLabel: string;
  /** Accessible name of the list panel, already translated. */
  listLabel: string;
  /** Filter row and page actions. */
  toolbar: ReactNode;
  /** Optional bulk bar or notices between the toolbar and the body. */
  banner?: ReactNode;
  /** List body: table, empty state, loading skeleton. */
  children: ReactNode;
  /** Optional footer, normally the pager. */
  footer?: ReactNode;
  /** Detail pane; when absent the list takes the full width and no splitter renders. */
  detail?: ReactNode;
  detailAs?: "aside" | "section";
  /** Detail wrapper carries `.panel` (Events uses a panel card, Persons an aside). */
  detailPanel?: boolean;
  layoutClassName?: string;
  listClassName?: string;
  detailClassName?: string;
  splitterClassName?: string;
};

/**
 * Master-detail collection frame: toolbar, filter/body/footer slots, splitter
 * and an optional detail pane. Width state lives here; the page only persists
 * the committed value.
 */
export function CollectionShell({
  storedWidth,
  onCommitWidth,
  bounds,
  splitterLabel,
  listLabel,
  toolbar,
  banner,
  children,
  footer,
  detail,
  detailAs = "aside",
  detailPanel = false,
  layoutClassName,
  listClassName,
  detailClassName,
  splitterClassName,
}: CollectionShellProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(() =>
    readCollectionWidth(storedWidth, bounds),
  );
  const [resizing, setResizing] = useState(false);
  const hasDetail = detail !== undefined && detail !== null;

  const commit = (value: number) => {
    const next = commitCollectionWidth(value, bounds);
    setWidth(next.width);
    onCommitWidth(next.stored);
  };

  const detailNode = hasDetail ? (
    detailAs === "section" ? (
      <section className={cn(detailPanel && "panel", detailClassName)}>
        {detail}
      </section>
    ) : (
      <aside className={detailClassName}>{detail}</aside>
    )
  ) : null;

  return (
    <div
      ref={containerRef}
      className={cn(
        "ui-collection",
        layoutClassName,
        !hasDetail && "ui-collection-solo",
        resizing && "ui-collection-resizing",
      )}
      style={
        {
          "--ui-collection-list-width": `${width}%`,
        } as CSSProperties
      }
    >
      <section className={cn("panel", listClassName)} aria-label={listLabel}>
        {toolbar}
        {banner}
        {children}
        {footer}
      </section>

      {hasDetail ? (
        <>
          <Splitter
            className={splitterClassName}
            label={splitterLabel}
            width={width}
            bounds={bounds}
            containerRef={containerRef}
            onWidthChange={setWidth}
            onCommit={commit}
            onResizingChange={setResizing}
          />
          {detailNode}
        </>
      ) : null}
    </div>
  );
}
