/**
 * Dragon start dialog - start a dragon with task, prompt, and model selection
 */
import { useState, useEffect } from "react";
import type {
  DragonConfig,
  AvailableModel,
  DragonStartRequest,
} from "../../shared/types";
import { dragonSummary } from "../dragon-start";

interface Props {
  dragons: Record<string, DragonConfig>;
  availableModels: AvailableModel[];
  defaultInstructions?: string;
  selectedDragonId?: string;
  onStart: (request: DragonStartRequest) => Promise<void>;
  onClose: () => void;
}

export function DragonStartDialog({
  dragons,
  availableModels,
  defaultInstructions,
  selectedDragonId,
  onStart,
  onClose,
}: Props) {
  const [dragonId, setDragonId] = useState(selectedDragonId || "");
  const [task, setTask] = useState("");
  const [prompt, setPrompt] = useState("");
  const [modelOverride, setModelOverride] = useState("");
  const [extraInstructions, setExtraInstructions] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Get dragon IDs sorted
  const dragonIds = Object.keys(dragons).sort();

  // Set initial dragon if provided
  useEffect(() => {
    if (selectedDragonId && dragons[selectedDragonId]) {
      setDragonId(selectedDragonId);
    } else if (dragonIds.length > 0 && !dragonId) {
      setDragonId(dragonIds[0]);
    }
  }, [selectedDragonId, dragonIds]);

  // Get selected dragon config
  const selectedDragon = dragonId ? dragons[dragonId] : null;

  // Default model is from dragon config
  const defaultModel = selectedDragon?.model || "";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!dragonId) {
      setError("Please select a dragon");
      return;
    }
    if (!task.trim()) {
      setError("Task is required");
      return;
    }
    if (!prompt.trim()) {
      setError("Prompt is required");
      return;
    }

    setSubmitting(true);
    try {
      await onStart({
        dragonId,
        task: task.trim(),
        prompt: prompt.trim(),
        model: modelOverride || undefined,
        extraInstructions: extraInstructions.trim() || undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start dragon");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className="detail-panel" style={{ maxWidth: "600px" }}>
        <div className="detail-panel-header">
          <h2>Start Dragon</h2>
          <button className="detail-panel-close" onClick={onClose}>
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit}>
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

          {/* Dragon picker */}
          <div className="form-group" style={{ marginBottom: "1rem" }}>
            <label
              htmlFor="dragon-select"
              style={{ display: "block", marginBottom: "0.5rem" }}
            >
              Dragon
            </label>
            <select
              id="dragon-select"
              value={dragonId}
              onChange={(e) => setDragonId(e.target.value)}
              disabled={submitting}
              style={{
                width: "100%",
                padding: "0.5rem",
                borderRadius: "4px",
                border: "1px solid var(--border)",
                background: "var(--background)",
                color: "var(--text)",
              }}
            >
              <option value="">Select a dragon...</option>
              {dragonIds.map((id) => (
                <option key={id} value={id}>
                  {id} - {dragons[id].name}
                </option>
              ))}
            </select>
            {selectedDragon && (
              <p
                style={{
                  color: "var(--text-secondary)",
                  fontSize: "0.85rem",
                  marginTop: "0.25rem",
                }}
              >
                {dragonSummary(selectedDragon)}
              </p>
            )}
          </div>

          {/* Task input */}
          <div className="form-group" style={{ marginBottom: "1rem" }}>
            <label
              htmlFor="task-input"
              style={{ display: "block", marginBottom: "0.5rem" }}
            >
              Task ID
            </label>
            <input
              id="task-input"
              type="text"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="e.g., branch-name or task-123"
              disabled={submitting}
              style={{
                width: "100%",
                padding: "0.5rem",
                borderRadius: "4px",
                border: "1px solid var(--border)",
                background: "var(--background)",
                color: "var(--text)",
                boxSizing: "border-box",
              }}
            />
            <p
              style={{
                color: "var(--text-secondary)",
                fontSize: "0.85rem",
                marginTop: "0.25rem",
              }}
            >
              Used for task ownership tracking (branch name or short ID)
            </p>
          </div>

          {/* Prompt editor */}
          <div className="form-group" style={{ marginBottom: "1rem" }}>
            <label
              htmlFor="prompt-input"
              style={{ display: "block", marginBottom: "0.5rem" }}
            >
              Prompt
            </label>
            <textarea
              id="prompt-input"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Enter the task prompt for the dragon..."
              disabled={submitting}
              rows={8}
              style={{
                width: "100%",
                padding: "0.5rem",
                borderRadius: "4px",
                border: "1px solid var(--border)",
                background: "var(--background)",
                color: "var(--text)",
                fontFamily: "monospace",
                fontSize: "0.9rem",
                resize: "vertical",
                boxSizing: "border-box",
              }}
            />
          </div>

          {/* Model override */}
          <div className="form-group" style={{ marginBottom: "1rem" }}>
            <label
              htmlFor="model-select"
              style={{ display: "block", marginBottom: "0.5rem" }}
            >
              Model Override{" "}
              <span style={{ color: "var(--text-secondary)" }}>(optional)</span>
            </label>
            <select
              id="model-select"
              value={modelOverride}
              onChange={(e) => setModelOverride(e.target.value)}
              disabled={submitting}
              style={{
                width: "100%",
                padding: "0.5rem",
                borderRadius: "4px",
                border: "1px solid var(--border)",
                background: "var(--background)",
                color: "var(--text)",
              }}
            >
              <option value="">
                Use default ({defaultModel || "not set"})
              </option>
              {availableModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                  {model.description ? ` - ${model.description}` : ""}
                </option>
              ))}
            </select>
          </div>

          {/* Extra instructions */}
          <div className="form-group" style={{ marginBottom: "1.5rem" }}>
            <label
              htmlFor="extra-instructions"
              style={{ display: "block", marginBottom: "0.5rem" }}
            >
              Extra Instructions{" "}
              <span style={{ color: "var(--text-secondary)" }}>(optional)</span>
            </label>
            <textarea
              id="extra-instructions"
              value={extraInstructions}
              onChange={(e) => setExtraInstructions(e.target.value)}
              placeholder="Additional instructions to prepend to the prompt..."
              disabled={submitting}
              rows={3}
              style={{
                width: "100%",
                padding: "0.5rem",
                borderRadius: "4px",
                border: "1px solid var(--border)",
                background: "var(--background)",
                color: "var(--text)",
                fontFamily: "monospace",
                fontSize: "0.9rem",
                resize: "vertical",
                boxSizing: "border-box",
              }}
            />
            {defaultInstructions && (
              <details style={{ marginTop: "0.5rem" }}>
                <summary
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: "0.85rem",
                    cursor: "pointer",
                  }}
                >
                  Project default instructions
                </summary>
                <pre
                  className="code"
                  style={{
                    marginTop: "0.5rem",
                    maxHeight: "100px",
                    overflow: "auto",
                  }}
                >
                  {defaultInstructions}
                </pre>
              </details>
            )}
            {selectedDragon?.instructions && (
              <details style={{ marginTop: "0.5rem" }}>
                <summary
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: "0.85rem",
                    cursor: "pointer",
                  }}
                >
                  Dragon standing instructions
                </summary>
                <pre
                  className="code"
                  style={{
                    marginTop: "0.5rem",
                    maxHeight: "100px",
                    overflow: "auto",
                  }}
                >
                  {selectedDragon.instructions}
                </pre>
              </details>
            )}
          </div>

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
              type="submit"
              disabled={
                submitting || !dragonId || !task.trim() || !prompt.trim()
              }
              style={{
                padding: "0.5rem 1rem",
                borderRadius: "4px",
                border: "none",
                background: "var(--primary)",
                color: "white",
                cursor: submitting ? "wait" : "pointer",
                opacity:
                  submitting || !dragonId || !task.trim() || !prompt.trim()
                    ? 0.6
                    : 1,
              }}
            >
              {submitting ? "Starting..." : "Start Dragon"}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
