import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DismissRegular } from "@fluentui/react-icons";
import { Button } from "../../components/ui/button";
import { placeBubble, type Box } from "./place";
import type { TourStep } from "./steps";
import "./onboarding.css";

type Props = {
  open: boolean;
  step: TourStep;
  index: number;
  total: number;
  /** The create step waits until a project exists. */
  projectOpen: boolean;
  onNext: () => void;
  onBack: () => void;
  onClose: () => void;
};

function viewportSize() {
  if (typeof window === "undefined") return { width: 0, height: 0 };
  return { width: window.innerWidth, height: window.innerHeight };
}

function toBox(rect: DOMRect): Box {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

export function TourOverlay({
  open,
  step,
  index,
  total,
  projectOpen,
  onNext,
  onBack,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const bubbleRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [rect, setRect] = useState<Box | null>(null);
  const [bubbleSize, setBubbleSize] = useState({ width: 360, height: 220 });
  const [viewport, setViewport] = useState(viewportSize);

  const selector = step.target ? `[data-tour="${step.target}"]` : null;
  const first = index <= 0;
  const last = index >= total - 1;
  const waitingForProject = step.id === "create" && !projectOpen;

  // Measured for a short burst after each step, then on scroll and resize:
  // screens mount their buttons asynchronously, so one read is not enough.
  useEffect(() => {
    if (!open || !selector) {
      setRect(null);
      return;
    }
    let frame = 0;
    let attempts = 0;
    let timer = 0;

    const measure = () => {
      const element = document.querySelector(selector);
      if (element) {
        const next = toBox(element.getBoundingClientRect());
        setRect((current) =>
          current &&
          current.left === next.left &&
          current.top === next.top &&
          current.width === next.width &&
          current.height === next.height
            ? current
            : next,
        );
      } else {
        setRect(null);
      }
      attempts += 1;
      if (attempts < 45) {
        frame = window.requestAnimationFrame(measure);
      }
    };

    const refresh = () => {
      window.cancelAnimationFrame(frame);
      attempts = 0;
      frame = window.requestAnimationFrame(measure);
    };

    measure();
    timer = window.setTimeout(() => {
      const element = document.querySelector(selector);
      if (element) {
        element.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    }, 40);

    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", refresh, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refresh, true);
    };
  }, [open, selector, step.id]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => setViewport(viewportSize());
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  // The bubble is a dialog: focus it on every step so keyboard users hear the
  // new text, and give focus back when the tour closes.
  useEffect(() => {
    if (!open) return;
    bubbleRef.current?.focus();
  }, [open, step.id]);

  useEffect(() => {
    if (open) {
      previousFocus.current = document.activeElement as HTMLElement | null;
      return;
    }
    previousFocus.current?.focus?.();
    previousFocus.current = null;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useLayoutEffect(() => {
    if (!open) return;
    const bubble = bubbleRef.current;
    if (!bubble) return;
    const next = { width: bubble.offsetWidth, height: bubble.offsetHeight };
    setBubbleSize((current) =>
      current.width === next.width && current.height === next.height
        ? current
        : next,
    );
  }, [open, step.id, t]);

  if (!open) return null;

  const point = placeBubble(rect, bubbleSize, viewport, step.placement);
  const progress = total > 0 ? ((index + 1) / total) * 100 : 0;

  return (
    <div className="tour-layer">
      {rect ? (
        <div
          className="tour-spotlight"
          aria-hidden="true"
          style={{
            left: rect.left - 6,
            top: rect.top - 6,
            width: rect.width + 12,
            height: rect.height + 12,
          }}
        />
      ) : (
        <div className="tour-scrim" aria-hidden="true" />
      )}

      <div
        ref={bubbleRef}
        className={
          point.centered ? "tour-bubble tour-bubble-centered" : "tour-bubble"
        }
        style={{ left: point.left, top: point.top }}
        role="dialog"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        tabIndex={-1}
      >
        <div className="tour-bubble-head">
          <span className="tour-count">
            {t("onboarding:stepOf", { current: index + 1, total })}
          </span>
          <button type="button" className="tour-skip" onClick={onClose}>
            <DismissRegular fontSize={14} aria-hidden="true" />
            {t("onboarding:skip")}
          </button>
        </div>

        <div className="tour-progress" aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </div>

        <h2 className="tour-title" id="tour-title">
          {t(`onboarding:${step.id}Title`)}
        </h2>
        <p className="tour-body" id="tour-body">
          {t(`onboarding:${step.id}Body`)}
        </p>

        {step.id === "welcome" ? (
          <p className="tour-hint">{t("onboarding:welcomeHint")}</p>
        ) : null}
        {waitingForProject ? (
          <p className="tour-waiting">{t("onboarding:createWaiting")}</p>
        ) : null}

        <div className="tour-actions">
          <Button variant="ghost" size="sm" disabled={first} onClick={onBack}>
            {t("onboarding:back")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={waitingForProject}
            onClick={last ? onClose : onNext}
          >
            {last ? t("onboarding:finish") : t("onboarding:next")}
          </Button>
        </div>
      </div>
    </div>
  );
}
