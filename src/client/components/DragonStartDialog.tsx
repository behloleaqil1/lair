/**
 * Dragon start dialog - start a dragon with task, prompt, and model selection
 * (the kit's Dialog: Esc or Cancel closes it)
 */
import { useState, useEffect } from "react";
import type {
  DragonConfig,
  AvailableModel,
  DragonStartRequest,
} from "../../shared/types";
import { dragonSummary } from "../dragon-start";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Card";
import { CodeBlock } from "../ui/CodeBlock";
import { Dialog } from "../ui/Dialog";
import { Field, Input, TextArea } from "../ui/Field";
import { Select } from "../ui/Select";

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
    <Dialog title="Start Dragon" onClose={onClose} size="lg" closeOnScrim={!submitting}>
      <form onSubmit={handleSubmit}>
        {error && (
          <Callout tone="danger" alert>
            {error}
          </Callout>
        )}

        {/* Dragon picker */}
        <Field label="Dragon" help={selectedDragon ? dragonSummary(selectedDragon) : undefined}>
          <Select id="dragon-select" value={dragonId} onChange={(e) => setDragonId(e.target.value)} disabled={submitting}>
            <option value="">Select a dragon...</option>
            {dragonIds.map((id) => (
              <option key={id} value={id}>
                {id} - {dragons[id].name}
              </option>
            ))}
          </Select>
        </Field>

        {/* Task input */}
        <Field label="Task ID" help="Used for task ownership tracking (branch name or short ID)">
          <Input
            id="task-input"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="e.g., branch-name or task-123"
            disabled={submitting}
          />
        </Field>

        {/* Prompt editor */}
        <Field label="Prompt">
          <TextArea
            id="prompt-input"
            className="mono"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Enter the task prompt for the dragon..."
            disabled={submitting}
            rows={8}
          />
        </Field>

        {/* Model override */}
        <Field label="Model Override" hint="(optional)">
          <Select id="model-select" value={modelOverride} onChange={(e) => setModelOverride(e.target.value)} disabled={submitting}>
            <option value="">Use default ({defaultModel || "not set"})</option>
            {availableModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
                {model.description ? ` - ${model.description}` : ""}
              </option>
            ))}
          </Select>
        </Field>

        {/* Extra instructions */}
        <Field label="Extra Instructions" hint="(optional)">
          <TextArea
            id="extra-instructions"
            className="mono"
            value={extraInstructions}
            onChange={(e) => setExtraInstructions(e.target.value)}
            placeholder="Additional instructions to prepend to the prompt..."
            disabled={submitting}
            rows={3}
          />
        </Field>
        {defaultInstructions && (
          <details className="muted-details">
            <summary className="muted small">Project default instructions</summary>
            <CodeBlock label="Project default instructions" maxHeight={100}>
              {defaultInstructions}
            </CodeBlock>
          </details>
        )}
        {selectedDragon?.instructions && (
          <details className="muted-details">
            <summary className="muted small">Dragon standing instructions</summary>
            <CodeBlock label="Dragon standing instructions" maxHeight={100}>
              {selectedDragon.instructions}
            </CodeBlock>
          </details>
        )}

        {/* Actions */}
        <div className="dialog-actions">
          <Button onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={submitting || !dragonId || !task.trim() || !prompt.trim()}>
            {submitting ? "Starting..." : "Start Dragon"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
