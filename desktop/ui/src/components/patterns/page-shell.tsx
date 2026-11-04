import { createElement } from "react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * Page frame shared by every screen.
 *
 * It emits the foundations markup (`.panel`, `.card-head`, `.page-title`) so a
 * screen does not hand-roll its header, while class overrides keep the
 * existing page-specific styling (`persons-head`, `events-head`, ...).
 */
export type PageShellProps = {
  title: ReactNode;
  /** Badge or count rendered next to the title. */
  titleAside?: ReactNode;
  /** Header controls; pass `actionsClassName={null}` to keep them as siblings. */
  actions?: ReactNode;
  children?: ReactNode;
  /** Extra class on the section that carries `.panel`. */
  className?: string;
  /** Render the outer `.panel` section (default `true`). */
  panel?: boolean;
  /** Render the header inside the panel (default `true`); Path/Graph put it above. */
  headerInPanel?: boolean;
  headerAs?: "div" | "header";
  /** `null` renders the title/actions without a header wrapper. */
  headerClassName?: string | null;
  /** Wrap the title in a div. Defaults to a wrapper when `titleAside` is set. */
  titleGroupClassName?: string | null;
  titleAs?: "h1" | "h2" | "none";
  /** `""` renders the title without a class (Chat used a bare h2). */
  titleClassName?: string;
  titleId?: string;
  /** `null` keeps the actions as siblings instead of wrapping them. */
  actionsClassName?: string | null;
  "aria-labelledby"?: string;
};

export function PageShell({
  title,
  titleAside,
  actions,
  children,
  className,
  panel = true,
  headerInPanel = true,
  headerAs = "div",
  headerClassName = "card-head",
  titleGroupClassName,
  titleAs = "h1",
  titleClassName = "page-title",
  titleId,
  actionsClassName = "page-head-actions",
  "aria-labelledby": ariaLabelledBy,
}: PageShellProps) {
  const titleNode =
    titleAs === "none"
      ? title
      : createElement(
          titleAs,
          { id: titleId, className: titleClassName || undefined },
          title,
        );

  const wrapTitle = titleAside !== undefined || titleGroupClassName !== undefined;
  const titleBlock = wrapTitle ? (
    <div className={titleGroupClassName || undefined}>
      {titleNode}
      {titleAside}
    </div>
  ) : (
    titleNode
  );

  const actionsBlock =
    actions === undefined
      ? null
      : actionsClassName === null
        ? actions
        : <div className={actionsClassName || undefined}>{actions}</div>;

  const headerContent = (
    <>
      {titleBlock}
      {actionsBlock}
    </>
  );

  const header =
    headerClassName === null ? (
      headerContent
    ) : headerAs === "header" ? (
      <header className={headerClassName || undefined}>{headerContent}</header>
    ) : (
      <div className={headerClassName || undefined}>{headerContent}</div>
    );

  if (!panel) {
    return (
      <>
        {header}
        {children}
      </>
    );
  }

  const body = (
    <section
      className={cn("panel", className)}
      aria-labelledby={ariaLabelledBy}
    >
      {headerInPanel ? header : null}
      {children}
    </section>
  );

  if (headerInPanel) return body;

  return (
    <>
      {header}
      {body}
    </>
  );
}
