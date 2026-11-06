// Shell rhythm evidence for issue #115: the sidebar gutter, the gap between
// page blocks and the page-internal row gap must all come from the same
// `--shell-space` token. Runs inside the WebView, so it may not import.

export function measureShellSpacing() {
  const content = document.querySelector("main.shell > .content");
  const sidebar = document.querySelector("main.shell > .sidebar");
  const panel = content?.querySelector(":scope > section.panel");
  if (!content || !sidebar || !panel) return null;

  const style = getComputedStyle(content);
  const panelStyle = getComputedStyle(panel);
  const contentRect = content.getBoundingClientRect();
  const sidebarRect = sidebar.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const pageFrame = /(^|\s)(persons-page|events-page)(\s|$)/.test(
    panel.className,
  );

  return {
    gutter: Math.round(panelRect.left - sidebarRect.right),
    paddingLeft: Math.round(parseFloat(style.paddingLeft)),
    paddingTop: Math.round(parseFloat(style.paddingTop)),
    gap: Math.round(parseFloat(style.rowGap || style.gap)),
    pageGap: pageFrame
      ? Math.round(parseFloat(panelStyle.rowGap || panelStyle.gap))
      : null,
    contentWidth: Math.round(contentRect.width),
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
}
