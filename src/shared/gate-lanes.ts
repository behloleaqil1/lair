/**
 * Gate lanes, shared by the gate parser (src/server/parsers/gates.ts) and the
 * Gates view. A lane is whatever the queue file names say
 * (<lane>.<priority>.<gate-id>.req), not a fixed list: heavy, light and
 * remote are listed first because most projects have them, then any other
 * lane (quick, actions, ...) by name.
 */

/** The lanes most projects have: listed first, in this order */
export const LANE_ORDER: readonly string[] = ["heavy", "light", "remote"];

/** The lanes `items` name: those of LANE_ORDER first, then the others by name. */
export function laneNames(items: readonly { lane: string }[]): string[] {
  const seen = new Set(items.map((item) => item.lane));
  const known = LANE_ORDER.filter((lane) => seen.has(lane));
  const others = [...seen].filter((lane) => !LANE_ORDER.includes(lane)).sort();
  return [...known, ...others];
}
