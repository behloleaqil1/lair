/**
 * Settings → Repositories (docs/design/project-setup.md §4.2): the repos:
 * list with add, edit and remove; a token scopes banner from the tracker
 * status; and a migration offer when repos: is absent but github: is set.
 */
import { useEffect, useRef, useState } from "react";
import type { TrackerStatusView } from "../../shared/tracker-types";
import type { FieldError } from "../../shared/settings-types";
import { ownerCall } from "../settings-api";
import {
  addRepo,
  allRefsMap,
  hasReposKey,
  legacyGithub,
  MAX_REFS,
  MAX_REPOS,
  migrateFromGithub,
  removeRepo,
  reposOf,
  rowToEntry,
  updateRepo,
  validateRefs,
  validateRepo,
  type Draft,
  type RepoRow,
} from "../settings-repos";
import { Badge, StatusBadge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Callout, Card } from "../ui/Card";
import { Drawer } from "../ui/Drawer";
import { EmptyState } from "../ui/EmptyState";
import { Field, Input } from "../ui/Field";
import { Table, type Column } from "../ui/Table";

interface Props {
  project: string;
  draft: Draft;
  errors: FieldError[];
  disabled: boolean;
  onDraft: (next: Draft) => void;
}

const NEW = -1;

export function SettingsRepos({ project, draft, errors, disabled, onDraft }: Props) {
  const [trackerStatus, setTrackerStatus] = useState<TrackerStatusView | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const rows = reposOf(draft);
  const legacy = legacyGithub(draft);
  const hasRepos = hasReposKey(draft);

  // Load tracker status for token scopes
  useEffect(() => {
    let cancelled = false;
    void ownerCall<TrackerStatusView>("GET", `/api/tracker/status?project=${encodeURIComponent(project)}`).then((reply) => {
      if (!cancelled && reply.success && reply.data) setTrackerStatus(reply.data);
    });
    return () => {
      cancelled = true;
    };
  }, [project]);

  const reposErrors = errors.filter((e) => e.path === "repos" || e.path.startsWith("repos.") || e.path.startsWith("repos["));

  const columns: Column<RepoRow>[] = [
    {
      key: "repo",
      label: "Repository",
      render: (r) => (
        <span>
          <code>{r.repo}</code>
          {r.isDefault && (
            <Badge tone="info" className="ml-2">
              default
            </Badge>
          )}
        </span>
      ),
      sort: (r) => r.repo,
    },
    {
      key: "base",
      label: "Base branch",
      render: (r) => (r.base ? <code>{r.base}</code> : <span className="muted">host default</span>),
      sort: (r) => r.base ?? "",
    },
    {
      key: "ciCounts",
      label: "CI counts",
      render: (r) => (r.ciCounts ? "yes" : <span className="muted">no</span>),
    },
    {
      key: "refs",
      label: "Refs",
      render: (r) =>
        r.refs.length > 0 ? (
          <span>
            {r.refs.map((ref, i) => (
              <code key={i} className="mr-1">
                {ref}
              </code>
            ))}
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
  ];

  const editingRow = editing !== null && editing !== NEW ? (rows.find((r) => r.index === editing) ?? null) : null;

  return (
    <div ref={root} data-settings-repos="">
      <TokenScopesCard status={trackerStatus} />

      {reposErrors.length > 0 && (
        <Callout tone="danger" className="section-intro" title="The check refused these">
          {reposErrors.map((e, i) => (
            <div key={i}>
              <code>{e.path}</code>: {e.message}
            </div>
          ))}
        </Callout>
      )}

      {!hasRepos && legacy && (
        <Callout tone="info" className="section-intro" title="Migrate to the repos: list">
          <p>
            This project uses <code>github: {legacy}</code> but has no <code>repos:</code> list.
            The repos list is used by the ready guard and PR health for multi-repository projects.
          </p>
          <Button
            size="sm"
            variant="primary"
            disabled={disabled}
            onClick={() => onDraft(migrateFromGithub(draft, legacy))}
          >
            Add {legacy} as the first repository
          </Button>
        </Callout>
      )}

      <Card
        title="Repositories"
        data-repos-list=""
        actions={
          rows.length < MAX_REPOS && (
            <Button size="sm" disabled={disabled} onClick={() => setEditing(NEW)}>
              Add a repository
            </Button>
          )
        }
      >
        <Table
          label="Repositories"
          columns={columns}
          rows={rows}
          rowKey={(r) => String(r.index)}
          onOpen={disabled ? undefined : (r) => setEditing(r.index)}
          selected={editingRow ? String(editingRow.index) : null}
          empty={
            <EmptyState
              framed={false}
              title="No repositories yet"
              action={
                <Button size="sm" variant="primary" disabled={disabled} onClick={() => setEditing(NEW)}>
                  Add a repository
                </Button>
              }
            >
              The repos: list names the repositories whose PRs the ready guard and PR health track.
              A bare PR #12 means the default repository.
            </EmptyState>
          }
        />
      </Card>

      {editing !== null && (
        <RepoDrawer
          row={editingRow}
          existingRepos={rows.map((r) => r.repo)}
          allRefs={allRefsMap(rows)}
          onClose={() => setEditing(null)}
          onApply={(entry) => {
            if (editingRow) {
              onDraft(updateRepo(draft, editingRow.index, rowToEntry(entry)));
            } else {
              onDraft(addRepo(draft, rowToEntry(entry)));
            }
            setEditing(null);
          }}
          onRemove={
            editingRow
              ? () => {
                  onDraft(removeRepo(draft, editingRow.index));
                  setEditing(null);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

function TokenScopesCard({ status }: { status: TrackerStatusView | null }) {
  if (!status) {
    return (
      <Card title="Token scopes" className="mb-4">
        <p className="muted">Loading token scopes...</p>
      </Card>
    );
  }
  const { scopes } = status;
  if (!scopes.checked) {
    return (
      <Card title="Token scopes" className="mb-4">
        <p className="muted">Token scopes not checked yet.</p>
      </Card>
    );
  }
  const missing = scopes.missing.length > 0;
  return (
    <Card title="Token scopes" className="mb-4">
      <div className="row gap-2 align-items-center">
        <StatusBadge status={missing ? "attention" : "ok"} />
        {missing ? (
          <span>
            Missing scopes:{" "}
            {scopes.missing.map((s, i) => (
              <code key={i} className="mr-1">
                {s}
              </code>
            ))}
          </span>
        ) : (
          <span>All required scopes are granted.</span>
        )}
      </div>
      {scopes.granted && scopes.granted.length > 0 && (
        <p className="muted small mt-2">
          Granted:{" "}
          {scopes.granted.map((s, i) => (
            <code key={i} className="mr-1">
              {s}
            </code>
          ))}
        </p>
      )}
      {missing && (
        <p className="muted small mt-2">
          Set the token in <code>LAIR_GITHUB_TOKEN</code> or <code>review.token_env</code> with the required scopes.
        </p>
      )}
    </Card>
  );
}

interface RepoDrawerProps {
  /** null: adding a new repository */
  row: RepoRow | null;
  existingRepos: string[];
  allRefs: Map<string, number>;
  onClose: () => void;
  onApply: (entry: Omit<RepoRow, "index">) => void;
  onRemove?: () => void;
}

function RepoDrawer({ row, existingRepos, allRefs, onClose, onApply, onRemove }: RepoDrawerProps) {
  const [repo, setRepo] = useState(row?.repo ?? "");
  const [isDefault, setIsDefault] = useState(row?.isDefault ?? existingRepos.length === 0);
  const [base, setBase] = useState(row?.base ?? "");
  const [ciCounts, setCiCounts] = useState(row?.ciCounts ?? true);
  const [refsText, setRefsText] = useState(row?.refs.join(", ") ?? "");

  const refs = refsText
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const editingIndex = row?.index ?? null;

  const repoError = validateRepo(repo, existingRepos, editingIndex);
  const refsError = validateRefs(refs, allRefs, editingIndex);
  const ready = repoError === null && (refs.length === 0 || refsError === null);

  return (
    <Drawer title={row ? `Edit ${row.repo}` : "Add a repository"} onClose={onClose}>
      <form
        data-repo-form=""
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) {
            onApply({
              repo: repo.trim(),
              isDefault,
              base: base.trim() || null,
              ciCounts,
              refs,
            });
          }
        }}
      >
        <Field label="Repository" help="owner/name on GitHub" error={repo !== "" ? repoError : null}>
          <Input
            value={repo}
            spellCheck={false}
            placeholder="owner/name"
            data-repo-input=""
            onChange={(e) => setRepo(e.target.value)}
          />
        </Field>

        <Field label="Base branch" help="The branch its PRs merge into; empty uses the host's default">
          <Input
            value={base}
            spellCheck={false}
            placeholder="main"
            onChange={(e) => setBase(e.target.value)}
          />
        </Field>

        <Field label="Default" help="A bare PR #12 means this repository">
          <label className="check-label">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              data-repo-default=""
            />
            <span>This is the default repository</span>
          </label>
        </Field>

        <Field label="CI counts" help="Whether hosted CI is a signal for this repository's PRs">
          <label className="check-label">
            <input
              type="checkbox"
              checked={ciCounts}
              onChange={(e) => setCiCounts(e.target.checked)}
            />
            <span>Hosted CI counts</span>
          </label>
        </Field>

        <Field
          label="Refs"
          help={`Short names for this repository: app#12 means this one. Comma-separated, at most ${MAX_REFS}.`}
          error={refs.length > 0 ? refsError : null}
        >
          <Input
            value={refsText}
            spellCheck={false}
            placeholder="app, lib"
            onChange={(e) => setRefsText(e.target.value)}
          />
        </Field>

        <div className="row mt-4">
          <Button type="submit" variant="primary" disabled={!ready}>
            {row ? "Apply" : "Add"}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          {onRemove && (
            <Button variant="danger" onClick={onRemove}>
              Remove
            </Button>
          )}
        </div>
        <p className="muted small mt-2">
          Nothing is written yet: the change joins your unsaved changes, saved with Review and save.
        </p>
      </form>
    </Drawer>
  );
}
