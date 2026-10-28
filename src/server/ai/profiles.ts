/**
 * AI profiles and roles, as the other modules read them (the `ai:` block of
 * a project config; docs/design/ai-roles.md):
 *
 * - a profile is a tool (an adapter id), a model and its options;
 * - a role is an ordered list of profile ids: the first is used, the next
 *   ones are its fallbacks (the agents module's failover);
 * - a dragon names a profile, or an adapter and a model as before, or
 *   neither: then the first profile of its role, when that role is set
 *   (ai.roles.plan for the planner agent, ai.roles.build for the others),
 *   else dragon_defaults as before.
 *
 * Only well-formed entries are returned. config.ts reports the others, and a
 * project whose `ai:` block is invalid doesn't load, so a config that was
 * never validated can't pass a bad one on. This file imports no other module
 * of Lair's, so the dragon registry can use it.
 */
import type { DragonConfig, ProjectConfig } from "../../shared/types.js";

/** The roles, as paths: what a review pool's `role:<path>` names */
export const ROLE_PATHS = ["build", "review.red", "review.amber", "review.green", "plan", "supervise"] as const;
export type RolePath = (typeof ROLE_PATHS)[number];

/** Profile ids: a letter first, then letters, digits, '.', '_' or '-', at most 64 characters */
export const PROFILE_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
/** Tool ids are adapter ids */
export const TOOL_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** As the agents module's MODEL_ID: never starting with "-" */
export const PROFILE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;
/** A pool entry that names a role's agents: `role:review.amber` */
export const ROLE_REF = /^role:(build|review\.(?:red|amber|green)|plan|supervise)$/;
/** At most this many options.args per profile, each at most this long */
export const MAX_PROFILE_ARGS = 20;
export const MAX_PROFILE_ARG_CHARS = 200;

