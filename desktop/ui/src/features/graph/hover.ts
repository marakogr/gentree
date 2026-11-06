// Tooltip text for a tree card. The card itself keeps showing its structural
// role (`graph-node-meta`); the tooltip carries only the kinship to the root,
// so the role is deliberately not an input here and can never be appended to
// the label with a separator.

export type CardHoverLabelInput = {
  /** False in the rootless whole-project view, where kinship is not labelled. */
  hasRoot: boolean;
  /** True for the card of the tree root. */
  isRoot: boolean;
  /** Localized kinship to the root, or a nullish value when it is unknown. */
  kinshipLabel: string | null | undefined;
  /** Localized neutral text for an unknown kinship. */
  unknownLabel: string;
};

/**
 * Hover text for one tree card: the kinship to the root or a neutral unknown
 * value, and nothing else. An empty string means "no tooltip"; the card is
 * still named for assistive technology through its `aria-label`.
 */
export function cardHoverLabel({
  hasRoot,
  isRoot,
  kinshipLabel,
  unknownLabel,
}: CardHoverLabelInput): string {
  // The root is related to itself, and the rootless tree has no relation to
  // label, so both stay silent instead of inventing a degree.
  if (!hasRoot || isRoot) return "";
  return kinshipLabel ? kinshipLabel : unknownLabel;
}
