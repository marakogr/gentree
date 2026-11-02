// Path step wording: the word for an edge describes the person it points at,
// so `UP` reads "father/mother", `DOWN` "son/daughter", `SPOUSE`
// "husband/wife/partner". Keys live in the `path` namespace.
// The same directions are turned into kinship edges/links so the page can
// render a human chain and a descriptive term for alternative routes.

import type {
  EdgeDirection,
  Gender,
  KinshipEdge,
  PathStep,
  Person,
} from "../../api/types";

export type StepWordKey = `step.${EdgeDirection}.${Gender}`;

export function stepWordKey(
  direction: EdgeDirection,
  gender: Gender,
): StepWordKey {
  return `step.${direction}.${gender}`;
}

/** One hop of the readable chain: "wife Valentina", "father Dmitry". */
export type PathChainLink = {
  direction: EdgeDirection;
  personId: string;
  gender: Gender;
};

export function pathChainLinks(
  path: readonly PathStep[],
  genderOf: (personId: string) => Gender,
): PathChainLink[] {
  const links: PathChainLink[] = [];
  for (let index = 0; index < path.length - 1; index += 1) {
    const direction = path[index].edgeToNext;
    if (!direction) continue;
    const personId = path[index + 1].personId;
    links.push({ direction, personId, gender: genderOf(personId) });
  }
  return links;
}

/**
 * Direction-only re-creation of the resolved edges for a route. Used to get a
 * descriptive term for alternatives, which carry no `KinshipDescriptor`.
 */
export function edgesFromPath(
  path: readonly PathStep[],
  genderOf: (personId: string) => Gender,
): KinshipEdge[] {
  const edges: KinshipEdge[] = [];
  for (let index = 0; index < path.length - 1; index += 1) {
    const direction = path[index].edgeToNext;
    if (!direction) continue;
    const from = path[index].personId;
    const to = path[index + 1].personId;
    edges.push({
      from,
      to,
      kind:
        direction === "UP"
          ? "PARENT"
          : direction === "DOWN"
            ? "CHILD"
            : "SPOUSE",
      fromGender: genderOf(from),
      toGender: genderOf(to),
      adoptive: false,
    });
  }
  return edges;
}

/** Compact name for the chain: given name first, then surname. */
export function chainName(person: Person | undefined, fallback: string): string {
  const primary =
    person?.names.find((name) => name.isPrimary) ?? person?.names[0];
  if (!primary) return fallback;
  return primary.given ?? primary.surname ?? fallback;
}
