/**
 * Failover: the profiles an agent can run with (its own adapter and model,
 * then agents.fallbacks.<id>, else its role's next ai.profiles), spotting a
 * provider error or rate limit in a run's output, and picking the next
 * profile whose provider is usable. Also G1's quota lines and their reset times.
 */
import { createContext, Script } from "node:vm";
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
 * are matched against agents.failover.*_patterns. With failover.quota on
 * (G1), each line is checked against quota.patterns first: in act a match is
 * a `quota` failover; in observe the line keeps today's kind (rate_limit or
 * provider_error, or none) and is only marked `quota`.
 */
export function matchFailover(lines: string[], settings: AgentsSettings): FailoverInfo | null {
  const quota = settings.failover.quota;
  const cut = lines.map((line) => line.trim().slice(0, 500));
  // The newest quota line, once for all the lines (one bounded vm run)
  const hit = quota.mode === "off" ? null : matchQuota(cut, quota.patterns);
  for (let i = cut.length - 1; i >= 0; i--) {
    const line = cut[i];
    const marked = hit?.index === i ? { quota: { reset: hit.reset } } : {};
    if (hit?.index === i && quota.mode === "act") return { kind: "quota", line, quota: { reset: hit.reset } };
    if (settings.failover.rateLimit.some((pattern) => pattern.test(line))) return { kind: "rate_limit", line, ...marked };
    if (settings.failover.providerError.some((pattern) => pattern.test(line))) {
      return { kind: "provider_error", line, ...marked };
    }
  }
  return null;
}

/** How long the quota patterns may take on a run's last lines (each was checked on short lines when the config loaded) */
export const QUOTA_MATCH_TIMEOUT_MS = 50;
const quotaContext = createContext({ res: [] as RegExp[], lines: [] as string[], index: -1, reset: null as string | null });
const quotaScript = new Script(
  "index = -1; reset = null; outer: for (let i = lines.length - 1; i >= 0; i--) for (const re of res) { const m = re.exec(lines[i]); if (m) { index = i; reset = m.groups && typeof m.groups.reset === 'string' ? m.groups.reset : null; break outer; } }",
);

/**
 * The newest of `lines` (each at most 500 characters) a quota pattern matches, with the first matching pattern's
 * (?<reset>...) capture, or null. The patterns run in a vm that interrupts them after QUOTA_MATCH_TIMEOUT_MS for all
 * the lines together: a pattern that backtracks badly is no match (the lines take today's path), never a stalled tick.
 */
export function matchQuota(lines: string[], patterns: RegExp[]): { index: number; reset: string | null } | null {
  if (patterns.length === 0 || lines.length === 0) return null;
  quotaContext.res = patterns;
  quotaContext.lines = lines.map((line) => line.slice(0, 500));
  quotaContext.index = -1;
  quotaContext.reset = null;
  try {
    quotaScript.runInContext(quotaContext, { timeout: QUOTA_MATCH_TIMEOUT_MS });
  } catch {
    return null;
  } finally {
    quotaContext.res = [];
    quotaContext.lines = [];
  }
  const index = quotaContext.index;
  if (typeof index !== "number" || index < 0 || index >= lines.length) return null;
  const reset = typeof quotaContext.reset === "string" ? quotaContext.reset.trim().slice(0, 80) : "";
  return { index, reset: reset.length > 0 ? reset : null };
}

/** A quota cooldown never lasts longer than this from the line that set it, whatever reset time the line gave */
export const QUOTA_MAX_COOLDOWN_MS = 24 * 3_600_000;

const RESET_IN = /^in\s+(\d{1,4})\s*(minutes?|mins?|m|hours?|hrs?|h)$/i;
const RESET_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/;
const RESET_CLOCK = /^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?:\s*\(?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2}|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)\s*\)?)?$/i;

/**
 * When a quota's reset text says it resets (G1, a pattern's (?<reset>...) group), as epoch ms after `now`, capped at
 * QUOTA_MAX_COOLDOWN_MS; null when it isn't a time this reads (the cooldown then falls back to the backoff). Read:
 * an ISO time with a zone; "in <n> minutes|hours"; a clock time, HH:MM or H[:MM] am/pm, with an optional zone (Z,
 * UTC, GMT, an offset such as +05:00, or a zone name such as Area/City), the server's local zone when none is given,
 * at its next occurrence.
 */
export function quotaResetAt(text: string, now: number): number | null {
  const s = text.trim();
  const cap = (at: number) => (at > now ? Math.min(at, now + QUOTA_MAX_COOLDOWN_MS) : null);
  const inN = RESET_IN.exec(s);
  if (inN) return cap(now + Number(inN[1]) * (/^h/i.test(inN[2]) ? 3_600_000 : 60_000));
  if (RESET_ISO.test(s)) {
    const at = Date.parse(s);
    return Number.isFinite(at) ? cap(at) : null;
  }
  const clock = RESET_CLOCK.exec(s);
  if (!clock) return null;
  let hour = Number(clock[1]);
  const minute = clock[2] === undefined ? 0 : Number(clock[2]);
  const half = clock[3]?.toLowerCase().replace(/\./g, "");
  if (minute > 59) return null;
  if (half) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (half === "pm" ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  const offsetOf = zoneOffset(clock[4]);
  if (offsetOf === null) return null;
  // The wall clock in that zone now, then the next time it reads hour:minute
  const wall = new Date(now + offsetOf(now));
  for (let day = 0; day <= 2; day++) {
    const wanted = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + day, hour, minute);
    const at = wanted - offsetOf(wanted - offsetOf(now));
    if (at > now) return cap(at);
  }
  return null;
}

/** A zone's offset from UTC in ms at an instant: the server's local zone when none is named; null for an unknown zone. */
function zoneOffset(zone: string | undefined): ((at: number) => number) | null {
  if (zone === undefined) return (at) => -new Date(at).getTimezoneOffset() * 60_000;
  const upper = zone.toUpperCase();
  if (upper === "Z" || upper === "UTC" || upper === "GMT") return () => 0;
  const fixed = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
  if (fixed) {
    const hours = Number(fixed[2]);
    const minutes = Number(fixed[3]);
    if (hours > 14 || minutes > 59) return null;
    const ms = (hours * 60 + minutes) * 60_000 * (fixed[1] === "-" ? -1 : 1);
    return () => ms;
  }
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch {
    return null;
  }
  return (at) => {
    const parts = Object.fromEntries(format.formatToParts(new Date(at)).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    return asUtc - Math.floor(at / 1000) * 1000;
  };
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
