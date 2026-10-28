/**
 * Settings (docs/design/settings-v2.md, S2-1): every setting of a project
 * from the dashboard, written to its YAML by the server
 * (src/server/settings/, docs/design/settings-ui.md). The owner only:
 * signed out, it shows the sign-in hint and reads nothing.
 *
 * The shell: pages organised by task (settings-pages.ts), each with its URL;
 * a search box that finds any field by its label, help or YAML key (⌘K);
 * and one draft for every page. A sticky bar counts the unsaved changes, and
 * "Review and save" opens a drawer with the phase-1 write path unchanged:
 * the dry run, the diff, the errors per field and the confirmation of
 * commands and sensitive fields, then the save with the hash of the file as
 * loaded. A file changed meanwhile is refused (409), and the drawer offers to
 * review the same changes again on top of the current file.
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
import { pathKey } from "../../shared/settings-rules";
import type { Route } from "../router";
import {
  checkProjectSettings,
  listSettingsProjects,
  loadProjectSettings,
  loadSections,
  saveProjectSettings,
} from "../settings-api";
import { diffValues, generalErrors, setIn } from "../settings-form";
import { SETTINGS_PAGES, pageHref, pageOf, tabOf, unsavedText } from "../settings-pages";
import { fieldIndex, fieldTarget, type SearchEntry } from "../settings-search";
import { SignInHint } from "./SignInHint";
import { SettingsForm, type FormFocus } from "./SettingsForm";
import { SettingsHistory } from "./SettingsHistory";
import { SettingsOverview } from "./SettingsOverview";
import { SettingsReview } from "./SettingsReview";
import { SettingsSearch } from "./SettingsSearch";
import { ProjectWizard } from "./ProjectWizard";
import { NotificationSettings } from "./NotificationSettings";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Callout, Card } from "../ui/Card";
import { Drawer } from "../ui/Drawer";
import { Field, TextArea } from "../ui/Field";
import { PageHeader } from "../ui/PageHeader";
import { Select } from "../ui/Select";
import { SkeletonText } from "../ui/Skeleton";

interface Props {
  project: string;
  refreshKey: number;
  /** The URL: its tab is the page, its detail the field or section to show there */
  route: Route;
  /** Go to another URL (a search pick) */
  go: (route: Route) => void;
}

function applyChangesLocally(values: Record<string, unknown>, request: SaveRequest): Record<string, unknown> {
  let next: unknown = values;
  for (const change of request.changes ?? []) next = setIn(next, change.path, change.remove ? undefined : change.value);
  return next as Record<string, unknown>;
}

