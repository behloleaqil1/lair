/**
 * Settings → AI and Team (docs/design/settings-v2.md, ai-roles.md): the
 * project's AI profiles, roles and agents as the pages show them, the
 * choices their dropdowns offer, and the edits they make. Without a DOM:
 * every edit takes the draft and returns a new one (setIn), which the shell
 * saves through its one review-and-save path into `ai.profiles`,
 * `ai.roles` and `dragons`.
 */
import type { AiModelsView, AiToolsView } from "../shared/ai-types";
import type { SettingsSection } from "../shared/settings-types";
import { isPlainObject } from "../shared/settings-rules";
import { getIn, setIn } from "./settings-form";

export type Draft = Record<string, unknown>;

/** As the server's PROFILE_ID (src/server/ai/profiles.ts) */
export const PROFILE_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
/** As the server's PROFILE_MODEL: never starting with "-" */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;
/** An agent's id: a key of `dragons:` */
export const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The "Other…" entry of a model dropdown */
export const OTHER_MODEL = "\u0000other";

const record = (value: unknown): Record<string, unknown> => (isPlainObject(value) ? value : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

// ============ ROLES ============

export interface RoleDef {
  /** As ROLE_PATHS on the server: "build", "review.amber", ... */
  path: string;
  /** Under ai.roles */
  segments: string[];
  label: string;
  help: string;
}

const ROLE_PATHS = ["build", "review.red", "review.amber", "review.green", "plan", "supervise"] as const;

/** The roles, named and explained by the registry's hints (the ai section's `roles.<path>`), else by their path. */
export function roleDefs(sections: readonly SettingsSection[]): RoleDef[] {
  const hints = sections.find((s) => s.key === "ai")?.hints ?? {};
  return ROLE_PATHS.map((path) => {
    const hint = Object.prototype.hasOwnProperty.call(hints, `roles.${path}`) ? hints[`roles.${path}`] : undefined;
    return { path, segments: path.split("."), label: hint?.label ?? path, help: hint?.help ?? "" };
  });
}

/** A role's profile ids, in order ([] when it is unset). */
export function roleList(draft: Draft, role: RoleDef): string[] {
  return strings(getIn(draft, ["ai", "roles", ...role.segments]));
}

/** The draft with the role set to `list` (removed when it is empty). */
export function setRole(draft: Draft, role: RoleDef, list: readonly string[]): Draft {
  return setIn(draft, ["ai", "roles", ...role.segments], list.length > 0 ? [...list] : undefined) as Draft;
}

/** `list` with the item at `from` moved to `to`. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return [...list];
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

// ============ PROFILES ============

export interface ProfileRow {
  id: string;
  tool: string;
  model: string;
  /** Roles and agents that name it */
  usedBy: string[];
}

export function profileIds(draft: Draft): string[] {
  return Object.keys(record(record(draft.ai).profiles));
}

export function profilesOf(draft: Draft, roles: readonly RoleDef[]): ProfileRow[] {
  const profiles = record(record(draft.ai).profiles);
  return Object.entries(profiles).map(([id, raw]) => {
    const p = record(raw);
    const usedBy = [
      ...roles.filter((r) => roleList(draft, r).includes(id)).map((r) => r.label),
      ...Object.entries(record(draft.dragons))
        .filter(([, d]) => text(record(d).profile) === id)
        .map(([agent]) => agent),
    ];
    return { id, tool: text(p.tool), model: text(p.model), usedBy };
  });
}

/** The draft with profile `id` on `tool` and `model` (a new one, or its tool and model changed: its options stay). */
export function setProfile(draft: Draft, id: string, tool: string, model: string): Draft {
  const at = ["ai", "profiles", id];
  if (!isPlainObject(getIn(draft, at))) return setIn(draft, at, { tool, model }) as Draft;
  return setIn(setIn(draft, [...at, "tool"], tool), [...at, "model"], model) as Draft;
}

export function removeProfile(draft: Draft, id: string): Draft {
  return setIn(draft, ["ai", "profiles", id], undefined) as Draft;
}

/** What is wrong with a new profile's id, or null. */
export function profileIdProblem(id: string, existing: readonly string[]): string | null {
  if (id === "") return "Give the profile a name";
  if (!PROFILE_ID.test(id)) return "A letter first, then letters, digits, '.', '_' or '-' (at most 64)";
  if (existing.includes(id)) return `There is a profile ${id} already`;
  return null;
}

// ============ TOOLS AND MODELS ============

export interface Choice {
  value: string;
  label: string;
}

/**
 * The tools a profile or an agent can run on: the presets, then the
 * project's own adapters (an adapter with a preset's id replaces it), named
 * as the tools view names them.
 */
export function toolChoices(draft: Draft, tools: AiToolsView | null, known: readonly string[]): { presets: Choice[]; custom: Choice[] } {
  const custom = new Set(Object.keys(record(draft.agent_adapters)));
  const names = new Map((tools?.tools ?? []).map((t) => [t.id, t.experimental ? `${t.name} (experimental)` : t.name]));
  const ids = [...new Set([...(tools?.tools ?? []).map((t) => t.id), ...known, ...custom])];
  const choice = (id: string): Choice => ({ value: id, label: names.has(id) && names.get(id) !== id ? `${names.get(id)} · ${id}` : id });
  return {
    presets: ids.filter((id) => !custom.has(id)).map(choice),
    custom: ids.filter((id) => custom.has(id)).map(choice),
  };
}

