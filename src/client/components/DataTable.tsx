/**
 * The dashboard's one table: sortable columns (click a header; again to
 * flip), and rows that open their detail on click, Enter or Space. Rows are
 * focusable; the arrow keys, Home and End move between them.
 */
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ariaSort, moveFocus, nextSort, opensRow, sortRows, type SortState, type SortValue } from "../table";

export interface Column<T> {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  /** The value the column sorts by; without one it does not sort */
  sort?: (row: T) => SortValue;
  /** Right-aligned numbers, narrow columns */
  align?: "left" | "right";
}

interface Props<T> {
  /** What the table lists, for screen readers ("Agents") */
  label: string;
  columns: Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** Open a row's detail; without it rows are not interactive */
  onOpen?: (row: T) => void;
  /** The key of the row whose detail is open */
  selected?: string | null;
  /** Shown instead of the table when there are no rows: what to do */
  empty: ReactNode;
  initialSort?: SortState;
}

export function DataTable<T>({ label, columns, rows, rowKey, onOpen, selected, empty, initialSort }: Props<T>) {
  const [sort, setSort] = useState<SortState | null>(initialSort ?? null);
  const body = useRef<HTMLTableSectionElement>(null);

  const sorted = useMemo(() => {
    const column = sort ? columns.find((c) => c.key === sort.key) : undefined;
    return column?.sort ? sortRows(rows, column.sort, sort!.dir) : [...rows];
  }, [rows, columns, sort]);

  if (rows.length === 0) return <div className="table-empty">{empty}</div>;

  const onKey = (event: KeyboardEvent<HTMLTableRowElement>, index: number, row: T) => {
    if (opensRow(event.key) && onOpen) {
      event.preventDefault();
      onOpen(row);
      return;
    }
    const next = moveFocus(index, event.key, sorted.length);
    if (next !== null) {
      event.preventDefault();
      body.current?.querySelectorAll<HTMLTableRowElement>("tr")[next]?.focus();
    }
  };

  return (
    <div className="table-wrap">
      <table className="table" aria-label={label}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                aria-sort={column.sort ? ariaSort(sort, column.key) : undefined}
                style={column.align === "right" ? { textAlign: "right" } : undefined}
              >
                {column.sort ? (
                  <button type="button" className="th-sort" onClick={() => setSort(nextSort(sort, column.key))}>
                    {column.label}
                    <span aria-hidden="true" className="th-sort-mark">
                      {sort?.key === column.key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                    </span>
                  </button>
                ) : (
                  column.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody ref={body}>
          {sorted.map((row, index) => {
            const key = rowKey(row);
            return (
              <tr
                key={key}
                className={onOpen ? `clickable${selected === key ? " selected" : ""}` : undefined}
                tabIndex={onOpen ? 0 : undefined}
                aria-selected={onOpen ? selected === key : undefined}
                onClick={onOpen ? () => onOpen(row) : undefined}
                onKeyDown={onOpen ? (e) => onKey(e, index, row) : undefined}
              >
                {columns.map((column) => (
                  <td key={column.key} style={column.align === "right" ? { textAlign: "right" } : undefined}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
