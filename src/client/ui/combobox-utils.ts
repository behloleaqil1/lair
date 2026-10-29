/**
 * The rules of the kit's Combobox (Combobox.tsx), apart from it so tests
 * check them without a browser: which options match what was typed, and
 * where the arrow keys move the highlight.
 */

export interface ComboOption {
  value: string;
  label: string;
}

/** Options as {value, label}; plain strings are both */
export function toOptions(options: readonly (string | ComboOption)[]): ComboOption[] {
  return options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
}

/** The options whose label or value contains the query (any case); all of them for an empty query. Prefix matches first. */
export function filterOptions(options: readonly ComboOption[], query: string): ComboOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...options];
  const hits = options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q));
  const starts = (o: ComboOption) => o.label.toLowerCase().startsWith(q) || o.value.toLowerCase().startsWith(q);
  return [...hits.filter(starts), ...hits.filter((o) => !starts(o))];
}

/** The highlighted option after a key, from `index` (-1: none) of `count`; null for a key that doesn't move it. */
export function moveHighlight(index: number, key: string, count: number): number | null {
  if (count <= 0) return key === "ArrowDown" || key === "ArrowUp" ? -1 : null;
  switch (key) {
    case "ArrowDown":
      return index < 0 || index >= count - 1 ? 0 : index + 1;
    case "ArrowUp":
      return index <= 0 ? count - 1 : index - 1;
    default:
      return null;
  }
}