export function Settings({ project, refreshKey, route, go }: Props) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [sections, setSections] = useState<SettingsSection[]>([]);
  const [projects, setProjects] = useState<ProjectFileInfo[]>([]);
  const [selected, setSelected] = useState(project);
  const [view, setView] = useState<ProjectSettingsView | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [yaml, setYaml] = useState("");
  const [review, setReview] = useState<SettingsCheck | null>(null);
  const [reviewed, setReviewed] = useState<SaveRequest | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Bumped on each search pick, so picking the same field again shows it again
  const [nonce, setNonce] = useState(0);
  const page = pageOf(route.tab);

  const clearReview = () => {
    setReview(null);
    setReviewed(null);
    setConfirmed(false);
  };

  /** Read the project's file again (the draft starts over from it); its view, or null when it can't be read. */
  const loadProject = useCallback(async (id: string): Promise<ProjectSettingsView | null> => {
    setError(null);
    const reply = await loadProjectSettings(id);
    if (!reply.success || !reply.data) {
      setView(null);
      setError(reply.error ?? "Could not load the project");
      return null;
    }
    const fresh = reply.data;
    setView(fresh);
    setDraft(fresh.values ?? {});
    setYaml(fresh.yaml);
    setReview(null);
    setReviewed(null);
    setConfirmed(false);
    return fresh;
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

  const index = useMemo(() => fieldIndex(sections), [sections]);
  const changes = useMemo(() => (view ? diffValues(view.values ?? {}, draft) : []), [view, draft]);
  const yamlDirty = view !== null && yaml !== view.yaml;
  const formDirty = changes.length > 0;
  const dirty = yamlDirty || formDirty;
  const errors: FieldError[] = review?.errors ?? view?.errors ?? [];
  const focus = useMemo((): FormFocus | null => {
    if (page !== "classic" || !route.detail) return null;
    const target = fieldTarget(sections, route.detail);
    return target ? { ...target, nonce } : null;
  }, [page, route.detail, sections, nonce]);

  // A link to the notifications card (it is not a section of the project's file)
  useEffect(() => {
    if (page !== "classic" || route.detail !== "notifications") return;
    const card = document.getElementById("settings-notifications");
    if (card && typeof card.scrollIntoView === "function") card.scrollIntoView({ block: "start" });
  }, [page, route.detail, nonce, view]);

  if (signedIn !== true) {
    return (
      <div>
        <PageHeader title="Settings" />
        <SignInHint what="Reading and changing settings" refreshKey={refreshKey} onStatus={setSignedIn} />
        {signedIn === null && <p className="muted small">Checking this browser's owner session...</p>}
      </div>
    );
  }

  const request = (): SaveRequest | null => {
    if (!view) return null;
    return yamlDirty ? { baseHash: view.hash, yaml } : { baseHash: view.hash, changes };
  };

  const dryRun = async (id: string, r: SaveRequest) => {
    setChecking(true);
    setError(null);
    const reply = await checkProjectSettings(id, r);
    setChecking(false);
    if (reply.success && reply.data) {
      setReview(reply.data);
      setReviewed(r);
      setConfirmed(false);
    } else {
      clearReview();
      setError(reply.error ?? "Could not check the change");
    }
  };

  const openReview = () => {
    const r = request();
    if (!r || !view) return;
    setMessage(null);
    setReviewOpen(true);
    void dryRun(view.id, r);
  };

  const save = async () => {
    if (!view || !review || !reviewed) return;
    setBusy(true);
    const reply = await saveProjectSettings(view.id, { ...reviewed, confirmCommands: review.commandsDigest || undefined });
    setBusy(false);
    if (reply.success && reply.data) {
      const result = reply.data;
      setReviewOpen(false);
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

  // After a 409: the current file, with the same changes made again on top of it, checked again
  const rebase = async () => {
    if (!view || !reviewed) return;
    const pending = reviewed;
    const fresh = await loadProject(view.id);
    if (!fresh) return;
    if (pending.changes) {
      setDraft(applyChangesLocally(fresh.values ?? {}, pending));
      await dryRun(fresh.id, { baseHash: fresh.hash, changes: pending.changes });
      setMessage("Loaded the current file and made your changes again on top of it: review them before saving");
    } else {
      setReviewOpen(false);
      setMessage("Loaded the current file; your YAML text was replaced by it");
    }
  };

  const discard = () => {
    if (!view) return;
    setDraft(view.values ?? {});
    setYaml(view.yaml);
    clearReview();
    setMessage(null);
  };

  const onChange = (path: PathSegment[], value: unknown) => {
    setDraft((d) => setIn(d, path, value) as Record<string, unknown>);
    clearReview();
  };

  const onPick = (entry: SearchEntry) => {
    setNonce((n) => n + 1);
    go({ section: "settings", tab: tabOf(entry.page), detail: entry.key, project: route.project });
  };

  const about = SETTINGS_PAGES.find((p) => p.id === page)!;
  const general = generalErrors(errors, sections);
  const pendingKeys = reviewed?.changes?.map((c) => pathKey(c.path)) ?? [];

  const renderPage = () => {
    if (!view) return null;
    switch (page) {
      case "overview":
        return <SettingsOverview view={view} project={route.project} />;
      case "classic":
        return (
          <>
            {general.length > 0 && (
              <Callout tone="danger" className="section-intro" title="Problems no field owns">
                {general.map((e, i) => (
                  <div key={i}>
                    {e.path ? <code>{e.path}</code> : "file"}: {e.message}
                  </div>
                ))}
              </Callout>
            )}
            {view.values === null ? (
              <Callout tone="danger">The file doesn't parse as YAML; fix it on the YAML page.</Callout>
            ) : (
              <>
                <Card title="Secrets" className="section-intro">
                  <p className="muted small">Never in the YAML: Lair reads them from data/ files and environment variables.</p>
                  {view.secrets.map((s) => (
                    <div key={`${s.where}${s.label}`} className="muted small">
                      <Badge tone={s.set ? "badge-success" : "badge-neutral"}>{s.set ? "set" : "not set"}</Badge> {s.label}:{" "}
                      <code>{s.where}</code>
                    </div>
                  ))}
                </Card>
                <SettingsForm
                  sections={sections}
                  draft={draft}
                  known={view.known}
                  errors={errors}
                  unknownKeys={view.unknownKeys}
                  disabled={busy || yamlDirty}
                  onChange={onChange}
                  focus={focus}
                />
              </>
            )}
            {/* Lair's own settings (data/server.yaml), apart from the project's */}
            <div id="settings-notifications">
              <NotificationSettings />
            </div>
          </>
        );
      case "yaml":
        return (
          <>
            {formDirty && (
              <Callout tone="info" className="section-intro">
                You have {unsavedText(changes.length)} from the other pages. Review and save them, or discard them, before you
                edit the YAML.
              </Callout>
            )}
            <Field label="The project's file" help="Saved through the same checks and review as every other page.">
              <TextArea
                data-settings-yaml=""
                className="mono settings-yaml"
                value={yaml}
                spellCheck={false}
                readOnly={formDirty}
                onChange={(e) => {
                  setYaml(e.target.value);
                  clearReview();
                }}
              />
            </Field>
          </>
        );
      case "history":
        return (
          <>
            {dirty && (
              <Callout tone="info" className="section-intro">
                You have unsaved changes: restoring a version replaces the file, so save or discard them first.
              </Callout>
            )}
            <SettingsHistory
              project={view.id}
              baseHash={view.hash}
              onRestored={(text) => {
                void loadProject(view.id);
                setMessage(text);
              }}
            />
          </>
        );
    }
  };

  return (
    <div data-settings-view="" className="settings-shell">
      <PageHeader
        title="Settings"
        subtitle={view ? <code>{view.file}</code> : undefined}
        actions={
          <>
            <Select
              compact
              aria-label="Project"
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
            </Select>
            <Button size="sm" onClick={() => setCreating(true)}>
              New project
            </Button>
          </>
        }
      />

      <div className="settings-toolbar">
        <SettingsSearch index={index} onPick={onPick} />
      </div>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings pages">
          <ul>
            {SETTINGS_PAGES.map((p) => (
              <li key={p.id}>
                <a
                  href={pageHref(p.id, null, route.project)}
                  className={`settings-nav-link${p.id === page ? " active" : ""}`}
                  aria-current={p.id === page ? "page" : undefined}
                >
                  {p.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="settings-page" data-settings-page={page}>
          <h3 className="settings-page-title">{about.label}</h3>
          <p className="muted small settings-page-about">{about.about}</p>

          {message && (
            <Callout tone="success" className="section-intro" data-settings-message="">
              {message}
            </Callout>
          )}
          {error && !reviewOpen && (
            <Callout tone="danger" alert className="section-intro">
              {error}
            </Callout>
          )}

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

          {view && !creating && (
            <>
              {!view.local && page !== "history" && (
                <Callout tone="warning" className="section-intro" data-tracked-hint="" title="This file is tracked by git.">
                  <code>{view.file}</code> is in <code>projects/</code>, which git tracks in Lair's checkout: saving changes it
                  there, and git shows the change. To keep this project's settings private, copy it to{" "}
                  <code>projects/local/{view.id}.yaml</code> (git-ignored); Settings then edits that file.
                </Callout>
              )}
              {yamlDirty && page !== "yaml" && (
                <Callout tone="info" className="section-intro">
                  The YAML is edited: review and save it, or discard it, before you change anything on this page.
                </Callout>
              )}
              {renderPage()}
            </>
          )}
        </div>
      </div>

      {dirty && view && (
        <div className="settings-savebar" role="region" aria-label="Unsaved changes" data-settings-savebar="">
          <span className="settings-savebar-count" data-settings-unsaved="">
            {yamlDirty ? "The YAML is edited" : unsavedText(changes.length)}
          </span>
          <span aria-hidden="true">·</span>
          <Button variant="primary" size="sm" disabled={busy} onClick={openReview}>
            Review and save
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={discard}>
            Discard
          </Button>
        </div>
      )}

      {reviewOpen && view && (
        <Drawer title="Review and save" size="lg" onClose={() => setReviewOpen(false)} subtitle={<code>{view.file}</code>}>
          <div data-settings-review-drawer="">
            {pendingKeys.length > 0 && (
              <div className="section-intro">
                <h3 className="small">What changes</h3>
                <ul className="settings-changed-keys" data-settings-changed-keys="">
                  {pendingKeys.map((key, i) => (
                    <li key={`${i}-${key}`}>
                      <code>{key}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {message && (
              <Callout tone="info" className="section-intro">
                {message}
              </Callout>
            )}
            {error && (
              <Callout tone="danger" alert className="section-intro">
                {error}
              </Callout>
            )}
            {checking && (
              <div aria-busy="true">
                <p className="muted small">Checking the change with the same parsers the server loads it with...</p>
                <SkeletonText lines={4} />
              </div>
            )}
            {review && !checking && (
              <SettingsReview
                check={review}
                confirmed={confirmed}
                onConfirm={setConfirmed}
                onSave={() => void save()}
                saving={busy}
                onRebase={() => void rebase()}
                rebaseLabel={reviewed?.changes ? "Review again on top of the current file" : "Load the current file (drops your text)"}
              />
            )}
          </div>
        </Drawer>
      )}
    </div>
  );
}
