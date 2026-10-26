/**
 * Dragon stop dialog - confirmation before stopping a running dragon
 */
import { useState } from "react";
import type { Dragon, DragonStopRequest } from "../../shared/types";

interface Props {
  dragon: Dragon;
  onStop: (request: DragonStopRequest) => Promise<void>;
  onClose: () => void;
}

export function DragonStopDialog({ dragon, onStop, onClose }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleStop = async () => {
    setError(null);
    setSubmitting(true);

    try {
      await onStop({ dragonId: dragon.id });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to stop dragon");
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className="detail-panel" style={{ maxWidth: "450px" }}>
        <div className="detail-panel-header">
          <h2>Stop Dragon</h2>
          <button className="detail-panel-close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Warning box */}
        <div
          className="card"
          style={{
            background: "rgba(245, 158, 11, 0.1)",
            borderColor: "var(--warning)",
            marginBottom: "1.5rem",
          }}
        >
          <p style={{ margin: 0, fontWeight: "bold", color: "var(--warning)" }}>
            ⚠️ Warning
          </p>
          <p style={{ margin: "0.5rem 0 0 0", color: "var(--text-secondary)" }}>
            Stopping a dragon will interrupt its current work. The dragon will
            create a STOP file and terminate gracefully. Any uncommitted changes
            may be lost.
          </p>
        </div>

        {/* Dragon info */}
        <div className="card" style={{ marginBottom: "1.5rem" }}>
          <h3 style={{ margin: "0 0 0.75rem 0" }}>Dragon Details</h3>

          <div style={{ marginBottom: "0.5rem" }}>
            <span style={{ color: "var(--text-secondary)" }}>ID:</span>{" "}
            <code>{dragon.id}</code>
          </div>

          <div style={{ marginBottom: "0.5rem" }}>
            <span style={{ color: "var(--text-secondary)" }}>Name:</span>{" "}
            {dragon.name}
          </div>

          <div style={{ marginBottom: "0.5rem" }}>
            <span style={{ color: "var(--text-secondary)" }}>Status:</span>{" "}
            <span
              className={`badge ${dragon.running ? "badge-success" : "badge-neutral"}`}
            >
              {dragon.running ? "Running" : "Idle"}
            </span>
          </div>

          {dragon.task && (
            <div>
              <span style={{ color: "var(--text-secondary)" }}>
                Current Task:
              </span>{" "}
              <span
                style={{
                  wordBreak: "break-all",
                }}
              >
                {dragon.task}
              </span>
            </div>
          )}
        </div>

        {/* Error display */}
        {error && (
          <div
            className="card"
            style={{
              background: "rgba(239, 68, 68, 0.1)",
              borderColor: "var(--error)",
              marginBottom: "1rem",
            }}
          >
            <p style={{ color: "var(--error)", margin: 0 }}>{error}</p>
          </div>
        )}

        {/* Actions */}
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            justifyContent: "flex-end",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            style={{
              padding: "0.5rem 1rem",
              borderRadius: "4px",
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text)",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleStop}
            disabled={submitting}
            style={{
              padding: "0.5rem 1rem",
              borderRadius: "4px",
              border: "none",
              background: "var(--error)",
              color: "white",
              cursor: submitting ? "wait" : "pointer",
              opacity: submitting ? 0.6 : 1,
            }}
          >
            {submitting ? "Stopping..." : "Stop Dragon"}
          </button>
        </div>
      </div>
    </>
  );
}