export interface AiProfile {
  id: string;
  tool: string;
  model: string;
  /** options.args: literal arguments added to the tool's start command */
  args: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A literal start argument: no placeholder (a value can't be put in it), no
 * control characters, bounded. It may be an option: the owner wrote it.
 */
export function isProfileArg(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PROFILE_ARG_CHARS &&
    !/\{[a-z_]+\}/.test(value) &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

/** What the readers below need of a project config: its `ai:` block */
export type WithAi = Partial<Pick<ProjectConfig, "ai">>;

/** The project's well-formed profiles, by id. */
export function aiProfiles(config: WithAi): Map<string, AiProfile> {
  const profiles = new Map<string, AiProfile>();
  const ai: unknown = config.ai;
  if (!isObject(ai) || !isObject(ai.profiles)) return profiles;
  for (const [id, raw] of Object.entries(ai.profiles)) {
    if (!PROFILE_ID.test(id) || !isObject(raw)) continue;
    const { tool, model, options } = raw;
    if (typeof tool !== "string" || !TOOL_ID.test(tool)) continue;
    if (typeof model !== "string" || !PROFILE_MODEL.test(model)) continue;
    let args: string[] = [];
    if (options !== undefined) {
      if (!isObject(options)) continue;
      if (options.args !== undefined) {
        const list: unknown = options.args;
        if (!Array.isArray(list) || list.length > MAX_PROFILE_ARGS || !list.every(isProfileArg)) continue;
        args = [...list];
      }
    }
    profiles.set(id, { id, tool, model, args });
  }
  return profiles;
}

/** The raw list of a role (unchecked), or undefined when it is unset. */
export function rawRole(config: WithAi, role: RolePath): unknown {
  const ai: unknown = config.ai;
  if (!isObject(ai) || !isObject(ai.roles)) return undefined;
  const roles = ai.roles;
  if (role.startsWith("review.")) {
    const review = roles.review;
    return isObject(review) ? review[role.slice("review.".length)] : undefined;
  }
  return roles[role];
}

/** A role's profiles, in order, without repeats: [] when the role is unset. */
export function roleProfiles(config: WithAi, role: RolePath): AiProfile[] {
  const list = rawRole(config, role);
  if (!Array.isArray(list)) return [];
  const profiles = aiProfiles(config);
  const out: AiProfile[] = [];
  for (const id of list) {
    const profile = typeof id === "string" ? profiles.get(id) : undefined;
    if (profile && !out.includes(profile)) out.push(profile);
  }
  return out;
}

/** True when the role lists at least one profile. */
export function roleIsSet(config: WithAi, role: RolePath): boolean {
  return roleProfiles(config, role).length > 0;
}

/** The planner agent's id (planner.agent.id), when the project names one. */
function plannerAgent(config: ProjectConfig): string | null {
  const planner: unknown = config.planner;
  if (!isObject(planner) || !isObject(planner.agent)) return null;
  return typeof planner.agent.id === "string" ? planner.agent.id : null;
}

/** The supervisor agent's id (supervisor.agent), when the project names one. */
function supervisorAgent(config: ProjectConfig): string | null {
  const supervisor: unknown = config.supervisor;
  if (!isObject(supervisor)) return null;
  return typeof supervisor.agent === "string" ? supervisor.agent : null;
}

/**
 * The role a dragon works in: "plan" for the planner agent, "supervise" for
 * the supervisor agent (supervisor.agent), "build" for every other. A dragon
 * that names no profile, adapter or model runs on its role's first profile,
 * and a dragon whose profile is in its role falls back to the profiles after
 * it there.
 */
export function agentRole(config: ProjectConfig, agent: string): "plan" | "supervise" | "build" {
  if (plannerAgent(config) === agent) return "plan";
  return supervisorAgent(config) === agent ? "supervise" : "build";
}

/** What a dragon names itself in YAML: a profile, or an adapter and a model. */
export interface OwnChoice {
  profile?: unknown;
  adapter?: unknown;
  model?: unknown;
}

/** A dragon's tool and model before the built-in defaults, and the profile they came from. */
export interface DragonAi {
  adapter?: string;
  model?: string;
  profile?: string;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/**
 * What the dragon `id` runs on: its own profile; else its own adapter and
 * model, each falling back to dragon_defaults (as before profiles); else
 * the first profile of its role, when that role is set; else
 * dragon_defaults. A config without `ai:` resolves exactly as before.
 */
export function dragonAi(
  config: ProjectConfig,
  id: string,
  own: OwnChoice | undefined,
  defaults: { model?: string; adapter?: string },
): DragonAi {
  const named = text(own?.profile);
  if (named) {
    const profile = aiProfiles(config).get(named);
    if (profile) return { adapter: profile.tool, model: profile.model, profile: profile.id };
  }
  const adapter = text(own?.adapter);
  const model = text(own?.model);
  if (adapter || model) return { adapter: adapter ?? defaults.adapter, model: model ?? defaults.model };
  const first = roleProfiles(config, agentRole(config, id))[0];
  if (first) return { adapter: first.tool, model: first.model, profile: first.id };
  return { adapter: defaults.adapter, model: defaults.model };
}

/** True when the dragon's YAML entry names a profile of the project's own. */
export function namesOwnProfile(config: ProjectConfig, own: OwnChoice | undefined): boolean {
  const named = text(own?.profile);
  return named !== undefined && aiProfiles(config).has(named);
}

/**
 * The profiles a dragon falls back to, in order: those after its profile in
 * its role (agentRole), when its profile is in that role; [] otherwise.
 */
export function roleFallbacks(config: ProjectConfig, dragon: Pick<DragonConfig, "id" | "profile">): AiProfile[] {
  if (!dragon.profile) return [];
  const chain = roleProfiles(config, agentRole(config, dragon.id));
  const at = chain.findIndex((p) => p.id === dragon.profile);
  return at < 0 ? [] : chain.slice(at + 1);
}

/**
 * The agents whose profile is in `role`, in the role's order (the agents on
 * its first profile first), then in the dragons' order.
 */
export function roleAgents(config: ProjectConfig, role: RolePath, dragons: Iterable<DragonConfig>): string[] {
  const list = [...dragons];
  const out: string[] = [];
  for (const profile of roleProfiles(config, role)) {
    for (const dragon of list) {
      if (dragon.profile === profile.id && !out.includes(dragon.id)) out.push(dragon.id);
    }
  }
  return out;
}

/** A reviewer pool with each `role:<path>` entry replaced by that role's agents, in order, without repeats. */
export function resolvePool(entries: readonly string[], config: ProjectConfig, dragons: Iterable<DragonConfig>): string[] {
  const list = [...dragons];
  const out: string[] = [];
  for (const entry of entries) {
    const role = ROLE_REF.exec(entry)?.[1] as RolePath | undefined;
    for (const id of role ? roleAgents(config, role, list) : [entry]) {
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}
