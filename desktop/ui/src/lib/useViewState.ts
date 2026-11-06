// React binding for the persisted per-project view state (see lib/viewState.ts).
// Pure validation/normalisation lives in viewState.ts; this module only wires it
// to React state, debounced localStorage writes and scroll restoration.
//
// The state is stored together with the project it belongs to. A project switch
// therefore loads the target project's stored section instead of keeping the
// previous project's values - A -> B -> A restores A's filters, and B only ever
// sees its own (issue #107).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_VIEW_STATE,
  loadSectionView,
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

/** The loaded section plus the project it belongs to. */
type LoadedSection = {
  projectId: string;
  section: SectionKey;
  state: SectionViewState;
};

/** Writes one section of the project it was loaded for. Never throws. */
function persistSection(loaded: LoadedSection): void {
  if (loaded.projectId === "" || typeof window === "undefined") return;
  const views = readProjectViews(loaded.projectId);
  views[loaded.section] = loaded.state;
  writeProjectViews(loaded.projectId, views);
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
  const [loaded, setLoaded] = useState<LoadedSection>(() => ({
    projectId,
    section,
    state: loadSectionView(projectId, section),
  }));
  const state = loaded.state;

  // Opening another project replaces the section with that project's own
  // stored values; the values of the project being left are written first so
  // the last edit of a session is not dropped.
  useEffect(() => {
    if (loaded.projectId === projectId && loaded.section === section) return;
    persistSection(loaded);
    setLoaded({
      projectId,
      section,
      state: loadSectionView(projectId, section),
    });
  }, [projectId, section, loaded]);

  const patch = useCallback((next: ViewPatch) => {
    setLoaded((previous) => ({
      ...previous,
      state: mergeViewState(
        typeof next === "function"
          ? next(previous.state)
          : { ...previous.state, ...next },
      ),
    }));
  }, []);

  const reset = useCallback(() => {
    setLoaded((previous) => ({
      ...previous,
      state: mergeViewState(DEFAULT_VIEW_STATE),
    }));
  }, []);

  useEffect(() => {
    // The render right after a switch still holds the previous project's
    // values for one commit: never write them under the new project's key.
    if (loaded.projectId !== projectId) return;
    if (typeof window === "undefined") return;
    const timer = window.setTimeout(() => persistSection(loaded), 200);
    return () => window.clearTimeout(timer);
  }, [loaded, projectId]);

  // Flush synchronously on unmount: switching tabs faster than the debounce
  // must not drop the last query/page/scroll offset.
  const latest = useRef(loaded);
  latest.current = loaded;
  useEffect(() => () => persistSection(latest.current), []);

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
