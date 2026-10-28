/**
 * Settings → Team (docs/design/settings-v2.md): the agents (dragons) as a
 * table: name, role, profile (or tool + model), machine and state. A row
 * opens its drawer, where it runs on a profile, a tool and a model (the
 * model from that tool's own list), or its role's first profile. Select
 * rows to move them all to one profile. Every edit goes into the shell's
 * draft, saved through its review.
 */
import { useEffect, useRef, useState } from "react";
import type { AiToolsView } from "../../shared/ai-types";
import type { FieldError, KnownValues } from "../../shared/settings-types";
import type { Dragon } from "../../shared/types";
import { loadAiTools } from "../ai-api";
import {
  agentIdProblem,
  agentsOf,
  moveToProfile,
  profileIds,
  removeAgent,
  setAgent,
  setRunsOn,
  toolChoices,
  type AgentRow,
  type Draft,
  type RunsOn,
} from "../ai-settings";
import { ownerCall } from "../settings-api";
import { Button } from "../ui/Button";
import { Callout, Card } from "../ui/Card";
import { Drawer } from "../ui/Drawer";
import { EmptyState } from "../ui/EmptyState";
import { Field, Input } from "../ui/Field";
import { Select } from "../ui/Select";
import { Table, type Column } from "../ui/Table";
import { ModelPicker } from "./ModelPicker";
import { ToolSelect, revealIn, type PageFocus } from "./SettingsAi";

interface Props {
  project: string;
  draft: Draft;
  known: KnownValues;
  errors: FieldError[];
  disabled: boolean;
  onDraft: (next: Draft) => void;
  focus: PageFocus | null;
}

const NEW = "\u0000new";

