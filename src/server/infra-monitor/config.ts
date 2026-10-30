/**
 * Configuration parsing and validation for the infra monitor.
 */
import type { ProjectConfig } from "../../shared/types.js";
import type { InfraMonitorSettings } from "./types.js";

/** Default settings */
const DEFAULTS: InfraMonitorSettings = {
  enabled: false,
  mode: "observe",
  intervalSeconds: 60,
  downThresholdSeconds: 120,
  probeCmd: null,
  probeTimeoutSeconds: 10,
  requeueCmd: null,
  requeueTimeoutSeconds: 30,
};

/**
 * Validate a command template: an array of strings, each at most 4096 chars,
 * with no dangerous characters. Returns the error or null if valid.
 */
function validateCmd(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return `${name} must be an array`;
  if (value.length === 0) return `${name} must have at least one element`;
  if (value.length > 20) return `${name} has too many elements (max 20)`;
  for (let i = 0; i < value.length; i++) {
    const el = value[i];
    if (typeof el !== "string") return `${name}[${i}] must be a string`;
    if (el.length > 4096) return `${name}[${i}] is too long (max 4096)`;
    // Forbid shell metacharacters that could enable injection
    if (/[;&|`$(){}]/.test(el) && !el.startsWith("{") && !el.endsWith("}")) {
      return `${name}[${i}] contains forbidden shell metacharacters`;
    }
  }
  return null;
}

export interface ParseResult {
  ok: true;
  settings: InfraMonitorSettings;
}

export interface ParseError {
  ok: false;
  errors: string[];
}

/**
 * Parse and validate infra_monitor config. Returns errors if invalid.
 */
export function parseInfraMonitorConfig(raw: unknown): ParseResult | ParseError {
  const errors: string[] = [];

  if (raw === undefined || raw === null) {
    return { ok: true, settings: { ...DEFAULTS } };
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["infra_monitor must be an object"] };
  }

  const config = raw as Record<string, unknown>;
  const settings: InfraMonitorSettings = { ...DEFAULTS };

  // enabled
  if (config.enabled !== undefined) {
    if (typeof config.enabled !== "boolean") {
      errors.push("infra_monitor.enabled must be a boolean");
    } else {
      settings.enabled = config.enabled;
    }
  }

  // mode
  if (config.mode !== undefined) {
    if (config.mode !== "observe" && config.mode !== "act") {
      errors.push("infra_monitor.mode must be 'observe' or 'act'");
    } else {
      settings.mode = config.mode;
    }
  }

  // interval_seconds
  if (config.interval_seconds !== undefined) {
    if (typeof config.interval_seconds !== "number" || config.interval_seconds < 10 || config.interval_seconds > 3600) {
      errors.push("infra_monitor.interval_seconds must be a number between 10 and 3600");
    } else {
      settings.intervalSeconds = config.interval_seconds;
    }
  }

  // down_threshold_seconds
  if (config.down_threshold_seconds !== undefined) {
    if (typeof config.down_threshold_seconds !== "number" || config.down_threshold_seconds < 30 || config.down_threshold_seconds > 1800) {
      errors.push("infra_monitor.down_threshold_seconds must be a number between 30 and 1800");
    } else {
      settings.downThresholdSeconds = config.down_threshold_seconds;
    }
  }

  // probe_cmd
  const probeErr = validateCmd(config.probe_cmd, "infra_monitor.probe_cmd");
  if (probeErr) {
    errors.push(probeErr);
  } else if (config.probe_cmd !== undefined) {
    settings.probeCmd = config.probe_cmd as string[];
  }

  // probe_timeout_seconds
  if (config.probe_timeout_seconds !== undefined) {
    if (typeof config.probe_timeout_seconds !== "number" || config.probe_timeout_seconds < 1 || config.probe_timeout_seconds > 60) {
      errors.push("infra_monitor.probe_timeout_seconds must be a number between 1 and 60");
    } else {
      settings.probeTimeoutSeconds = config.probe_timeout_seconds;
    }
  }

  // requeue_cmd
  const requeueErr = validateCmd(config.requeue_cmd, "infra_monitor.requeue_cmd");
  if (requeueErr) {
    errors.push(requeueErr);
  } else if (config.requeue_cmd !== undefined) {
    settings.requeueCmd = config.requeue_cmd as string[];
  }

  // requeue_timeout_seconds
  if (config.requeue_timeout_seconds !== undefined) {
    if (typeof config.requeue_timeout_seconds !== "number" || config.requeue_timeout_seconds < 1 || config.requeue_timeout_seconds > 120) {
      errors.push("infra_monitor.requeue_timeout_seconds must be a number between 1 and 120");
    } else {
      settings.requeueTimeoutSeconds = config.requeue_timeout_seconds;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, settings };
}

/**
 * Why act mode is blocked, or null if it's allowed.
 */
export function actBlockedReason(config: ProjectConfig, settings: InfraMonitorSettings): string | null {
  if (config.read_only === true) return "the project is read_only";
  if (settings.mode !== "act") return "infra_monitor.mode is observe";
  if (!settings.requeueCmd) return "infra_monitor.requeue_cmd is not configured";
  return null;
}

/**
 * Build a command argv from a template, replacing placeholders.
 */
export function buildArgv(template: string[], vars: Record<string, string>): { argv: string[] } | { error: string } {
  const argv: string[] = [];
  for (const part of template) {
    let result = part;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replace(new RegExp(`\\{${key}\\}`, "g"), value);
    }
    // Check for unreplaced placeholders
    const unreplaced = result.match(/\{[a-z_]+\}/);
    if (unreplaced) {
      return { error: `unreplaced placeholder ${unreplaced[0]}` };
    }
    argv.push(result);
  }
  // Safety: first element must not start with -
  if (argv.length > 0 && argv[0].startsWith("-")) {
    return { error: "command must not start with an option" };
  }
  return { argv };
}
