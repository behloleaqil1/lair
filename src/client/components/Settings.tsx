/**
 * Settings view: every setting of a project from the dashboard, written to
 * its YAML by the server (src/server/settings/, docs/design/settings-ui.md).
 * The owner only: signed out, it shows the sign-in hint and reads nothing.
 *
 * Form and YAML edits are reviewed first (the diff, errors per field, and
 * the commands a change makes Lair run, which need a confirmation), then
 * saved with the hash of the file as loaded: a file changed meanwhile is
 * refused with what changed, never overwritten.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  FieldError,
  PathSegment,
  ProjectFileInfo,
  ProjectSettingsView,
  SaveRequest,
  SettingsCheck,
  SettingsSection,
} from "../../shared/settings-types";
import {
  checkProjectSettings,
  listSettingsProjects,
  loadProjectSettings,
  loadSections,
  saveProjectSettings,
} from "../settings-api";
import { diffValues, generalErrors, setIn } from "../settings-form";
import { SignInHint } from "./SignInHint";
import { SettingsForm, inputStyle, smallButton } from "./SettingsForm";
import { SettingsHistory } from "./SettingsHistory";
import { SettingsReview } from "./SettingsReview";
import { ProjectWizard } from "./ProjectWizard";
import { NotificationSettings } from "./NotificationSettings";

interface Props {
  project: string;
  refreshKey: number;
}

type Tab = "form" | "yaml" | "history";

const muted = { color: "var(--text-secondary)", fontSize: "0.85rem" };
const tabButton = (active: boolean) => ({
  ...smallButton,
  fontSize: "0.9rem",
  borderColor: active ? "var(--accent)" : "var(--border)",
  color: active ? "var(--accent)" : "var(--text-primary)",
});

function applyChangesLocally(values: Record<string, unknown>, request: SaveRequest): Record<string, unknown> {
  let next: unknown = values;
  for (const change of request.changes ?? []) next = setIn(next, change.path, change.remove ? undefined : change.value);
  return next as Record<string, unknown>;
}

export function Settings({ project, refreshKey }: Props) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [sections, setSections] = useState<SettingsSection[]>([]);
  const [projects, setProjects] = useState<ProjectFileInfo[]>([]);
  const [selected, setSelected] = useState(project);
  const [view, setView] = useState<ProjectSettingsView | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [yaml, setYaml] = useState("");
  const [tab, setTab] = useState<Tab>("form");
  const [review, setReview] = useState<SettingsCheck | null>(null);
  const [reviewed, setReviewed] = useState<SaveRequest | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const clearReview = () => {
    setReview(null);
    setReviewed(null);
    setConfirmed(false);
  };

  const loadProject = useCallback(async (id: string, keep?: (fresh: ProjectSettingsView) => void) => {
    setError(null);
    const reply = await loadProjectSettings(id);
    if (!reply.success || !reply.data) {
      setView(null);
      setError(reply.error ?? "Could not load the project");
      return;
    }
    const fresh = reply.data;
    setView(fresh);
    setDraft(fresh.values ?? {});
    setYaml(fresh.yaml);
    setReview(null);
    setReviewed(null);
    setConfirmed(false);
    keep?.(fresh);
  }, []);

  // Read nothing until this browser is known to be the owner's
  useEffect(() => {
    if (signedIn !== true) return;
    let cancelled = false;
    void Promise.all([loadSections(), listSettingsProjects()]).then(([s, p]) => {
      if (cancelled) return;
      if (s.success && s.data) setSections(s.data.sections);
      else setError(s.error ?? "Could not load the sections");
      if (p.success && p.data) setProjects(p.data.projects);
    });
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  // Not on refreshKey: a reload while editing would drop the draft
  useEffect(() => {
    if (signedIn !== true || !selected) return;
    void loadProject(selected);
  }, [signedIn, selected, loadProject]);

  const changes = useMemo(() => (view ? diffValues(view.values ?? {}, draft) : []), [view, draft]);
  const dirty = tab === "yaml" ? view !== null && yaml !== view.yaml : changes.length > 0;
  const errors: FieldError[] = review?.errors ?? view?.errors ?? [];

  if (signedIn !== true) {
    return (
      <div>
        <h2 style={{ marginBottom: "1rem" }}>Settings</h2>
        <SignInHint what="Reading and changing settings" refreshKey={refreshKey} onStatus={setSignedIn} />
        {signedIn === null && <p style={muted}>Checking this browser's owner session...</p>}
      </div>
    );
  }

  const request = (): SaveRequest | null => {
    if (!view) return null;
    return tab === "yaml" ? { baseHash: view.hash, yaml } : { baseHash: view.hash, changes };
  };

  const runReview = async () => {
    const r = request();
    if (!r || !view) return;
    setMessage(null);
    setError(null);
    const reply = await checkProjectSettings(view.id, r);
    if (reply.success && reply.data) {
      setReview(reply.data);
      setReviewed(r);
      setConfirmed(false);
    } else {
      setError(reply.error ?? "Could not check the change");
    }
  };

  const save = async () => {
    if (!view || !review || !reviewed) return;
    setBusy(true);
    const reply = await saveProjectSettings(view.id, { ...reviewed, confirmCommands: review.commandsDigest || undefined });
    setBusy(false);
    if (reply.success && reply.data) {
      const result = reply.data;
      await loadProject(view.id);
      setMessage(
        result.reloadProblem
          ? `Saved, but the live reload kept the previous config: ${result.reloadProblem}`
          : `Saved (version ${result.version}); live reload applies it now`,
      );
    } else if (reply.check) {
      // 409 (changed on disk), 422 (not valid), 428 (commands to confirm): show why
      setReview(reply.check);
      setConfirmed(false);
      setError(reply.error ?? null);
    } else {
      setError(reply.error ?? "Save failed");
    }
  };

  // After a 409: the current file, with the form's changes made again on top of it
  const rebase = async () => {
    if (!view || !reviewed) return;
    const pending = reviewed;
    await loadProject(view.id, (fresh) => {
      if (pending.changes) setDraft(applyChangesLocally(fresh.values ?? {}, pending));
    });
    setMessage(
      pending.changes
        ? "Loaded the current file and made your changes again; review them before saving"
        : "Loaded the current file; your YAML text was replaced by it",
    );
  };

  const onChange = (path: PathSegment[], value: unknown) => {
    setDraft((d) => setIn(d, path, value) as Record<string, unknown>);
    clearReview();
  };

  const general = generalErrors(errors, sections);

  return (
    <div data-settings-view="">
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        <h2>Settings</h2>
        <select
          style={{ ...inputStyle, width: "auto" }}
          value={selected}
          onChange={(e) => {
            if (dirty && !window.confirm("Discard your unsaved changes?")) return;
            setCreating(false);
            setSelected(e.target.value);
          }}
        >
          {!projects.some((p) => p.id === selected) && selected && <option value={selected}>{selected}</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id}
            </option>
          ))}
        </select>
        <button style={smallButton} onClick={() => setCreating(true)}>
          New project
        </button>
        {view && (
          <span style={muted}>
            {view.file}
          </span>
        )}
      </div>

      {creating && (
        <ProjectWizard
          sections={sections}
          onCancel={() => setCreating(false)}
          onCreated={(id, text) => {
            setCreating(false);
            void listSettingsProjects().then((p) => {
              if (p.success && p.data) setProjects(p.data.projects);
            });
            setSelected(id);
            setMessage(`${text}; live reload starts its modules. Reload the page to see it in the project list above.`);
          }}
        />
      )}

      {message && <p style={{ color: "var(--success)", margin: "0.5rem 0" }}>{message}</p>}
      {error && <p className="error">{error}</p>}

      {view && !creating && (
        <>
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
            {(["form", "yaml", "history"] as const).map((t) => (
              <button
                key={t}
                style={tabButton(tab === t)}
                onClick={() => {
                  if (t !== tab && dirty && !window.confirm("Switching tabs drops the unsaved changes of this one. Go on?")) {
                    return;
                  }
                  setDraft(view.values ?? {});
                  setYaml(view.yaml);
                  clearReview();
                  setTab(t);
                }}
              >
                {t === "form" ? "Form" : t === "yaml" ? "YAML" : "History"}
              </button>
            ))}
          </div>

          {!view.local && tab !== "history" && (
            <div className="card" data-tracked-hint="" style={{ borderColor: "var(--warning)", marginBottom: "1rem" }}>
              <strong>This file is tracked by git.</strong> <code>{view.file}</code> is in <code>projects/</code>, which
              git tracks in Lair's checkout: saving changes it there, and git shows the change. To keep this
              project's settings private, copy it to <code>projects/local/{view.id}.yaml</code> (git-ignored); Settings
              then edits that file.
            </div>
          )}

          {general.length > 0 && (
            <div className="error" style={{ marginBottom: "1rem" }}>
              {general.map((e, i) => (
                <div key={i}>
                  {e.path ? <code>{e.path}</code> : "file"}: {e.message}
                </div>
              ))}
            </div>
          )}

          {tab === "form" &&
            (view.values === null ? (
              <p className="error">The file doesn't parse as YAML; fix it in the YAML tab.</p>
            ) : (
              <>
                <div className="card" style={{ marginBottom: "1rem" }}>
                  <strong>Secrets</strong>
                  <p style={muted}>Never in the YAML: Lair reads them from data/ files and environment variables.</p>
                  {view.secrets.map((s) => (
                    <div key={`${s.where}${s.label}`} style={muted}>
                      <span className={`badge ${s.set ? "badge-success" : "badge-neutral"}`}>{s.set ? "set" : "not set"}</span>{" "}
                      {s.label}: <code>{s.where}</code>
                    </div>
                  ))}
                </div>
                <SettingsForm
                  sections={sections}
                  draft={draft}
                  known={view.known}
                  errors={errors}
                  unknownKeys={view.unknownKeys}
                  disabled={busy}
                  onChange={onChange}
                />
              </>
            ))}

          {tab === "yaml" && (
            <textarea
              data-settings-yaml=""
              style={{ ...inputStyle, fontFamily: "monospace", fontSize: "0.85rem", minHeight: "28rem" }}
              value={yaml}
              spellCheck={false}
              onChange={(e) => {
                setYaml(e.target.value);
                clearReview();
              }}
            />
          )}

          {tab === "history" && (
            <SettingsHistory
              project={view.id}
              baseHash={view.hash}
              onRestored={(text) => {
                void loadProject(view.id);
                setMessage(text);
              }}
            />
          )}

          {tab !== "history" && (
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "1rem" }}>
              <button style={smallButton} disabled={!dirty || busy} onClick={() => void runReview()}>
                Review changes{tab === "form" && changes.length > 0 ? ` (${changes.length})` : ""}
              </button>
              <button
                style={smallButton}
                disabled={!dirty || busy}
                onClick={() => {
                  setDraft(view.values ?? {});
                  setYaml(view.yaml);
                  clearReview();
                }}
              >
                Discard
              </button>
              {!dirty && <span style={muted}>No unsaved changes</span>}
            </div>
          )}

          {review && tab !== "history" && (
            <SettingsReview
              check={review}
              confirmed={confirmed}
              onConfirm={setConfirmed}
              onSave={() => void save()}
              saving={busy}
              onRebase={() => void rebase()}
              rebaseLabel={tab === "form" ? "Load the current file and keep my changes" : "Load the current file (drops your text)"}
            />
          )}
        </>
      )}

      {/* Lair's own settings (data/server.yaml), apart from the project's */}
      <NotificationSettings />
    </div>
  );
}
