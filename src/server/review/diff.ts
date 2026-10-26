/**
 * Unified diff hunks, as the git host returns them per file
 * (`@@ -a,b +c,d @@` sections), with old and new line numbers.
 */

export type DiffLineKind = "add" | "del" | "ctx";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

/** A run of changed lines between context lines: what was removed and what replaced it. */
export interface ChangeBlock {
  removed: DiffLine[];
  added: DiffLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parsePatch(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const rows = patch.split(/\r?\n/);
  if (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();

  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const row of rows) {
    const header = HUNK_HEADER.exec(row);
    if (header) {
      current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] };
      hunks.push(current);
      oldLine = current.oldStart;
      newLine = current.newStart;
      continue;
    }
    // File headers before the first hunk, and "\ No newline at end of file"
    if (!current || row.startsWith("\\")) continue;
    const marker = row[0];
    const text = row.slice(1);
    if (marker === "+") {
      current.lines.push({ kind: "add", text, oldLine: null, newLine: newLine++ });
    } else if (marker === "-") {
      current.lines.push({ kind: "del", text, oldLine: oldLine++, newLine: null });
    } else {
      current.lines.push({ kind: "ctx", text: marker === " " ? text : row, oldLine: oldLine++, newLine: newLine++ });
    }
  }
  return hunks;
}

export function changeBlocks(hunks: DiffHunk[]): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  for (const hunk of hunks) {
    let block: ChangeBlock | null = null;
    for (const line of hunk.lines) {
      if (line.kind === "ctx") {
        block = null;
        continue;
      }
      if (!block) {
        block = { removed: [], added: [] };
        blocks.push(block);
      }
      (line.kind === "add" ? block.added : block.removed).push(line);
    }
  }
  return blocks;
}

/** Every added line, with its line number in the new file. */
export function addedLines(hunks: DiffHunk[]): DiffLine[] {
  return hunks.flatMap((h) => h.lines.filter((l) => l.kind === "add"));
}

export function removedLines(hunks: DiffHunk[]): DiffLine[] {
  return hunks.flatMap((h) => h.lines.filter((l) => l.kind === "del"));
}
