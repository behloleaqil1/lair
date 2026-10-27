/**
 * Sorting and keyboard moves for the dashboard's one table component
 * (components/DataTable.tsx), apart from it so tests check the same rules.
 */

export type SortDir = "asc" | "desc";
export type SortValue = string | number | boolean | null | undefined;

export interface SortState {
  key: string;
  dir: SortDir;
}

/** Numbers by value, text by locale and numerically ("run 2" before "run 10"); empty values last either way. */
export function compareValues(a: SortValue, b: SortValue): number {
  const emptyA = a === null || a === undefined || a === "";
  const emptyB = b === null || b === undefined || b === "";
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? -1 : 1;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/** The rows in `dir` order of `value`; rows with equal values keep their order. Empty values stay last. */
export function sortRows<T>(rows: readonly T[], value: (row: T) => SortValue, dir: SortDir): T[] {
  return rows
    .map((row, index) => ({ row, index, v: value(row) }))
    .sort((x, y) => {
      const emptyX = x.v === null || x.v === undefined || x.v === "";
      const emptyY = y.v === null || y.v === undefined || y.v === "";
      if (emptyX !== emptyY) return emptyX ? 1 : -1;
      const c = compareValues(x.v, y.v);
      return (dir === "asc" ? c : -c) || x.index - y.index;
    })
    .map((x) => x.row);
}

/** A click on a column header: sort by it ascending, or flip it when it already sorts. */
export function nextSort(current: SortState | null, key: string): SortState {
  if (current && current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: "asc" };
}

/** aria-sort for a header */
export function ariaSort(current: SortState | null, key: string): "ascending" | "descending" | "none" {
  if (!current || current.key !== key) return "none";
  return current.dir === "asc" ? "ascending" : "descending";
}

/** The row a key moves the focus to from row `index` of `count`, or null for a key that doesn't move it. */
export function moveFocus(index: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
      return Math.min(count - 1, index + 1);
    case "ArrowUp":
      return Math.max(0, index - 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Does this key open the focused row? */
export function opensRow(key: string): boolean {
  return key === "Enter" || key === " ";
}
