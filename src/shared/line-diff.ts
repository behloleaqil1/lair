/**
 * Line diffs for Settings (a save's preview, a 409, the history): Myers'
 * O(ND) algorithm on the lines between the common prefix and suffix, with a
 * bound on the number of edits. Past the bound the diff is the whole middle
 * replaced, so a huge rewrite costs no more than its size.
 */
import type { DiffHunk, DiffLine, LineDiff } from "./settings-types.js";

/** More edits than this (after the common prefix and suffix) and the middle is shown replaced */
export const MAX_DIFF_EDITS = 1000;
const CONTEXT = 3;

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The edit script a -> b, or null when they are more than maxEdits apart. */
function myers(a: string[], b: string[], maxEdits: number): DiffLine[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }
  if (found < 0) return null;

  const reversed: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = vd[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      reversed.push({ op: " ", text: a[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) reversed.push({ op: "+", text: b[prevY] });
      else reversed.push({ op: "-", text: a[prevX] });
    }
    x = prevX;
    y = prevY;
  }
  return reversed.reverse();
}

function toHunks(ops: DiffLine[], context: number): DiffHunk[] {
  const positions: { o: number; n: number }[] = [];
  let oldNo = 1;
  let newNo = 1;
  const changed: number[] = [];
  ops.forEach((op, i) => {
    positions.push({ o: oldNo, n: newNo });
    if (op.op !== "+") oldNo++;
    if (op.op !== "-") newNo++;
    if (op.op !== " ") changed.push(i);
  });
  if (changed.length === 0) return [];

  const hunks: DiffHunk[] = [];
  const emit = (start: number, end: number) => {
    const lines = ops.slice(start, end + 1);
    hunks.push({
      oldStart: positions[start].o,
      oldLines: lines.filter((l) => l.op !== "+").length,
      newStart: positions[start].n,
      newLines: lines.filter((l) => l.op !== "-").length,
      lines,
    });
  };
  const last = ops.length - 1;
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(last, changed[0] + context);
  for (const c of changed.slice(1)) {
    if (c - context <= end + 1) {
      end = Math.min(last, c + context);
    } else {
      emit(start, end);
      start = Math.max(0, c - context);
      end = Math.min(last, c + context);
    }
  }
  emit(start, end);
  return hunks;
}

/** The diff of two texts, line by line, in hunks with three lines of context. */
export function lineDiff(before: string, after: string, maxEdits = MAX_DIFF_EDITS): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const middle = myers(midA, midB, maxEdits);

  const ops: DiffLine[] = [];
  for (let i = 0; i < prefix; i++) ops.push({ op: " ", text: a[i] });
  if (middle) {
    for (const op of middle) ops.push(op);
  } else {
    for (const text of midA) ops.push({ op: "-", text });
    for (const text of midB) ops.push({ op: "+", text });
  }
  for (let i = a.length - suffix; i < a.length; i++) ops.push({ op: " ", text: a[i] });

  const diff: LineDiff = {
    hunks: toHunks(ops, CONTEXT),
    added: ops.filter((l) => l.op === "+").length,
    removed: ops.filter((l) => l.op === "-").length,
  };
  if (!middle) diff.replaced = true;
  return diff;
}

/** The diff as unified-diff text (the hunks only, no file header). */
export function formatDiff(diff: LineDiff): string {
  return diff.hunks
    .map((h) =>
      [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines.map((l) => `${l.op}${l.text}`)].join(
        "\n",
      ),
    )
    .join("\n");
}
