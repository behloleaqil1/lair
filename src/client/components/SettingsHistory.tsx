/**
 * A project file's versions (data/config-history/): who and when, each
 * version's diff from the one before and to the current file, and Restore,
 * which is reviewed and saved like any change.
 */
import { useEffect, useState } from "react";
import type { HistoryDetail, HistoryVersion, SettingsCheck } from "../../shared/settings-types";
import { checkRestore, loadHistory, loadVersion, restoreVersion } from "../settings-api";
import { DiffView } from "./DiffView";
import { SettingsReview } from "./SettingsReview";
import { smallButton } from "./SettingsForm";

const muted = { color: "var(--text-secondary)", fontSize: "0.85rem" };

const ACTION_LABEL: Record<HistoryVersion["action"], string> = {
  create: "created",
  save: "saved from Settings",
  restore: "restored",
  file: "found on disk (a hand edit)",
};

interface Props {
  project: string;
  /** The file's hash as loaded */
  baseHash: string;
  /** After a restore: load the file again */
  onRestored: (message: string) => void;
}

export function SettingsHistory({ project, baseHash, onRestored }: Props) {
  const [versions, setVersions] = useState<HistoryVersion[]>([]);
  const [detail, setDetail] = useState<HistoryDetail | null>(null);
  const [review, setReview] = useState<SettingsCheck | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadHistory(project).then((reply) => {
      if (cancelled) return;
      if (reply.success && reply.data) setVersions(reply.data.versions);
      else setError(reply.error ?? "Could not load the history");
    });
    return () => {
      cancelled = true;
    };
  }, [project, baseHash]);

  const open = async (version: string) => {
    setReview(null);
    setConfirmed(false);
    const reply = await loadVersion(project, version);
    if (reply.success && reply.data) setDetail(reply.data);
    else setError(reply.error ?? "Could not load the version");
  };

  const reviewRestore = async () => {
    if (!detail) return;
    const reply = await checkRestore(project, detail.info.version, baseHash);
    if (reply.success && reply.data) setReview(reply.data);
    else setError(reply.error ?? "Could not check the restore");
  };

  const restore = async () => {
    if (!detail || !review) return;
    setBusy(true);
    const reply = await restoreVersion(project, detail.info.version, {
      baseHash,
      confirmCommands: review.commandsDigest || undefined,
    });
    setBusy(false);
    if (reply.success && reply.data) {
      setDetail(null);
      setReview(null);
      onRestored(`Restored ${detail.info.version} as version ${reply.data.version}`);
    } else if (reply.check) {
      setReview(reply.check);
      setError(reply.error ?? null);
    } else {
      setError(reply.error ?? "Restore failed");
    }
  };

  return (
    <div data-settings-history="">
      {error && <p className="error">{error}</p>}
      {versions.length === 0 ? (
        <p style={muted}>No versions yet: every save from Settings keeps one here (the newest 50).</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Version</th>
              <th>What</th>
              <th>Who</th>
              <th>Size</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.version}>
                <td>{new Date(v.at).toLocaleString()}</td>
                <td>
                  {ACTION_LABEL[v.action]}
                  {v.restoredFrom ? ` (from ${v.restoredFrom})` : ""}
                  {v.redacted ? " (not kept: it held what looks like a secret)" : ""}
                </td>
                <td style={muted}>{v.by ? `owner session ${v.by.slice(0, 8)}` : "—"}</td>
                <td style={muted}>{v.bytes} B</td>
                <td>
                  <button style={smallButton} disabled={v.redacted === true} onClick={() => void open(v.version)}>
                    Show
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {detail && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <h3 style={{ fontSize: "1rem" }}>
            {detail.info.version} ({ACTION_LABEL[detail.info.action]})
          </h3>
          <p style={muted}>Changes from the version before it:</p>
          {detail.fromPrevious ? <DiffView diff={detail.fromPrevious} /> : <p style={muted}>The oldest version kept.</p>}
          <p style={muted}>Restoring it would change the current file like this:</p>
          <DiffView diff={detail.restoreDiff} empty="It is the current file" />
          <button style={{ ...smallButton, marginTop: "0.5rem" }} onClick={() => void reviewRestore()}>
            Restore...
          </button>
          {review && (
            <SettingsReview
              check={review}
              confirmed={confirmed}
              onConfirm={setConfirmed}
              onSave={() => void restore()}
              saving={busy}
              saveLabel="Restore this version"
            />
          )}
        </div>
      )}
    </div>
  );
}

