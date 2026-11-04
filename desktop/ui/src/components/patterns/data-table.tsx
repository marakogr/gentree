import type { HTMLAttributes, ReactNode } from "react";
import {
  Checkbox,
  Table,
  TableCell,
  TableHeaderCell,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { columnWidthStyle, type ColumnWidths } from "../../lib/tableColumns";
import { cn } from "../../lib/utils";
import { SortIcon, type SortDirection } from "./sort-icon";
import { fluentSortDirection } from "./tableState";

const useStyles = makeStyles({
  // The page CSS still owns page-specific chrome (sticky shadow, borders); the
  // shell owns the fixed layout and the shared header behaviour.
  table: {
    tableLayout: "fixed",
    width: "100%",
    "& th": {
      position: "sticky",
      top: 0,
      zIndex: 1,
      backgroundColor: tokens.colorNeutralBackground1,
    },
    "& td, & th": {
      overflow: "hidden",
    },
  },
  // The sortable header cell owns a flex button; keep the label on the start
  // edge like every other header.
  sortButton: {
    justifyContent: "flex-start",
  },
});

export type DataTableProps = {
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
  busy?: boolean;
};

/** Table shell shared by every list screen. */
export function DataTable({
  children,
  className,
  ariaLabel,
  busy = false,
}: DataTableProps) {
  const styles = useStyles();
  return (
    <Table
      size="small"
      className={cn(styles.table, className)}
      aria-label={ariaLabel}
      aria-busy={busy || undefined}
    >
      {children}
    </Table>
  );
}

export type DataTableColgroupProps = {
  columns: readonly string[];
  widths: ColumnWidths;
  /** Include the leading bulk-selection column (default `true`). */
  selection?: boolean;
  /** Extra class per column, for page-specific default widths. */
  columnClassName?: (column: string) => string | undefined;
};

/** `<colgroup>` built from the visible columns and the stored widths. */
export function DataTableColgroup({
  columns,
  widths,
  selection = true,
  columnClassName,
}: DataTableColgroupProps) {
  return (
    <colgroup>
      {selection ? <col className="bulk-select-col" /> : null}
      {columns.map((column) => (
        <col
          key={column}
          className={columnClassName?.(column)}
          style={columnWidthStyle(widths, column)}
        />
      ))}
    </colgroup>
  );
}

export type HeaderCellProps = {
  children: ReactNode;
  /** Makes the cell sortable; omit for a plain header. */
  onSort?: () => void;
  /** Sort direction when this column is active; omit when inactive. */
  direction?: SortDirection;
  /** Resize handle from `columnResizeHandle`, rendered in Fluent's aside slot. */
  aside?: HTMLAttributes<HTMLSpanElement>;
  className?: string;
};

/** Sortable and/or resizable header cell. */
export function HeaderCell({
  children,
  onSort,
  direction,
  aside,
  className,
}: HeaderCellProps) {
  const styles = useStyles();
  const active = direction !== undefined;
  return (
    <TableHeaderCell
      sortable={onSort !== undefined}
      sortDirection={fluentSortDirection(active, direction ?? "asc")}
      sortIcon={active ? <SortIcon direction={direction} /> : undefined}
      button={
        onSort ? { className: styles.sortButton, onClick: onSort } : undefined
      }
      aside={aside}
      className={className}
    >
      {children}
    </TableHeaderCell>
  );
}

export type SelectionHeaderCellProps = {
  checked: boolean | "mixed";
  onChange: (checked: boolean) => void;
  label: string;
};

/** Leading header cell with the select-page checkbox. */
export function SelectionHeaderCell({
  checked,
  onChange,
  label,
}: SelectionHeaderCellProps) {
  return (
    <TableHeaderCell className="bulk-select-cell">
      <Checkbox
        checked={checked}
        onChange={(_event, data) => onChange(data.checked === true)}
        aria-label={label}
      />
    </TableHeaderCell>
  );
}

export type SelectionCellProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
};

/** Leading row cell that never triggers the row click. */
export function SelectionCell({
  checked,
  onChange,
  label,
}: SelectionCellProps) {
  return (
    <TableCell
      className="bulk-select-cell"
      onClick={(event) => event.stopPropagation()}
    >
      <Checkbox
        checked={checked}
        onChange={(_event, data) => onChange(data.checked === true)}
        aria-label={label}
      />
    </TableCell>
  );
}
