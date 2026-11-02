import { createContext, useCallback, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import {
  Button,
  Toast,
  ToastFooter,
  ToastTitle,
  ToastTrigger,
  Toaster,
  useToastController,
} from "@fluentui/react-components";
import { DismissRegular } from "@fluentui/react-icons";

export type ToastKind = "success" | "error" | "info";

/** Optional inline action, e.g. "Show in folder" after a backup. */
export type ToastAction = {
  label: string;
  onSelect: () => void;
};

export type ToastApi = {
  notify: (kind: ToastKind, message: string, action?: ToastAction) => void;
  success: (message: string, action?: ToastAction) => void;
  error: (message: string, action?: ToastAction) => void;
  info: (message: string, action?: ToastAction) => void;
};

const TOAST_TIMEOUT_MS = 4000;
/** Actions need more time to be clicked than a plain message needs to be read. */
const TOAST_ACTION_TIMEOUT_MS = 12000;
/** More simultaneous toasts would cover the screens they report about. */
const TOAST_LIMIT = 3;

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({
  children,
  closeLabel = "Close",
}: {
  children: ReactNode;
  /** Accessible name for the close button; pass the localized label. */
  closeLabel?: string;
}) {
  const { dispatchToast } = useToastController();

  const notify = useCallback(
    (kind: ToastKind, message: string, action?: ToastAction) => {
      dispatchToast(
        <Toast>
          <ToastTitle
            action={
              // Fluent Button already has native button semantics.
              <ToastTrigger disableButtonEnhancement>
                <Button
                  appearance="transparent"
                  size="small"
                  icon={<DismissRegular />}
                  aria-label={closeLabel}
                  title={closeLabel}
                />
              </ToastTrigger>
            }
          >
            {message}
          </ToastTitle>
          {action ? (
            <ToastFooter>
              {/* ToastTrigger dismisses the toast after the action runs. */}
              <ToastTrigger disableButtonEnhancement>
                <Button
                  appearance="transparent"
                  size="small"
                  onClick={action.onSelect}
                >
                  {action.label}
                </Button>
              </ToastTrigger>
            </ToastFooter>
          ) : null}
        </Toast>,
        {
          intent: kind,
          timeout: action ? TOAST_ACTION_TIMEOUT_MS : TOAST_TIMEOUT_MS,
          politeness: kind === "error" ? "assertive" : "polite",
        },
      );
    },
    [closeLabel, dispatchToast],
  );

  const api = useMemo<ToastApi>(
    () => ({
      notify,
      success: (message: string, action?: ToastAction) =>
        notify("success", message, action),
      error: (message: string, action?: ToastAction) =>
        notify("error", message, action),
      info: (message: string, action?: ToastAction) =>
        notify("info", message, action),
    }),
    [notify],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Toaster
        position="bottom-end"
        limit={TOAST_LIMIT}
        pauseOnHover
        pauseOnWindowBlur
      />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return context;
}
