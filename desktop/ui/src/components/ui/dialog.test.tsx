import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { Dialog } from "./dialog";

// Fluent renders a modal into a client-side portal, which is empty on the
// server. The dialog chrome is replaced with plain elements so the header
// contract (title, optional close control, content and footer order) is
// visible in static markup; the kit components keep their real implementation.
vi.mock("@fluentui/react-components", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@fluentui/react-components")>();
  const Box = ({
    children,
    className,
  }: {
    children?: ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>;
  return {
    ...actual,
    Dialog: Box,
    DialogSurface: Box,
    DialogBody: Box,
    DialogContent: Box,
    DialogActions: Box,
    DialogTitle: ({
      children,
      className,
    }: {
      children?: ReactNode;
      className?: string;
    }) => <h2 className={className}>{children}</h2>,
  };
});

const noop = () => undefined;

function renderDialog(closeLabel?: string): string {
  return renderToStaticMarkup(
    <Dialog
      open
      title="Событие"
      onClose={noop}
      closeLabel={closeLabel}
      footer={<button type="button">Отмена</button>}
    >
      <p>Основные поля</p>
    </Dialog>,
  );
}

describe("Dialog header close control (#131)", () => {
  it("renders a labelled close control at the end of the title row", () => {
    const html = renderDialog("Закрыть");
    const title = html.indexOf("Событие");
    const close = html.indexOf('aria-label="Закрыть"');
    const content = html.indexOf("ui-dialog-content");
    const footer = html.indexOf("ui-dialog-footer");
    expect(title).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(title);
    // Outside the scrollable body, and before the unchanged footer.
    expect(close).toBeLessThan(content);
    expect(content).toBeLessThan(footer);
    expect(html).toContain(">Отмена<");
  });

  it("does not add a header close control unless asked", () => {
    expect(renderDialog()).not.toContain('aria-label="Закрыть"');
  });
});
