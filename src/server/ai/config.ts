/**
 * The `ai:` block of a project config (docs/configuration.md, "AI tools,
 * profiles and roles"), and the keys it adds elsewhere: a dragon's
 * `profile:`, and an adapter's models_cmd, models_parser, models,
 * auth_check_cmd, login_hint, version_cmd and experimental. Every key is
 * optional: a config without them loads and runs exactly as before.
 *
 * validateAiConfig runs when a project config is loaded (config.ts), so a
 * mistake here keeps the project from loading, with the key's path.
 */
import { z } from "zod";
import type { ProjectConfig } from "../../shared/types.js";
import { parseDragonRegistry } from "../parsers/dragon-config.js";
import { BUILTIN_ADAPTERS, getAdapter } from "../services/adapters.js";
import {
  MAX_PROFILE_ARGS,
  MAX_PROFILE_ARG_CHARS,
  PROFILE_ID,
  PROFILE_MODEL,
  ROLE_PATHS,
  TOOL_ID,
  isProfileArg,
  rawRole,
  roleAgents,
  roleProfiles,
  type RolePath,
} from "./profiles.js";

const PROFILE_ID_RULE = "profile ids: a letter, then letters, digits, '.', '_' or '-' (at most 64 characters)";
const ProfileId = z.string().regex(PROFILE_ID, PROFILE_ID_RULE);
/** A role: profile ids, the first used and the next ones its fallbacks */
const RoleList = z.array(ProfileId).min(1).max(20);

