/**
 * Settings → AI (docs/design/settings-v2.md, ai-roles.md):
 * - Tools: each tool Lair can start, per machine: installed, its version
 *   and its sign-in state, with the exact command that fixes it, and
 *   Refresh (the checks run again now). Only the server's fixed words are
 *   shown, never a tool's output.
 * - Profiles: a tool and a model with a name, edited in a drawer. The tool
 *   is a preset or one of the project's adapters; the model is a dropdown
 *   of that tool's own list.
 * - Roles: who builds, reviews each risk tier, plans and supervises. Each is
 *   an ordered list of profiles: the first is used, the next ones are its
 *   fallbacks.
 * Every edit goes into the shell's draft, saved through its review.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AiToolsView, ToolMachineStatus, ToolStatusView } from "../../shared/ai-types";
import type { FieldError, SettingsSection } from "../../shared/settings-types";
import { loadAiTools, refreshAiTools } from "../ai-api";
import {
  moveItem,
  profileIdProblem,
  profileIds,
  profilesOf,
  removeProfile,
  roleDefs,
  roleList,
  setProfile,
  setRole,
  toolChoices,
  type Choice,
  type Draft,
  type ProfileRow,
  type RoleDef,
} from "../ai-settings";
import { Badge, StatusBadge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Callout, Card } from "../ui/Card";
import { Drawer } from "../ui/Drawer";
import { EmptyState } from "../ui/EmptyState";
import { Field, Input } from "../ui/Field";
import { Select } from "../ui/Select";
import { Table, type Column } from "../ui/Table";
import { ModelPicker } from "./ModelPicker";

/** A key to show on the page (a search pick or a link), and the pick's number */
export interface PageFocus {
  key: string;
  nonce: number;
}

interface Props {
  project: string;
  draft: Draft;
  sections: SettingsSection[];
  /** The tools the project's file knows (presets and agent_adapters): view.known.adapters */
  known: string[];
  errors: FieldError[];
  disabled: boolean;
  onDraft: (next: Draft) => void;
  focus: PageFocus | null;
}

const NEW = "\u0000new";

/** Scroll to the element and focus its first control (jsdom has no scrollIntoView). */
export function revealIn(root: HTMLElement | null, selector: string): void {
  const el = root?.querySelector<HTMLElement>(selector);
  if (!el) return;
  if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
  el.querySelector<HTMLElement>("select, input, button")?.focus();
}

