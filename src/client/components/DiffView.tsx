/**
 * A line diff (src/shared/line-diff.ts) as unified-diff text, added lines
 * green and removed lines red.
 */
import type { LineDiff } from "../../shared/settings-types";

const muted = { color: "var(--text-secondary)", fontSize: "0.85rem" };

export function DiffView({ diff, empty = "No changes" }: { diff: LineDiff; empty?: string }) {
  if (diff.hunks.length === 0) return <p style={muted}>{empty}</p>;
  return (
    <div data-diff="">
      <p style={muted}>
        +{diff.added} −{diff.removed}
        {diff.replaced ? " (too different to compare line by line: shown replaced)" : ""}
      </p>
      <pre
        style={{
          overflowX: "auto",
          maxHeight: "24rem",
          fontSize: "0.8rem",
          background: "var(--bg-secondary)",
          border: "1px solid var(--border)",
          borderRadius: "4px",
          padding: "0.5rem",
        }}
      >
        {diff.hunks.map((hunk, i) => (
          <div key={i}>
            <div style={{ color: "var(--text-secondary)" }}>
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
            </div>
            {hunk.lines.map((line, j) => (
              <div
                key={j}
                style={{
                  whiteSpace: "pre",
                  color: line.op === "+" ? "var(--success)" : line.op === "-" ? "var(--error)" : undefined,
                }}
              >
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
