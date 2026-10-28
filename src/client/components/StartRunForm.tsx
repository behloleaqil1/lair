/**
 * "Start a run" (POST /api/agents/runs, owner only), from the Work section:
 * agent, task, model and prompt, the prompt optionally loaded from a file in
 * the project's prompts_dir. The task is claimed when the request is
 * accepted, and the run starts on the next check. It asks for confirmation
 * first, and stays disabled until this browser is known to be signed in as
 * the owner.
 */
import { useEffect, useState } from "react";
import {
  failureMessage,
  listPrompts,
  loadPrompt,
  modelsOf,
  postJson,
  runConfirmed,
  startRunAction,
} from "../agents-actions";
import { SignInHint } from "./SignInHint";
import type { AgentView, PromptFileView } from "../../shared/agents-types";
import { Button } from "../ui/Button";

/**
 * Start a run (POST /api/agents/runs, owner only): the task is claimed when
 * the request is accepted, and the run starts on the next check. Disabled
 * until this browser is known to be signed in as the owner.
 */
export function StartRunForm({
  project,
  agents,
  refreshKey,
  onStarted,
}: {
  project: string;
  agents: AgentView[];
  refreshKey: number;
  onStarted: () => void;
}) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [agentId, setAgentId] = useState("");
  const [task, setTask] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<PromptFileView[]>([]);
  const [file, setFile] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  // The prompt files are the owner's to read: list them only once signed in
  useEffect(() => {
    if (signedIn !== true) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    listPrompts(project)
      .then((list) => {
        if (!cancelled) setFiles(list);
      })
      .catch((e) => {
        if (!cancelled) setFileError(`Could not list the prompt files: ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [project, signedIn, refreshKey]);

  const agent = agents.find((a) => a.id === agentId) ?? agents[0];
  const models = agent ? modelsOf(agent) : [];
  // A model chosen for another agent is not this one's: the default applies
  const chosenModel = models.includes(model) ? model : "";
  const disabled = signedIn !== true || busy;
  const ready = !!agent && task.trim().length > 0 && prompt.trim().length > 0;

  const load = async (name: string) => {
    setFile(name);
    setFileError(null);
    if (!name) return;
    if (prompt.trim() && !window.confirm(`Replace the prompt you typed with ${name}?`)) return;
    try {
      const loaded = await loadPrompt(project, name);
      setPrompt(loaded.text);
    } catch (e) {
      setFileError(`Could not load ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const start = async () => {
    if (!agent || !ready) return;
    setBusy(true);
    setResult(null);
    try {
      const action = startRunAction(project, { agent: agent.id, task, prompt, model: chosenModel });
      const sent = await runConfirmed(action, (q) => window.confirm(q), postJson);
      if (!sent.sent) return;
      if (sent.ok) {
        setResult({ ok: true, text: `Run queued: ${agent.id} on ${task.trim()} starts on the next check.` });
        setTask("");
        setPrompt("");
        setFile("");
        onStarted();
      } else {
        setResult({ ok: false, text: failureMessage(sent) });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" data-form="start-run">
      <h3>Start a run</h3>
      <SignInHint what="Starting a run" refreshKey={refreshKey} onStatus={setSignedIn} />
      <div className="row row-lg mb-3">
        <label className="label-stack">
          Agent
          <select
            className="input"
            value={agent?.id ?? ""}
            disabled={disabled}
            onChange={(e) => {
              setAgentId(e.target.value);
              setModel("");
            }}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id}
              </option>
            ))}
          </select>
        </label>
        <label className="label-stack">
          Task
          <input
            className="input"
            value={task}
            disabled={disabled}
            maxLength={128}
            placeholder="feat-login"
            onChange={(e) => setTask(e.target.value)}
          />
        </label>
        <label className="label-stack">
          Model
          <select className="input" value={chosenModel} disabled={disabled} onChange={(e) => setModel(e.target.value)}>
            <option value="">Default{models[0] ? ` (${models[0]})` : ""}</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="label-stack">
          Load a prompt (optional)
          <select className="input" value={file} disabled={disabled} onChange={(e) => void load(e.target.value)}>
            <option value="">{files.length === 0 ? "No files in prompts_dir" : "Choose a file"}</option>
            {files.map((f) => (
              <option key={f.name} value={f.name} disabled={f.tooLarge}>
                {f.name}
                {f.tooLarge ? " (too large)" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="label-stack">
        Prompt
        <textarea
          className="input textarea mono" style={{ minHeight: "8rem" }}
          value={prompt}
          disabled={disabled}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>
      <div className="row row-lg mt-3">
        <Button size="sm" disabled={disabled || !ready} onClick={() => void start()}>
          {busy ? "Starting..." : "Start run"}
        </Button>
        <span className="muted small">{prompt.length} characters</span>
      </div>
      {fileError && (
        <div className="error spaced">
          {fileError}
        </div>
      )}
      {result && (
        <div className={result.ok ? "muted small mt-3" : "error mt-3"}>
          {result.text}
        </div>
      )}
    </div>
  );
}
