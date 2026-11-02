// React binding for the persisted per-project view state (see lib/viewState.ts).
// Pure validation/normalisation lives in viewState.ts; this module only wires it
// to React state, debounced localStorage writes and scroll restoration.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_VIEW_STATE,
  mergeViewState,
  readProjectViews,
  writeProjectViews,
  type SectionKey,
  type SectionViewState,
} from "./viewState";

export type { SectionKey, SectionViewState };

export type ViewPatch =
  | Partial<SectionViewState>
  | ((previous: SectionViewState) => SectionViewState);

function initial(projectId: string, section: SectionKey): SectionViewState {
  const stored = readProjectViews(projectId)[section];
  return stored
    ? mergeViewState(stored)
    : { ...DEFAULT_VIEW_STATE, filters: {} };
}

export type UseViewState = {
  state: SectionViewState;
  patch: (patch: ViewPatch) => void;
  reset: () => void;
};

/** Section state that survives tab switches and app restarts, per project. */
export function useViewState(
  projectId: string,
  section: SectionKey,
): UseViewState {
  const [state, setState] = useState<SectionViewState>(() =>
    initial(projectId, section),
  );

  // Switching project must not leak the previous project's filters.
  useEffect(() => {
    setState(initial(projectId, section));
  }, [projectId, section]);

  useEffect(() => {
    if (projectId === "") return;
    if (typeof window === "undefined") return;
    const timer = window.setTimeout(() => {
      const views = readProjectViews(projectId);
      views[section] = state;
      writeProjectViews(projectId, views);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [projectId, section, state]);

  // Flush synchronously on unmount: switching tabs faster than the debounce
  // must not drop the last query/page/scroll offset.
  const latest = useRef(state);
  latest.current = state;
  useEffect(
    () => () => {
      if (projectId === "" || typeof window === "undefined") return;
      const views = readProjectViews(projectId);
      views[section] = latest.current;
      writeProjectViews(projectId, views);
    },
    [projectId, section],
  );

  const patch = useCallback((next: ViewPatch) => {
    setState((previous) =>
      mergeViewState(
        typeof next === "function" ? next(previous) : { ...previous, ...next },
      ),
    );
  }, []);

  const reset = useCallback(() => {
    setState({ ...DEFAULT_VIEW_STATE, filters: {} });
  }, []);

  return { state, patch, reset };
}

type ScrollHandlers = {
  scrollTop: number;
  onScrollTop: (value: number) => void;
  ready: boolean;
};

/**
 * Ref callback for the section's scroll container: saves `scrollTop` through
 * rAF throttling and restores the stored offset once, when content is ready.
 */
export function useScrollMemory({
  scrollTop,
  onScrollTop,
  ready,
}: ScrollHandlers) {
  const element = useRef<HTMLElement | null>(null);
  const attached = useRef<(() => void) | null>(null);
  const frame = useRef<number | null>(null);
  const restored = useRef(false);
  const readyRef = useRef(ready);
  readyRef.current = ready;

  useEffect(() => {
    restored.current = false;
  }, [ready]);

  useEffect(() => {
    if (!ready || restored.current) return;
    const node = element.current;
    if (!node) return;
    restored.current = true;
    if (scrollTop > 0) node.scrollTop = scrollTop;
  }, [ready, scrollTop]);

  useEffect(
    () => () => {
      if (frame.current !== null) {
        window.cancelAnimationFrame(frame.current);
      }
    },
    [],
  );

  return useCallback(
    (node: HTMLElement | null) => {
      const previous = element.current;
      if (previous) {
        if (attached.current) {
          previous.removeEventListener("scroll", attached.current);
        }
        // Keep the offset of a container that is being detached.
        if (readyRef.current) onScrollTop(previous.scrollTop);
      }
      attached.current = null;
      element.current = node;
      if (!node) return;

      const handleScroll = () => {
        // Ignore clamping while the list is replaced by a skeleton: the
        // transient zero height would otherwise overwrite the saved offset.
        if (!readyRef.current) return;
        if (frame.current !== null) window.cancelAnimationFrame(frame.current);
        frame.current = window.requestAnimationFrame(() => {
          onScrollTop(node.scrollTop);
        });
      };

      attached.current = handleScroll;
      node.addEventListener("scroll", handleScroll, { passive: true });
    },
    [onScrollTop],
  );
}
