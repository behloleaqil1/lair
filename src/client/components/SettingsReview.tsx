/**
 * A save's review (POST /api/settings/validate, or a refused save): the
 * diff, every error, the command changes with the exact argv lists and the
 * confirmation they need, and a conflict when the file changed on disk.
 */
import type { SettingsCheck } from "../../shared/settings-types";
import { DiffView } from "./DiffView";
import { Button } from "../ui/Button";

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
    <div className="card spaced-lg" data-settings-review="">
      <h3>Review</h3>
      {check.conflict && (
        <div className="error mb-3">
          The file changed on disk since you loaded it (a hand edit or another browser). The diff below is what saving
          would change in the current file.
          {onRebase && (
            <div className="spaced-sm">
              <Button size="sm" onClick={onRebase}>
                {rebaseLabel ?? "Load the current file and keep my changes"}
              </Button>
            </div>
          )}
        </div>
      )}
      {check.errors.length > 0 && (
        <div className="error mb-3" data-settings-errors="">
          <strong>Not valid; nothing will be written:</strong>
          <ul>
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
        <div data-settings-commands="" className="warning-rail mt-3">
          <strong className="text-warning">Confirm these changes</strong>
          <p className="muted small">
            What Lair will run (each argv as it runs, no shell) and where it connects or sends code and tokens. Check
            every value before you confirm.
          </p>
          {check.commands.map((c) => (
            <div key={c.path} className="stack-sm">
              <code>{c.path}</code>
              <div className="muted small">before: {argvText(c.before)}</div>
              <pre className="code-block">after: {argvText(c.after)}</pre>
            </div>
          ))}
          <label>
            <input type="checkbox" checked={confirmed} onChange={(e) => onConfirm(e.target.checked)} /> I checked these
            values; Lair may use them
          </label>
        </div>
      )}
      <div className="spaced">
        <Button variant="primary" disabled={saving || !canSave(check, confirmed)} onClick={onSave}>
          {saving ? "Saving..." : saveLabel}
        </Button>
      </div>
    </div>
  );
}
