import { ArrowDownRegular, ArrowUpRegular } from "@fluentui/react-icons";

export type SortDirection = "asc" | "desc";

/** Direction arrow of the active sort column. */
export function SortIcon({ direction }: { direction: SortDirection }) {
  return direction === "asc" ? (
    <ArrowUpRegular fontSize={12} aria-hidden="true" />
  ) : (
    <ArrowDownRegular fontSize={12} aria-hidden="true" />
  );
}
