/**
 * Failover: the profiles an agent can run with (its own adapter and model,
 * then agents.fallbacks.<id>, else its role's next ai.profiles), spotting a
 * provider error or rate limit in a run's output, and picking the next
 * profile whose provider is usable.
 */
import type { ProjectConfig } from "../../shared/types.js";
import type { AgentProfile } from "../../shared/agents-types.js";
import { aiProfiles, roleFallbacks, type AiProfile } from "../ai/profiles.js";
import { getDragonAdapter } from "../services/adapters.js";
import { loadKnownDragons } from "../services/dragon-registry.js";
import type { AgentsSettings } from "./config.js";
import type { FailoverInfo } from "./types.js";

/**
 * The agent's profiles in failover order: [its own, ...fallbacks]. Empty
 * when the agent is unknown or its adapter doesn't exist. `model` overrides
 * the first profile's model (a run request may set it). The fallbacks are
 * agents.fallbacks.<id> when it is set; else, for a dragon on an ai.profiles
 * profile, the profiles after it in its role (roleFallbacks).
 */
export function profilesFor(
  config: ProjectConfig,
  settings: AgentsSettings,
  agent: string,
  model?: string,
): AgentProfile[] {
  const dragon = loadKnownDragons(config).get(agent);
  if (!dragon) return [];
  const adapter = getDragonAdapter(dragon, config);
  if (!adapter) return [];
  // The key it was looked up by is its id: an agent_adapters entry may leave `id` out, or name another
  const adapterId = dragon.adapter || "kiro";
  const provider = (id: string, given?: string) => given ?? settings.providers[id] ?? id;
  const primaryModel = model ?? (dragon.model ? dragon.model : undefined);
  const own = dragon.profile ? aiProfiles(config).get(dragon.profile) : undefined;
  const explicit = settings.fallbacks[agent] ?? [];
  const fallbacks: AgentProfile[] =
    explicit.length > 0
      ? explicit.map((p) => ({ adapter: p.adapter, model: p.model, provider: provider(p.adapter, p.provider) }))
      : roleFallbacks(config, dragon).map((p) => fromProfile(p, provider(p.tool)));
  return [
    {
      adapter: adapterId,
      model: primaryModel,
      provider: provider(adapterId),
      ...(own ? { profile: own.id } : {}),
      ...(own && own.args.length > 0 ? { args: own.args } : {}),
    },
    ...fallbacks,
  ];
}

/** An ai.profiles entry as an agent profile. */
function fromProfile(profile: AiProfile, provider: string): AgentProfile {
  return {
    adapter: profile.tool,
    model: profile.model,
    provider,
    profile: profile.id,
    ...(profile.args.length > 0 ? { args: profile.args } : {}),
  };
}

export function profileLabel(profile: AgentProfile): string {
  return `${profile.adapter}${profile.model ? `/${profile.model}` : ""} (provider ${profile.provider})`;
}

/**
 * A rate limit or provider error among `lines` (newest first wins). Lines
 * are matched against agents.failover.*_patterns.
 */
export function matchFailover(lines: string[], settings: AgentsSettings): FailoverInfo | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim().slice(0, 500);
    if (settings.failover.rateLimit.some((pattern) => pattern.test(line))) return { kind: "rate_limit", line };
    if (settings.failover.providerError.some((pattern) => pattern.test(line))) {
      return { kind: "provider_error", line };
    }
  }
  return null;
}

/** How many of a dead run's last non-empty log lines are read for a transient error: the CLI's own last words */
export const TRANSIENT_TAIL_LINES = 3;
/** Each line is cut to this many characters before a pattern sees it */
export const TRANSIENT_LINE_CHARS = 500;

/**
 * A transient network or provider error among a dead run's last log lines
 * (newest first wins), by agents.transient_patterns: the line, or null.
 * Bounded: the caller passes at most TRANSIENT_TAIL_LINES lines, and each
 * is trimmed and cut to TRANSIENT_LINE_CHARS characters first.
 */
export function matchTransient(lines: string[], settings: AgentsSettings): string | null {
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - TRANSIENT_TAIL_LINES); i--) {
    const line = lines[i].trim().slice(0, TRANSIENT_LINE_CHARS);
    if (settings.transient.patterns.some((pattern) => pattern.test(line))) return line;
  }
  return null;
}

export interface ProfileChoice {
  /** The usable profile, or null when there is none */
  chosen: { index: number; profile: AgentProfile } | null;
  /** Profiles passed over, and why */
  skipped: string[];
}

/**
 * The first usable profile from `from` on (wrapping around once when `wrap`).
 * `unusable` says why a profile can't be used now, or null when it can.
 */
export function chooseProfile(
  profiles: AgentProfile[],
  from: number,
  wrap: boolean,
  unusable: (profile: AgentProfile) => string | null,
): ProfileChoice {
  const skipped: string[] = [];
  const order: number[] = [];
  for (let i = from; i < profiles.length; i++) order.push(i);
  if (wrap) for (let i = 0; i < Math.min(from, profiles.length); i++) order.push(i);
  for (const index of order) {
    const why = unusable(profiles[index]);
    if (why === null) return { chosen: { index, profile: profiles[index] }, skipped };
    skipped.push(`${profileLabel(profiles[index])}: ${why}`);
  }
  return { chosen: null, skipped };
}