/** A model's line in the dropdown: its label or id, the tool's own notes, and "default" on the tool's default. */
export function modelLabel(model: AiModelsView["models"][number]): string {
  const name = model.label && model.label !== model.id ? `${model.id}: ${model.label}` : model.id;
  return [name, model.default ? "default" : "", model.notes].filter(Boolean).join(" · ");
}

export function modelChoices(view: AiModelsView | null): Choice[] {
  return (view?.models ?? []).map((m) => ({ value: m.id, label: modelLabel(m) }));
}

/** Whether the tool's list has the model (null while the list is not known). */
export function modelListed(view: AiModelsView | null, model: string): boolean | null {
  if (!view || view.models.length === 0) return null;
  return view.models.some((m) => m.id === model);
}

/** The warning for a typed model ("Other…"): it is saved, never refused, but the tool may not take it. */
export function modelWarning(tool: string, model: string, view: AiModelsView | null): string | null {
  if (model === "") return null;
  if (!MODEL_ID.test(model)) return "A model id: letters, digits, '.', '_', ':', '/', '@' or '-', not starting with '-'";
  const listed = modelListed(view, model);
  if (listed === false) return `${tool} doesn't list ${model}. It is saved as you typed it, but check the name: the tool may refuse it.`;
  if (listed === null) return `${tool} gave no list of models, so ${model} can't be checked here. It is saved as you typed it.`;
  return null;
}

// ============ AGENTS ============

export type RunsOn =
  | { kind: "profile"; profile: string }
  | { kind: "own"; tool: string; model: string }
  /** Nothing of its own: its role's first profile, else dragon_defaults */
  | { kind: "role" };

export interface AgentRow {
  id: string;
  name: string;
  /** The role it works in: plan for the planner agent, supervise for the supervisor's, else build */
  role: "build" | "plan" | "supervise";
  runsOn: RunsOn;
  /** What it runs on, in words */
  runs: string;
  machine: string;
}

function agentRole(draft: Draft, id: string): AgentRow["role"] {
  if (text(record(record(draft.planner).agent).id) === id) return "plan";
  return text(record(draft.supervisor).agent) === id ? "supervise" : "build";
}

export function runsOnOf(dragon: Record<string, unknown>): RunsOn {
  const profile = text(dragon.profile);
  if (profile) return { kind: "profile", profile };
  const tool = text(dragon.adapter);
  const model = text(dragon.model);
  if (tool || model) return { kind: "own", tool, model };
  return { kind: "role" };
}

export function agentsOf(draft: Draft): AgentRow[] {
  const defaults = record(draft.dragon_defaults);
  return Object.entries(record(draft.dragons)).map(([id, raw]) => {
    const d = record(raw);
    const role = agentRole(draft, id);
    const runsOn = runsOnOf(d);
    let runs: string;
    if (runsOn.kind === "profile") {
      const p = record(record(record(draft.ai).profiles)[runsOn.profile]);
      runs = `${runsOn.profile} (${text(p.tool) || "?"} + ${text(p.model) || "?"})`;
    } else if (runsOn.kind === "own") {
      runs = `${runsOn.tool || text(defaults.adapter) || "kiro"} + ${runsOn.model || text(defaults.model) || "the default model"}`;
    } else {
      const first = strings(getIn(draft, ["ai", "roles", role]))[0];
      runs = first ? `${first}, its role's first profile` : "the defaults (dragon_defaults)";
    }
    return { id, name: text(d.name) || id, role, runsOn, runs, machine: text(d.machine) || "local" };
  });
}

/** The draft with agent `id` running on `on`: a profile, or a tool and a model, or nothing of its own. */
export function setRunsOn(draft: Draft, id: string, on: RunsOn): Draft {
  const at = ["dragons", id];
  let next = draft;
  const put = (key: string, value: string | undefined) => {
    if (value === undefined && getIn(next, [...at, key]) === undefined) return;
    next = setIn(next, [...at, key], value) as Draft;
  };
  put("profile", on.kind === "profile" ? on.profile : undefined);
  put("adapter", on.kind === "own" && on.tool ? on.tool : undefined);
  put("model", on.kind === "own" && on.model ? on.model : undefined);
  return next;
}

/** The draft with agent `id` (new or not) named `name` on `machine` ("local" is left out when it was not set). */
export function setAgent(draft: Draft, id: string, name: string, machine: string): Draft {
  const at = ["dragons", id];
  let next = isPlainObject(getIn(draft, at)) ? draft : (setIn(draft, at, {}) as Draft);
  next = setIn(next, [...at, "name"], name.trim() === "" ? undefined : name.trim()) as Draft;
  const had = getIn(next, [...at, "machine"]) !== undefined;
  if (machine === "" || (machine === "local" && !had)) return setIn(next, [...at, "machine"], undefined) as Draft;
  return setIn(next, [...at, "machine"], machine) as Draft;
}

export function removeAgent(draft: Draft, id: string): Draft {
  return setIn(draft, ["dragons", id], undefined) as Draft;
}

/** Bulk change: these agents run on profile `profile` (their own tool and model, if any, are dropped). */
export function moveToProfile(draft: Draft, ids: readonly string[], profile: string): Draft {
  return ids.reduce((d, id) => setRunsOn(d, id, { kind: "profile", profile }), draft);
}

export function agentIdProblem(id: string, existing: readonly string[]): string | null {
  if (id === "") return "Give the agent an id";
  if (!AGENT_ID.test(id)) return "Letters, digits, '.', '_' or '-', not starting with '.', '_' or '-' (at most 64)";
  if (existing.includes(id)) return `There is an agent ${id} already`;
  return null;
}
