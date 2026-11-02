// First-run tour state. It is a local UI preference, like the theme cache in
// `lib/theme.ts`: no project data and no backend config are touched.

export const TOUR_STORAGE_KEY = "gentree.onboarding.v1";

/** The tour is done (finished or skipped) once this key is present. */
function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function tourCompleted(): boolean {
  try {
    return storage()?.getItem(TOUR_STORAGE_KEY) === "done";
  } catch {
    return false;
  }
}

export function markTourCompleted(): void {
  try {
    storage()?.setItem(TOUR_STORAGE_KEY, "done");
  } catch {
    // A blocked storage must not break the app: the tour just offers itself
    // again on the next launch.
  }
}

export function resetTour(): void {
  try {
    storage()?.removeItem(TOUR_STORAGE_KEY);
  } catch {
    // Same as above.
  }
}

/**
 * Auto-start only on a real first run: never when it is already done, and
 * never under WebDriver, where an overlay would obstruct scripted reviews.
 */
export function shouldAutoStartTour(
  completed: boolean,
  automated: boolean,
): boolean {
  return !completed && !automated;
}
