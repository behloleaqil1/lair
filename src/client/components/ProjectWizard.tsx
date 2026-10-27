/**
 * New project: id and name, the repository (a git work tree; its GitHub
 * repo comes from `git remote -v`), the queue, agent log and gate paths, and
 * the modules to switch on with their defaults. A review shows the file and
 * any error per field before projects/local/<id>.yaml is written; live
 * reload then starts its modules.
 */
import { useState } from "react";
import type { CreateProjectRequest, RepoCheck, SettingsCheck, SettingsSection } from "../../shared/settings-types";
import { checkNewProject, checkRepository, createProject } from "../settings-api";
import { inputStyle, smallButton } from "./SettingsForm";
import { SettingsReview } from "./SettingsReview";

const muted = { color: "var(--text-secondary)", fontSize: "0.85rem" };
const labelStyle = { display: "flex", flexDirection: "column" as const, gap: "0.2rem", marginBottom: "0.6rem", ...muted };

interface Props {
  sections: SettingsSection[];
  onCreated: (id: string, message: string) => void;
  onCancel: () => void;
}

type PathKey = "queue_file" | "agents_dir" | "gates_dir";

export function ProjectWizard({ sections, onCreated, onCancel }: Props) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("");
  const [repoCheck, setRepoCheck] = useState<RepoCheck | null>(null);
  const [github, setGithub] = useState("");
  const [paths, setPaths] = useState<Record<PathKey, string>>({ queue_file: "", agents_dir: "", gates_dir: "" });
  const [modules, setModules] = useState<string[]>([]);
  const [review, setReview] = useState<SettingsCheck | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggles = sections.filter((s) => s.toggle);
  const request = (): CreateProjectRequest => ({
    id: id.trim(),
    name: name.trim(),
    repo: repo.trim(),
    github: github.trim() || undefined,
    ...paths,
    modules,
  });
  const fieldErrors = (key: string) => (review?.errors ?? []).filter((e) => e.path === key).map((e) => e.message);
  const edited = () => {
    setReview(null);
    setConfirmed(false);
  };

  const check = async () => {
    setError(null);
    const reply = await checkRepository(repo.trim());
    if (!reply.success || !reply.data) {
      setError(reply.error ?? "Could not check the repository");
      return;
    }
    const found = reply.data;
    setRepoCheck(found);
    if (!github && found.github) setGithub(found.github);
    setPaths((p) => ({
      queue_file: p.queue_file || found.suggested.queue_file,
      agents_dir: p.agents_dir || found.suggested.agents_dir,
      gates_dir: p.gates_dir || found.suggested.gates_dir,
    }));
    edited();
  };

  const runReview = async () => {
    setError(null);
    const reply = await checkNewProject(request());
    if (reply.success && reply.data) setReview(reply.data);
    else if (reply.check) setReview(reply.check);
    else setError(reply.error ?? "Could not check the project");
  };

  const create = async () => {
    if (!review) return;
    setBusy(true);
    const reply = await createProject({ ...request(), confirmCommands: review.commandsDigest || undefined });
    setBusy(false);
    if (reply.success && reply.data) {
      onCreated(reply.data.id, `Created ${reply.data.file}`);
    } else {
      if (reply.check) setReview(reply.check);
      setError(reply.error ?? "Could not create the project");
    }
  };

  const errorLine = (key: string) =>
    fieldErrors(key).map((m) => (
      <span key={m} className="error" data-field-error="">
        {m}
      </span>
    ));

  return (
    <div className="card" data-project-wizard="">
      <h3 style={{ fontSize: "1rem", marginBottom: "0.75rem" }}>New project</h3>
      {error && <p className="error">{error}</p>}
      <label style={labelStyle}>
        Id (the file name: letters, digits, '.', '_', '-')
        <input style={inputStyle} value={id} onChange={(e) => {
            setId(e.target.value);
            edited();
          }} placeholder="my-app" />
        {errorLine("id")}
      </label>
      <label style={labelStyle}>
        Name
        <input style={inputStyle} value={name} onChange={(e) => {
            setName(e.target.value);
            edited();
          }} placeholder="My App" />
        {errorLine("name")}
      </label>
      <label style={labelStyle}>
        Repository path (a git work tree)
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input
            style={{ ...inputStyle, fontFamily: "monospace" }}
            value={repo}
            onChange={(e) => {
              setRepo(e.target.value);
              setRepoCheck(null);
              edited();
            }}
            placeholder="/home/user/my-app"
          />
          <button style={smallButton} disabled={repo.trim() === ""} onClick={() => void check()}>
            Check
          </button>
        </div>
        {repoCheck &&
          (repoCheck.problem ? (
            <span className="error">{repoCheck.problem}</span>
          ) : (
            <span style={{ color: "var(--success)" }}>
              A git work tree
              {repoCheck.remotes.length > 0
                ? `; remotes: ${repoCheck.remotes.map((r) => `${r.name} ${r.url}`).join(", ")}`
                : "; no remotes"}
            </span>
          ))}
        {errorLine("repo")}
      </label>
      <label style={labelStyle}>
        GitHub repository (owner/name; detected from the remotes)
        <input style={inputStyle} value={github} onChange={(e) => {
            setGithub(e.target.value);
            edited();
          }} placeholder="owner/name" />
        {errorLine("github")}
      </label>
      {(["queue_file", "agents_dir", "gates_dir"] as const).map((key) => (
        <label key={key} style={labelStyle}>
          {key}
          <input
            style={{ ...inputStyle, fontFamily: "monospace" }}
            value={paths[key]}
            onChange={(e) => {
              const value = e.target.value;
              setPaths((p) => ({ ...p, [key]: value }));
              edited();
            }}
            placeholder={repoCheck?.suggested[key] ?? "<repo>/work/..."}
          />
          {errorLine(key)}
        </label>
      ))}
      <fieldset style={{ border: "1px solid var(--border)", borderRadius: "4px", padding: "0.5rem 0.75rem", marginBottom: "0.75rem" }}>
        <legend style={muted}>Switch on (with their defaults; configure them after)</legend>
        {toggles.map((s) => (
          <label key={s.key} style={{ marginRight: "1rem", whiteSpace: "nowrap" }}>
            <input
              type="checkbox"
              checked={modules.includes(s.key)}
              onChange={(e) => {
                setModules((m) => (e.target.checked ? [...m, s.key] : m.filter((k) => k !== s.key)));
                edited();
              }}
            />{" "}
            {s.title}
          </label>
        ))}
        {errorLine("modules")}
      </fieldset>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button style={smallButton} onClick={() => void runReview()}>
          Review
        </button>
        <button style={smallButton} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {review && (
        <SettingsReview
          check={review}
          confirmed={confirmed}
          onConfirm={setConfirmed}
          onSave={() => void create()}
          saving={busy}
          saveLabel="Create the project"
        />
      )}
    </div>
  );
}