export function SettingsAi({ project, draft, sections, known, errors, disabled, onDraft, focus }: Props) {
  const [tools, setTools] = useState<AiToolsView | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const roles = useMemo(() => roleDefs(sections), [sections]);
  const profiles = profilesOf(draft, roles);
  const ids = profileIds(draft);
  const choices = toolChoices(draft, tools, known);

  useEffect(() => {
    let cancelled = false;
    void loadAiTools(project).then((reply) => {
      if (cancelled) return;
      if (reply.success && reply.data) setTools(reply.data);
      else setToolsError(reply.error ?? "The tools could not be checked");
    });
    return () => {
      cancelled = true;
    };
  }, [project]);

  // A search pick: the role, or the profiles
  const key = focus?.key;
  const nonce = focus?.nonce;
  useEffect(() => {
    if (!key) return;
    if (key.startsWith("ai.roles.")) {
      const path = key.slice("ai.roles.".length);
      revealIn(root.current, root.current?.querySelector(`[data-role="${path}"]`) ? `[data-role="${path}"]` : "[data-ai-roles]");
    } else if (key === "ai.roles") {
      revealIn(root.current, "[data-ai-roles]");
    } else if (key.startsWith("ai.profiles")) {
      revealIn(root.current, "[data-ai-profiles]");
    }
  }, [key, nonce]);

  const refresh = async () => {
    setRefreshing(true);
    const reply = await refreshAiTools(project);
    setRefreshing(false);
    if (reply.success && reply.data) {
      setTools(reply.data);
      setToolsError(null);
    } else {
      setToolsError(reply.error ?? "The tools could not be checked");
    }
  };

  const editingRow = editing && editing !== NEW ? (profiles.find((p) => p.id === editing) ?? null) : null;
  const profileColumns: Column<ProfileRow>[] = [
    { key: "id", label: "Profile", render: (p) => <code>{p.id}</code>, sort: (p) => p.id },
    { key: "tool", label: "Tool", render: (p) => p.tool, sort: (p) => p.tool },
    { key: "model", label: "Model", render: (p) => p.model, sort: (p) => p.model },
    { key: "used", label: "Used by", render: (p) => (p.usedBy.length > 0 ? p.usedBy.join(", ") : <span className="muted">nobody yet</span>) },
  ];
  const aiErrors = errors.filter((e) => e.path === "ai" || e.path.startsWith("ai."));

  return (
    <div ref={root} data-settings-ai="">
      {aiErrors.length > 0 && (
        <Callout tone="danger" className="section-intro" title="The check refused these">
          {aiErrors.map((e, i) => (
            <div key={i}>
              <code>{e.path}</code>: {e.message}
            </div>
          ))}
        </Callout>
      )}

      <ToolsCard tools={tools} error={toolsError} refreshing={refreshing} onRefresh={() => void refresh()} />

      <Card
        title="Profiles"
        className="section-intro"
        data-ai-profiles=""
        actions={
          <Button size="sm" disabled={disabled} onClick={() => setEditing(NEW)}>
            Add a profile
          </Button>
        }
      >
        <Table
          label="Profiles"
          columns={profileColumns}
          rows={profiles}
          rowKey={(p) => p.id}
          onOpen={disabled ? undefined : (p) => setEditing(p.id)}
          selected={editingRow?.id ?? null}
          empty={
            <EmptyState
              framed={false}
              title="No profiles yet"
              action={
                <Button size="sm" variant="primary" disabled={disabled} onClick={() => setEditing(NEW)}>
                  Add a profile
                </Button>
              }
            >
              A profile is a tool and a model with a name. Roles and agents name a profile, so changing who does a job is one
              dropdown.
            </EmptyState>
          }
        />
      </Card>

      <Card title="Roles" className="section-intro" data-ai-roles="">
        <p className="muted small">
          Each role is an ordered list of profiles: the first does the job, and the next ones take over when it fails. A
          role left unset is not automated.
        </p>
        {ids.length === 0 && (
          <Callout tone="info" className="mb-3">
            Add a profile first: a role names profiles.
          </Callout>
        )}
        <div className="roles">
          {roles.map((role) => (
            <RoleEditor
              key={role.path}
              role={role}
              list={roleList(draft, role)}
              profiles={ids}
              errors={errors.filter((e) => {
                const at = `ai.roles.${role.path}`;
                return e.path === at || e.path.startsWith(`${at}[`) || e.path.startsWith(`${at}.`);
              })}
              disabled={disabled}
              onChange={(list) => onDraft(setRole(draft, role, list))}
            />
          ))}
        </div>
      </Card>

      {editing && (
        <ProfileDrawer
          project={project}
          row={editingRow}
          ids={ids}
          choices={choices}
          onClose={() => setEditing(null)}
          onApply={(id, tool, model) => {
            onDraft(setProfile(draft, id, tool, model));
            setEditing(null);
          }}
          onRemove={(id) => {
            onDraft(removeProfile(draft, id));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

// ============ TOOLS ============

interface ToolRow {
  key: string;
  tool: ToolStatusView;
  machine: ToolMachineStatus;
}

const where = (machine: string) => (machine === "local" ? "this machine" : machine);

function installedBadge(m: ToolMachineStatus) {
  if (m.installed === true) return <StatusBadge status="ok">installed</StatusBadge>;
  if (m.installed === false) return <StatusBadge status="off">not installed</StatusBadge>;
  return <StatusBadge status="waiting">can't tell</StatusBadge>;
}

function signInBadge(m: ToolMachineStatus) {
  if (m.signIn.state === "signed_in") return <StatusBadge status="ok">signed in</StatusBadge>;
  if (m.signIn.state === "signed_out") return <StatusBadge status="attention">not signed in</StatusBadge>;
  return <StatusBadge status="off">can't tell</StatusBadge>;
}

function fixOf(row: ToolRow) {
  const { tool, machine } = row;
  if (machine.installed === false) return <span className="small">Install {tool.program ?? tool.name} on {where(machine.machine)}</span>;
  if (machine.signIn.state === "signed_out" && machine.signIn.fix) {
    return (
      <span className="small">
        Run <code>{machine.signIn.fix}</code> in a terminal on {where(machine.machine)}
      </span>
    );
  }
  return <span className="muted small">—</span>;
}

const toolColumns: Column<ToolRow>[] = [
  {
    key: "tool",
    label: "Tool",
    render: (r) => (
      <span>
        {r.tool.name} <code className="muted small">{r.tool.id}</code> {r.tool.experimental && <Badge tone="info">experimental</Badge>}
      </span>
    ),
    sort: (r) => r.tool.name,
  },
  { key: "machine", label: "Machine", render: (r) => r.machine.machine, sort: (r) => r.machine.machine },
  { key: "installed", label: "Installed", render: (r) => installedBadge(r.machine) },
  { key: "version", label: "Version", render: (r) => r.machine.version ?? <span className="muted">—</span> },
  {
    key: "signin",
    label: "Signed in",
    render: (r) => (
      <span className="stack-xs" data-sign-in={r.machine.signIn.state}>
        {signInBadge(r.machine)} <span className="muted small">{r.machine.signIn.detail}</span>
      </span>
    ),
  },
  { key: "fix", label: "Fix", render: fixOf },
];

function ToolsCard({ tools, error, refreshing, onRefresh }: { tools: AiToolsView | null; error: string | null; refreshing: boolean; onRefresh: () => void }) {
  const used = (tools?.tools ?? []).filter((t) => t.inUse);
  const others = (tools?.tools ?? []).filter((t) => !t.inUse);
  const rows: ToolRow[] = used.flatMap((tool) => tool.machines.map((machine) => ({ key: `${tool.id}@${machine.machine}`, tool, machine })));
  return (
    <Card
      title="Tools"
      className="section-intro"
      data-ai-tools=""
      actions={
        <Button size="sm" disabled={refreshing || (!tools && !error)} onClick={onRefresh}>
          {refreshing ? "Checking..." : "Refresh"}
        </Button>
      }
    >
      <p className="muted small">
        Lair never signs in for you and never reads a tool's tokens: each tool's own check says whether it is ready, on each
        machine it runs on.
      </p>
      {error && (
        <Callout tone="danger" className="mb-3">
          Could not check the tools: {error}
        </Callout>
      )}
      {!tools && !error && <p className="muted small">Checking the tools...</p>}
      {tools && (
        <Table
          label="Tools in use, per machine"
          columns={toolColumns}
          rows={rows}
          rowKey={(r) => r.key}
          empty={
            <EmptyState framed={false} title="No tool in use yet">
              A tool is in use once a profile or an agent names it.
            </EmptyState>
          }
        />
      )}
      {tools && tools.notes.length > 0 && (
        <ul className="muted small mt-2">
          {tools.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <details className="mt-3">
          <summary className="small">Other tools Lair can start ({others.length})</summary>
          <ul className="small">
            {others.map((t) => {
              const local = t.machines.find((m) => m.machine === "local");
              return (
                <li key={t.id}>
                  {t.name} <code className="muted">{t.id}</code>
                  {t.experimental ? " (experimental)" : ""}:{" "}
                  {local?.installed ? "installed here" : local?.installed === false ? "not installed here" : "not checked"}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </Card>
  );
}

// ============ ROLES ============

function RoleEditor({
  role,
  list,
  profiles,
  errors,
  disabled,
  onChange,
}: {
  role: RoleDef;
  list: string[];
  profiles: string[];
  errors: FieldError[];
  disabled: boolean;
  onChange: (list: string[]) => void;
}) {
  const unused = profiles.filter((p) => !list.includes(p));
  const position = (i: number) => (i === 0 ? "primary" : `fallback ${i}`);
  const hidden = (what: string) => <span className="visually-hidden">{`: ${what} in ${role.label}`}</span>;
  return (
    <fieldset className="fieldset role-editor" data-role={role.path}>
      <legend>{role.label}</legend>
      {role.help && <p className="field-help">{role.help}</p>}
      {list.length === 0 ? (
        <Select
          aria-label={`${role.label}: primary`}
          value=""
          disabled={disabled || profiles.length === 0}
          data-role-slot="0"
          onChange={(e) => {
            if (e.target.value) onChange([e.target.value]);
          }}
        >
          <option value="">Not set</option>
          {profiles.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </Select>
      ) : (
        <ol className="role-list">
          {list.map((id, i) => (
            <li key={`${i}-${id}`} className="row role-entry" data-role-entry={id}>
              <Select
                aria-label={`${role.label}: ${position(i)}`}
                value={id}
                disabled={disabled}
                data-role-slot={String(i)}
                onChange={(e) => onChange(list.map((p, j) => (j === i ? e.target.value : p)))}
              >
                {[id, ...unused].map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
              <span className="muted small">{position(i)}</span>
              <Button size="sm" variant="ghost" data-move="up" disabled={disabled || i === 0} onClick={() => onChange(moveItem(list, i, i - 1))}>
                Up{hidden(id)}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-move="down"
                disabled={disabled || i === list.length - 1}
                onClick={() => onChange(moveItem(list, i, i + 1))}
              >
                Down{hidden(id)}
              </Button>
              <Button size="sm" variant="ghost" data-move="remove" disabled={disabled} onClick={() => onChange(list.filter((_, j) => j !== i))}>
                Remove{hidden(id)}
              </Button>
            </li>
          ))}
        </ol>
      )}
      {list.length > 0 && unused.length > 0 && (
        <Select
          aria-label={`${role.label}: add a fallback`}
          value=""
          disabled={disabled}
          data-role-add=""
          onChange={(e) => {
            if (e.target.value) onChange([...list, e.target.value]);
          }}
        >
          <option value="">Add a fallback…</option>
          {unused.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </Select>
      )}
      {errors.map((e, i) => (
        <p key={i} className="field-error" role="alert">
          {e.message}
        </p>
      ))}
    </fieldset>
  );
}

// ============ A PROFILE'S DRAWER ============

/**
 * A tool select: the presets, then the project's own adapters (the current
 * value is kept as an option). A Field names it: it takes the Field's id and
 * description.
 */
export function ToolSelect({
  value,
  choices,
  onChange,
  disabled,
  id,
  "aria-describedby": describedBy,
}: {
  value: string;
  choices: { presets: Choice[]; custom: Choice[] };
  onChange: (tool: string) => void;
  disabled?: boolean;
  id?: string;
  "aria-describedby"?: string;
}) {
  const all = [...choices.presets, ...choices.custom].map((c) => c.value);
  return (
    <Select
      id={id}
      aria-describedby={describedBy}
      value={value}
      disabled={disabled}
      data-tool-select=""
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Choose a tool</option>
      {value && !all.includes(value) && <option value={value}>{value}</option>}
      <optgroup label="Presets">
        {choices.presets.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </optgroup>
      {choices.custom.length > 0 && (
        <optgroup label="This project's adapters">
          {choices.custom.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </optgroup>
      )}
    </Select>
  );
}

function ProfileDrawer({
  project,
  row,
  ids,
  choices,
  onClose,
  onApply,
  onRemove,
}: {
  project: string;
  /** null: a new profile */
  row: ProfileRow | null;
  ids: string[];
  choices: { presets: Choice[]; custom: Choice[] };
  onClose: () => void;
  onApply: (id: string, tool: string, model: string) => void;
  onRemove: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [tool, setTool] = useState(row?.tool ?? "");
  const [model, setModel] = useState(row?.model ?? "");
  const idProblem = row ? null : profileIdProblem(name.trim(), ids);
  const ready = idProblem === null && tool !== "" && model !== "";
  return (
    <Drawer
      title={row ? `Profile ${row.id}` : "Add a profile"}
      subtitle="A tool and a model, with a name that roles and agents use"
      onClose={onClose}
    >
      <form
        data-profile-form=""
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) onApply(row ? row.id : name.trim(), tool, model);
        }}
      >
        {!row && (
          <Field label="Name" help="A letter first, then letters, digits, '.', '_' or '-'" error={name !== "" ? idProblem : null}>
            <Input value={name} spellCheck={false} data-profile-name="" onChange={(e) => setName(e.target.value)} />
          </Field>
        )}
        <Field label="Tool" help="A preset Lair knows, or one of this project's adapters (agent_adapters)">
          <ToolSelect
            value={tool}
            choices={choices}
            onChange={(next) => {
              setTool(next);
              // The new tool's own list is read: its models, not the last tool's
              setModel("");
            }}
          />
        </Field>
        <ModelPicker project={project} tool={tool} value={model} onChange={setModel} />
        {row && row.usedBy.length > 0 && (
          <p className="muted small mt-3">
            Used by {row.usedBy.join(", ")}. Removing the profile needs them to name another first; the check says so.
          </p>
        )}
        <div className="row mt-4">
          <Button type="submit" variant="primary" disabled={!ready}>
            {row ? "Apply" : "Add"}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          {row && (
            <Button variant="danger" onClick={() => onRemove(row.id)}>
              Remove the profile
            </Button>
          )}
        </div>
        <p className="muted small mt-2">Nothing is written yet: the change joins your unsaved changes, saved with Review and save.</p>
      </form>
    </Drawer>
  );
}
