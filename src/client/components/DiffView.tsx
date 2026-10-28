/**
 * A line diff (src/shared/line-diff.ts) as unified-diff text, added lines
 * green and removed lines red.
 */
import type { LineDiff } from "../../shared/settings-types";

export function DiffView({ diff, empty = "No changes" }: { diff: LineDiff; empty?: string }) {
  if (diff.hunks.length === 0) return <p className="muted small">{empty}</p>;
  return (
    <div data-diff="">
      <p className="muted small">
        +{diff.added} −{diff.removed}
        {diff.replaced ? " (too different to compare line by line: shown replaced)" : ""}
      </p>
      <pre className="code-block code-block-nowrap diff" tabIndex={0} aria-label="Changes">
        {diff.hunks.map((hunk, i) => (
          <div key={i}>
            <div className="muted">
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
            </div>
            {hunk.lines.map((line, j) => (
              <div key={j} className={line.op === "+" ? "diff-line text-success" : line.op === "-" ? "diff-line text-danger" : "diff-line"}>
                {line.op}
                {line.text}
              </div>
            ))}
          </div>
        ))}
      </pre>
    </div>
  );
}