export function SettingsTeam({ project, draft, known, errors, disabled, onDraft, focus }: Props) {
  const [tools, setTools] = useState<AiToolsView | null>(null);
  const [states, setStates] = useState<Map<string, string> | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [target, setTarget] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const rows = agentsOf(draft);
  const profiles = profileIds(draft);

  useEffect(() => {
    let cancelled = false;
    void loadAiTools(project).then((reply) => {
      if (!cancelled && reply.success && reply.data) setTools(reply.data);
    });
    // The roster's running state (the launcher's, or Lair's when it supervises the agent)
    void ownerCall<Dragon[]>("GET", `/api/dragons?project=${encodeURIComponent(project)}`).then((reply) => {
      if (!cancelled && reply.success && Array.isArray(reply.data)) {
        setStates(new Map(reply.data.map((d) => [d.id, d.running ? "running" : "idle"])));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [project]);

  const key = focus?.key;
  const nonce = focus?.nonce;
  useEffect(() => {
    if (key) revealIn(root.current, "[data-team-agents]");
  }, [key, nonce]);

  // Agents removed from the draft leave the selection
  const chosen = selected.filter((id) => rows.some((r) => r.id === id));
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const columns: Column<AgentRow>[] = [
    {
      key: "select",
      label: "Select",
      render: (r) => (
        <input
          type="checkbox"
          aria-label={`Select ${r.id}`}
          checked={chosen.includes(r.id)}
          disabled={disabled}
          data-select-agent={r.id}
          // The row opens the agent's drawer; the box only selects it
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onChange={() => toggle(r.id)}
        />
      ),
    },
    {
      key: "name",
      label: "Name",
      render: (r) => (
        <span>
          {r.name} <code className="muted small">{r.id}</code>
        </span>
      ),
      sort: (r) => r.name,
    },
    { key: "role", label: "Role", render: (r) => r.role, sort: (r) => r.role },
    { key: "runs", label: "Profile (or tool + model)", render: (r) => <span data-runs={r.id}>{r.runs}</span>, sort: (r) => r.runs },
    { key: "machine", label: "Machine", render: (r) => r.machine, sort: (r) => r.machine },
    { key: "state", label: "State", render: (r) => states?.get(r.id) ?? <span className="muted">not known</span> },
  ];

  const editingRow = editing && editing !== NEW ? (rows.find((r) => r.id === editing) ?? null) : null;
  const teamErrors = errors.filter((e) => e.path === "dragons" || e.path.startsWith("dragons."));

  return (
    <div ref={root} data-settings-team="">
      {teamErrors.length > 0 && (
        <Callout tone="danger" className="section-intro" title="The check refused these">
          {teamErrors.map((e, i) => (
            <div key={i}>
              <code>{e.path}</code>: {e.message}
            </div>
          ))}
        </Callout>
      )}
      <Card
        title="Agents"
        data-team-agents=""
        actions={
          <Button size="sm" disabled={disabled} onClick={() => setEditing(NEW)}>
            Add an agent
          </Button>
        }
      >
        {chosen.length > 0 && (
          <div className="row bulk-bar mb-3" role="region" aria-label="Change the selected agents" data-bulk="">
            <strong>{chosen.length} selected</strong>
            <Select compact aria-label="The profile to move the selected agents to" value={target} disabled={disabled} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Move to profile…</option>
              {profiles.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              variant="primary"
              disabled={disabled || target === ""}
              onClick={() => {
                onDraft(moveToProfile(draft, chosen, target));
                setSelected([]);
                setTarget("");
              }}
            >
              Move
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
              Clear the selection
            </Button>
          </div>
        )}
        <Table
          label="Agents"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          onOpen={disabled ? undefined : (r) => setEditing(r.id)}
          selected={editingRow?.id ?? null}
          empty={
            <EmptyState
              framed={false}
              title="No agents yet"
              action={
                <Button size="sm" variant="primary" disabled={disabled} onClick={() => setEditing(NEW)}>
                  Add an agent
                </Button>
              }
            >
              An agent (a dragon) takes tasks and works on them with an AI tool. Give it a profile, or a tool and a model, and
              the machine it runs on.
            </EmptyState>
          }
        />
      </Card>

      {editing && (
        <AgentDrawer
          project={project}
          row={editingRow}
          ids={rows.map((r) => r.id)}
          profiles={profiles}
          machines={known.machines.length > 0 ? known.machines : ["local"]}
          choices={toolChoices(draft, tools, known.adapters)}
          onClose={() => setEditing(null)}
          onApply={(id, name, machine, on) => {
            onDraft(setRunsOn(setAgent(draft, id, name, machine), id, on));
            setEditing(null);
          }}
          onRemove={(id) => {
            onDraft(removeAgent(draft, id));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function AgentDrawer({
  project,
  row,
  ids,
  profiles,
  machines,
  choices,
  onClose,
  onApply,
  onRemove,
}: {
  project: string;
  /** null: a new agent */
  row: AgentRow | null;
  ids: string[];
  profiles: string[];
  machines: string[];
  choices: Parameters<typeof ToolSelect>[0]["choices"];
  onClose: () => void;
  onApply: (id: string, name: string, machine: string, on: RunsOn) => void;
  onRemove: (id: string) => void;
}) {
  const start = row?.runsOn ?? { kind: "role" as const };
  const [id, setId] = useState("");
  const [name, setName] = useState(row?.name === row?.id ? "" : (row?.name ?? ""));
  const [machine, setMachine] = useState(row?.machine ?? "local");
  const [kind, setKind] = useState<RunsOn["kind"]>(start.kind);
  const [profile, setProfile] = useState(start.kind === "profile" ? start.profile : (profiles[0] ?? ""));
  const [tool, setTool] = useState(start.kind === "own" ? start.tool : "");
  const [model, setModel] = useState(start.kind === "own" ? start.model : "");
  const idProblem = row ? null : agentIdProblem(id.trim(), ids);
  const on: RunsOn = kind === "profile" ? { kind, profile } : kind === "own" ? { kind, tool, model } : { kind };
  const ready = idProblem === null && (kind !== "profile" || profile !== "") && (kind !== "own" || (tool !== "" && model !== ""));
  const options = (kind_: RunsOn["kind"], label: string, detail: string) => (
    <label className="check-label role-choice">
      <input type="radio" name="runs-on" value={kind_} checked={kind === kind_} onChange={() => setKind(kind_)} data-runs-on={kind_} />
      <span>
        {label} <span className="muted small">{detail}</span>
      </span>
    </label>
  );
  return (
    <Drawer title={row ? `Agent ${row.id}` : "Add an agent"} subtitle={row ? `Role: ${row.role}` : undefined} onClose={onClose}>
      <form
        data-agent-form=""
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) onApply(row ? row.id : id.trim(), name, machine, on);
        }}
      >
        {!row && (
          <Field label="Id" help="Its key under dragons: letters, digits, '.', '_' or '-'" error={id !== "" ? idProblem : null}>
            <Input value={id} spellCheck={false} data-agent-id="" onChange={(e) => setId(e.target.value)} />
          </Field>
        )}
        <Field label="Name" help="Shown in Work; empty: its id">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <fieldset className="fieldset">
          <legend>Runs on</legend>
          {options("profile", "An AI profile", "(a role can fail it over to the profiles after it)")}
          {options("own", "A tool and a model", "of its own")}
          {options("role", "Its role's first profile", "(else dragon_defaults)")}
        </fieldset>
        {kind === "profile" && (
          <Field label="Profile" help={profiles.length === 0 ? "No profiles yet: add one on the AI page" : undefined}>
            <Select value={profile} data-agent-profile="" onChange={(e) => setProfile(e.target.value)}>
              <option value="">Choose a profile</option>
              {profiles.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {kind === "own" && (
          <>
            <Field label="Tool" help="A preset Lair knows, or one of this project's adapters">
              <ToolSelect
                value={tool}
                choices={choices}
                onChange={(next) => {
                  setTool(next);
                  setModel("");
                }}
              />
            </Field>
            <ModelPicker project={project} tool={tool} value={model} onChange={setModel} />
          </>
        )}
        <Field label="Machine" help="Where it runs: this machine (local) or one of the project's machines">
          <Select value={machine} onChange={(e) => setMachine(e.target.value)}>
            {!machines.includes(machine) && <option value={machine}>{machine}</option>}
            {machines.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </Field>
        <div className="row mt-4">
          <Button type="submit" variant="primary" disabled={!ready}>
            {row ? "Apply" : "Add"}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          {row && (
            <Button variant="danger" onClick={() => onRemove(row.id)}>
              Remove the agent
            </Button>
          )}
        </div>
        <p className="muted small mt-2">Nothing is written yet: the change joins your unsaved changes, saved with Review and save.</p>
      </form>
    </Drawer>
  );
}
