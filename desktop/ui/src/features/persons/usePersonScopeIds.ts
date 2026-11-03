// Resolves the person set for the "person scope" filter: the chosen person,
// their ancestors, descendants, or both. Uses the existing parent/child graph
// commands; nothing is invented and every returned node id is real.

import { useEffect, useState } from "react";
import { graphApi } from "../../api/client";
import type { EventPersonScope } from "../events/helpers";

/** Ask the graph commands for the whole walk; both commands clamp the depth. */
const MAX_DEPTH = 99;

export function usePersonScopeIds(
  personId: string,
  scope: EventPersonScope,
): ReadonlySet<string> | null {
  const [ids, setIds] = useState<ReadonlySet<string> | null>(null);

  useEffect(() => {
    if (personId === "") {
      setIds(null);
      return;
    }
    if (scope === "person") {
      setIds(new Set([personId]));
      return;
    }

    let active = true;
    const needAncestors = scope !== "descendants";
    const needDescendants = scope !== "ancestors";
    void Promise.all([
      needAncestors
        ? graphApi.ancestors({ rootPersonId: personId, generations: MAX_DEPTH })
        : null,
      needDescendants
        ? graphApi.descendants({
            rootPersonId: personId,
            generations: MAX_DEPTH,
          })
        : null,
    ])
      .then(([ancestors, descendants]) => {
        if (!active) return;
        const next = new Set<string>([personId]);
        for (const node of [
          ...(ancestors?.nodes ?? []),
          ...(descendants?.nodes ?? []),
        ]) {
          if (node.personId) next.add(node.personId);
        }
        setIds(next);
      })
      .catch(() => {
        // A failed walk falls back to the person alone instead of hiding data.
        if (active) setIds(new Set([personId]));
      });

    return () => {
      active = false;
    };
  }, [personId, scope]);

  return ids;
}
