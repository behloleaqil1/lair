/**
 * A model dropdown filled from the chosen tool's own list
 * (GET /api/ai/models?tool=), and refilled when the tool changes: each model
 * with the tool's own notes, its default marked. "Other…" takes a typed
 * model, with a warning when the tool doesn't list it: tools add models
 * faster than Lair releases, so a typed model is saved, never refused
 * (docs/design/ai-roles.md, "Models").
 */
import { useEffect, useState } from "react";
import type { AiModelsView } from "../../shared/ai-types";
import { loadAiModels, refreshAiModels } from "../ai-api";
import { OTHER_MODEL, modelChoices, modelListed, modelWarning } from "../ai-settings";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Card";
import { Field, Input } from "../ui/Field";
import { Select } from "../ui/Select";

export interface ModelPickerProps {
  project: string;
  /** The tool whose models are offered ("" while none is chosen) */
  tool: string;
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
}

/** Where the list came from, in words (the server's error is a failure's category, never a tool's output). */
function sourceLine(view: AiModelsView | null): string {
  if (!view) return "";
  if (view.source === "cmd") return `The tool's own list${view.fetchedAt ? `, read ${new Date(view.fetchedAt).toLocaleTimeString()}` : ""}.`;
  if (view.source === "preset") return `Lair's known list for this tool${view.error ? ` (${view.error})` : ""}.`;
  return "This tool gives no list of models: choose Other… and type the one you want.";
}

export function ModelPicker({ project, tool, value, onChange, disabled }: ModelPickerProps) {
  const [models, setModels] = useState<AiModelsView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "Other…" picked: the typed model is the value
  const [typing, setTyping] = useState(false);

  // The tool's own list, read again whenever the tool changes
  useEffect(() => {
    setModels(null);
    setError(null);
    setTyping(false);
    setLoading(tool !== "");
    if (!tool) return;
    let cancelled = false;
    void loadAiModels(project, tool).then((reply) => {
      if (cancelled) return;
      setLoading(false);
      if (reply.success && reply.data) setModels(reply.data);
      else setError(reply.error ?? "The tool's models could not be read");
    });
    return () => {
      cancelled = true;
    };
  }, [project, tool]);

  const refresh = async () => {
    setLoading(true);
    const reply = await refreshAiModels(project, tool);
    setLoading(false);
    if (reply.success && reply.data) {
      setModels(reply.data);
      setError(null);
    } else {
      setError(reply.error ?? "The tool's models could not be read");
    }
  };

  const choices = modelChoices(models);
  const listed = modelListed(models, value);
  const other = typing || (!loading && value !== "" && listed !== true);
  const warning = other ? modelWarning(tool, value, models) : null;
  const placeholder = !tool ? "Choose a tool first" : loading ? "Reading the tool's models..." : choices.length > 0 ? "Choose a model" : "No list: choose Other…";

  return (
    <div className="model-picker" data-model-picker="">
      <Field label="Model" help={error ?? sourceLine(models)}>
        <Select
          value={other ? OTHER_MODEL : value}
          disabled={disabled || !tool || loading}
          data-model-select=""
          onChange={(e) => {
            if (e.target.value === OTHER_MODEL) {
              setTyping(true);
              return;
            }
            setTyping(false);
            onChange(e.target.value);
          }}
        >
          <option value="">{placeholder}</option>
          {choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
          <option value={OTHER_MODEL}>Other…</option>
        </Select>
      </Field>
      {other && (
        <Field label="Model id" help="The tool's own name for the model, as you would pass it to the tool">
          <Input value={value} disabled={disabled} spellCheck={false} data-model-other="" onChange={(e) => onChange(e.target.value.trim())} />
        </Field>
      )}
      {warning && (
        <Callout tone="warning" data-model-warning="">
          {warning}
        </Callout>
      )}
      {tool && (
        <Button size="sm" variant="ghost" disabled={loading} onClick={() => void refresh()}>
          Read the list again
        </Button>
      )}
    </div>
  );
}