const ProfileSchema = z
  .object({
    /** A built-in adapter (kiro, claude-code, ...) or one of agent_adapters */
    tool: z.string().regex(TOOL_ID, "a tool id: a built-in adapter (kiro, claude-code, ...) or one of agent_adapters"),
    model: z
      .string()
      .regex(PROFILE_MODEL, "a model id: letters, digits, '.', '_', ':', '/', '@' or '-', not starting with '-'"),
    options: z
      .object({
        /** Literal arguments added to the tool's start command (no placeholders) */
        args: z.array(z.string().min(1).max(MAX_PROFILE_ARG_CHARS)).max(MAX_PROFILE_ARGS).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const AiSchema = z
  .object({
    /** Named tool + model (+ options) */
    profiles: z.record(ProfileId, ProfileSchema).default({}),
    /** Who does each job: an ordered list of profile ids per role */
    roles: z
      .object({
        build: RoleList.optional(),
        review: z
          .object({ red: RoleList.optional(), amber: RoleList.optional(), green: RoleList.optional() })
          .strict()
          .optional(),
        plan: RoleList.optional(),
        supervise: RoleList.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasOwn = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

/** "a.b[0].c": a zod issue's path, as the other parsers write it. */
function pathText(path: (string | number)[]): string {
  return path.map((part, i) => (typeof part === "number" ? `[${part}]` : i === 0 ? part : `.${part}`)).join("") || "(root)";
}

/** The most arguments a tool command may have, and the longest one */
export const MAX_COMMAND_ARGS = 20;
export const MAX_COMMAND_ARG_CHARS = 500;

/**
 * What is wrong with a tool command (models_cmd, auth_check_cmd,
 * version_cmd), or null: an argv of plain strings, the program first. It is
 * run as written, so it holds no placeholder, and the program is not an
 * option.
 */
export function commandArgvProblem(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return "an argv: a list of strings, the program first";
  if (value.length > MAX_COMMAND_ARGS) return `at most ${MAX_COMMAND_ARGS} arguments`;
  for (const [i, arg] of value.entries()) {
    if (typeof arg !== "string" || arg.length === 0 || arg.length > MAX_COMMAND_ARG_CHARS) {
      return `[${i}] must be a non-empty string of at most ${MAX_COMMAND_ARG_CHARS} characters`;
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(arg)) return `[${i}] has a control character`;
    if (/\{[a-z_]+\}/.test(arg)) return `[${i}] has a placeholder: the command is run as written, so none is allowed`;
  }
  if ((value[0] as string).startsWith("-")) return "the program (the first element) can't start with '-'";
  return null;
}

/** An argv commandArgvProblem accepts, else undefined. */
export function toolCommand(value: unknown): string[] | undefined {
  return commandArgvProblem(value) === null ? [...(value as string[])] : undefined;
}

/** What is wrong with the AI keys of an adapter (agent_adapters.<id>). */
function adapterErrors(id: string, raw: Record<string, unknown>): string[] {
  const where = `agent_adapters.${id}`;
  const errors: string[] = [];
  for (const key of ["models_cmd", "auth_check_cmd", "version_cmd"]) {
    if (raw[key] === undefined) continue;
    const problem = commandArgvProblem(raw[key]);
    if (problem) errors.push(`${where}.${key}: ${problem}`);
  }
  if (raw.models_parser !== undefined && raw.models_parser !== "kiro" && raw.models_parser !== "lines") {
    errors.push(`${where}.models_parser: kiro or lines`);
  }
  if (raw.models !== undefined) {
    if (!Array.isArray(raw.models) || raw.models.length > 300) {
      errors.push(`${where}.models: a list of at most 300 models ({id, label?, notes?, default?})`);
    } else {
      raw.models.forEach((model: unknown, i) => {
        if (!isObject(model) || typeof model.id !== "string" || !PROFILE_MODEL.test(model.id)) {
          errors.push(`${where}.models[${i}].id: a model id (letters, digits, '.', '_', ':', '/', '@' or '-', not starting with '-')`);
          return;
        }
        for (const key of Object.keys(model)) {
          if (!["id", "label", "notes", "default"].includes(key)) errors.push(`${where}.models[${i}].${key.slice(0, 40)}: unknown key`);
        }
        for (const key of ["label", "notes"]) {
          const value = model[key];
          if (value !== undefined && (typeof value !== "string" || value.length > 200)) {
            errors.push(`${where}.models[${i}].${key}: text of at most 200 characters`);
          }
        }
        if (model.default !== undefined && typeof model.default !== "boolean") {
          errors.push(`${where}.models[${i}].default: true or false`);
        }
      });
    }
  }
  if (raw.login_hint !== undefined) {
    // eslint-disable-next-line no-control-regex
    if (typeof raw.login_hint !== "string" || raw.login_hint.length > 200 || /[\x00-\x1f\x7f]/.test(raw.login_hint)) {
      errors.push(`${where}.login_hint: one line of at most 200 characters (the command the owner runs to sign in)`);
    }
  }
  if (raw.experimental !== undefined && typeof raw.experimental !== "boolean") {
    errors.push(`${where}.experimental: true or false`);
  }
  return errors;
}

/**
 * What is wrong with a project's AI settings ([] when nothing is): the `ai:`
 * block (unknown tools, roles naming unknown profiles), each dragon's
 * `profile:`, and the AI keys of its adapters.
 */
export function validateAiConfig(config: ProjectConfig): string[] {
  const errors: string[] = [];
  const raw: unknown = config.ai;
  const profileIds = isObject(raw) && isObject(raw.profiles) ? raw.profiles : {};

  if (raw !== undefined && raw !== null) {
    const parsed = AiSchema.safeParse(raw);
    if (!parsed.success) {
      errors.push(...parsed.error.issues.slice(0, 50).map((issue) => `ai.${pathText(issue.path)}: ${issue.message}`));
    } else {
      for (const [id, profile] of Object.entries(parsed.data.profiles)) {
        if (!getAdapter(profile.tool, config)) {
          errors.push(
            `ai.profiles.${id}.tool: unknown tool ${profile.tool} (built in: ${Object.keys(BUILTIN_ADAPTERS).join(", ")}; or define it in agent_adapters)`,
          );
        }
        profile.options?.args?.forEach((arg, i) => {
          if (!isProfileArg(arg)) {
            errors.push(`ai.profiles.${id}.options.args[${i}]: a literal argument, with no {placeholder} and no control characters`);
          }
        });
      }
      for (const role of ROLE_PATHS) {
        const list = rawRole(config, role);
        if (!Array.isArray(list)) continue;
        const seen = new Set<string>();
        list.forEach((id: unknown, i) => {
          if (typeof id !== "string") return;
          if (!hasOwn(parsed.data.profiles, id)) errors.push(`ai.roles.${role}[${i}]: unknown profile ${id} (not in ai.profiles)`);
          else if (seen.has(id)) errors.push(`ai.roles.${role}[${i}]: profile ${id} is listed twice`);
          seen.add(id);
        });
      }
    }
  }

  for (const [id, dragon] of Object.entries(config.dragons ?? {})) {
    if (!isObject(dragon) || dragon.profile === undefined) continue;
    const where = `dragons.${id.slice(0, 64)}`;
    if (typeof dragon.profile !== "string" || !PROFILE_ID.test(dragon.profile)) {
      errors.push(`${where}.profile: a profile id (one of ai.profiles)`);
    } else if (!hasOwn(profileIds, dragon.profile)) {
      errors.push(`${where}.profile: unknown profile ${dragon.profile} (not in ai.profiles)`);
    }
    if (dragon.adapter !== undefined || dragon.model !== undefined) {
      errors.push(`${where}.profile: name a profile, or an adapter and a model, not both`);
    }
  }

  const adapters: unknown = (config as ProjectConfig & { agent_adapters?: unknown }).agent_adapters;
  if (isObject(adapters)) {
    for (const [id, adapter] of Object.entries(adapters)) {
      if (isObject(adapter)) errors.push(...adapterErrors(id.slice(0, 64), adapter));
    }
  }
  if (errors.length === 0) errors.push(...unrunReviewRoles(config));
  return errors;
}

const REVIEW_ROLES: readonly { tier: string; role: RolePath }[] = [
  { tier: "red", role: "review.red" },
  { tier: "amber", role: "review.amber" },
  { tier: "green", role: "review.green" },
];

/**
 * With reviews by agents on (review.enabled and review.prompt_file), a
 * review role is the dragons that run its profiles: one that no dragon
 * runs would leave its tier's reviews to nobody. A dragons.txt dragon runs
 * the build role's first profile, so a review role with that profile counts
 * as run.
 */
function unrunReviewRoles(config: ProjectConfig): string[] {
  const review: unknown = config.review;
  if (!isObject(review) || review.enabled !== true || typeof review.prompt_file !== "string") return [];
  const dragons = [...parseDragonRegistry(config).values()];
  const buildFirst = roleProfiles(config, "build")[0];
  const errors: string[] = [];
  for (const { tier, role } of REVIEW_ROLES) {
    const profiles = roleProfiles(config, role);
    if (profiles.length === 0 || roleAgents(config, role, dragons).length > 0) continue;
    if (buildFirst && profiles.some((p) => p.id === buildFirst.id)) continue;
    const ids = profiles.map((p) => p.id).join(", ");
    errors.push(
      `ai.roles.review.${tier}: no dragon runs ${profiles.length === 1 ? "this profile" : "these profiles"} (${ids}), and reviews by agents are on (review.prompt_file): give a reviewer dragon profile: ${profiles[0].id}`,
    );
  }
  return errors;
}
