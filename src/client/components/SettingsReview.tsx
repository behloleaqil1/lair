/**
 * A save's review (POST /api/settings/validate, or a refused save): the
 * diff, every error, the command changes with the exact argv lists and the
 * confirmation they need, and a conflict when the file changed on disk.
 */
import type { SettingsCheck } from "../../shared/settings-types";
import { DiffView } from "./DiffView";

const muted = { color: "var(--text-secondary)", fontSize: "0.85rem" };
const button = {
  padding: "0.4rem 0.9rem",
  borderRadius: "4px",
  border: "1px solid var(--success)",
  background: "transparent",
  color: "var(--success)",
  cursor: "pointer",
};

function argvText(value: unknown): string {
  if (value === null || value === undefined) return "(none)";
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return JSON.stringify(value);
  if (Array.isArray(value)) return value.map((v) => JSON.stringify(v)).join("\n");
  return typeof value === "string" ? value : JSON.stringify(value);
}

interface Props {
  check: SettingsCheck;
  confirmed: boolean;
  onConfirm: (confirmed: boolean) => void;
  onSave: () => void;
  saving: boolean;
  saveLabel?: string;
  /** Offered on a conflict: review again on top of the current file */
  onRebase?: () => void;
  rebaseLabel?: string;
}

/** Whether a reviewed change can be saved now. */
export function canSave(check: SettingsCheck, confirmed: boolean): boolean {
  return check.ok && (check.commands.length === 0 || confirmed);
}

export function SettingsReview({ check, confirmed, onConfirm, onSave, saving, saveLabel = "Save", onRebase, rebaseLabel }: Props) {
  return (
    <div className="card" data-settings-review="" style={{ marginTop: "1rem" }}>
      <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Review</h3>
      {check.conflict && (
        <div className="error" style={{ marginBottom: "0.75rem" }}>
          The file changed on disk since you loaded it (a hand edit or another browser). The diff below is what saving
          would change in the current file.
          {onRebase && (
            <div style={{ marginTop: "0.5rem" }}>
              <button style={{ ...button, borderColor: "var(--warning)", color: "var(--warning)" }} onClick={onRebase}>
                {rebaseLabel ?? "Load the current file and keep my changes"}
              </button>
            </div>
          )}
        </div>
      )}
      {check.errors.length > 0 && (
        <div className="error" data-settings-errors="" style={{ marginBottom: "0.75rem" }}>
          <strong>Not valid; nothing will be written:</strong>
          <ul style={{ paddingLeft: "1.25rem" }}>
            {check.errors.map((e, i) => (
              <li key={i}>
                {e.path ? <code>{e.path}</code> : "file"}: {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <DiffView diff={check.diff} empty="The file would not change" />
      {check.commands.length > 0 && (
        <div data-settings-commands="" style={{ marginTop: "0.75rem", borderLeft: "3px solid var(--warning)", paddingLeft: "0.75rem" }}>
          <strong style={{ color: "var(--warning)" }}>Confirm these changes</strong>
          <p style={muted}>
            What Lair will run (each argv as it runs, no shell) and where it connects or sends code and tokens. Check
            every value before you confirm.
          </p>
          {check.commands.map((c) => (
            <div key={c.path} style={{ margin: "0.5rem 0" }}>
              <code>{c.path}</code>
              <div style={muted}>before: {argvText(c.before)}</div>
              <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.85rem" }}>after: {argvText(c.after)}</pre>
            </div>
          ))}
          <label>
            <input type="checkbox" checked={confirmed} onChange={(e) => onConfirm(e.target.checked)} /> I checked these
            values; Lair may use them
          </label>
        </div>
      )}
      <div style={{ marginTop: "0.75rem" }}>
        <button style={button} disabled={saving || !canSave(check, confirmed)} onClick={onSave}>
          {saving ? "Saving..." : saveLabel}
        </button>
      </div>
    </div>
  );
}
