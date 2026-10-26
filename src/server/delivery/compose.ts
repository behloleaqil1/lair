/**
 * docker compose: argv builders and output parsers. Everything Lair runs is
 * an argv array (no shell), built from validated config values and from ids
 * Docker printed, which are checked again before they go into an argv.
 *
 * Output formats (Docker Compose v2):
 * - `docker compose ps --all --format json`: one JSON object per line
 *   (Compose 2.21 and later) or one JSON array (earlier 2.x). Fields used:
 *   Service, Name, ID (12 hex), State (created, running, restarting, exited,
 *   paused, dead, removing), Health ("" without a HEALTHCHECK, else starting,
 *   healthy or unhealthy), ExitCode (a number), Status, Image. There is no
 *   restart count in it.
 * - `docker inspect <id>...`: a JSON array. Fields used: Id, Name ("/name"),
 *   RestartCount (top level, restarts by the restart policy), State.Status,
 *   State.Restarting, State.ExitCode, State.Error, State.Health (absent
 *   without a HEALTHCHECK: Status, FailingStreak, Log[].ExitCode/Output),
 *   Image (the sha256 id), Config.Image (the reference it was created from).
 */
import type { EnvironmentSettings } from "./config.js";

/** `[...docker_cmd, "compose", "-p", <name>, "-f", <file>..., "--project-directory", <dir>]` */
export function composeBase(dockerCmd: string[], env: EnvironmentSettings): string[] {
  const argv = [...dockerCmd, "compose", "-p", env.projectName];
  for (const file of env.composeFiles) argv.push("-f", file);
  if (env.projectDirectory) argv.push("--project-directory", env.projectDirectory);
  return argv;
}

/** A container id as Docker prints it: 12 to 64 lowercase hex characters */
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
/** A container name: what `docker update`, `docker logs`, ... accept */
export const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** An image id (sha256:...) */
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
/** An image reference: registry/repo:tag, never a leading '-' */
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;

export function isContainerId(id: string): boolean {
  return CONTAINER_ID.test(id);
}

export function isImageId(id: string): boolean {
  return IMAGE_ID.test(id);
}

export function isImageRef(ref: string): boolean {
  return IMAGE_REF.test(ref);
}

/** One line of `docker compose ps --format json`. */
export interface PsEntry {
  service: string;
  name: string;
  id: string;
  state: string;
  health: string;
  exitCode: number;
  status: string;
  image: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse `docker compose ps --all --format json` (one object per line, or one
 * array). Throws when the output isn't JSON: an unreadable answer must not
 * read as "no containers". Entries without a Service or a valid ID are
 * skipped.
 */
export function parseComposePs(stdout: string): PsEntry[] {
  const text = stdout.trim();
  if (text === "") return [];
  const items: unknown[] = [];
  if (text.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("docker compose ps printed something that is not JSON");
    }
    if (!Array.isArray(parsed)) throw new Error("docker compose ps printed something that is not a list");
    items.push(...parsed);
  } else {
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line.startsWith("{")) continue;
      try {
        items.push(JSON.parse(line));
      } catch {
        throw new Error("docker compose ps printed a line that is not JSON");
      }
    }
    // A table (a Compose that ignored --format json) is not "no containers"
    if (items.length === 0) throw new Error("docker compose ps printed something that is not JSON");
  }
  const entries: PsEntry[] = [];
  for (const item of items) {
    const r = record(item);
    if (!r) continue;
    const id = str(r.ID);
    const service = str(r.Service);
    if (!service || !isContainerId(id)) continue;
    entries.push({
      service,
      name: str(r.Name) || str(r.Names),
      id,
      state: str(r.State).toLowerCase(),
      health: str(r.Health).toLowerCase(),
      exitCode: num(r.ExitCode),
      status: str(r.Status),
      image: str(r.Image),
    });
  }
  return entries;
}

/** One container of `docker inspect`. */
export interface InspectEntry {
  id: string;
  name: string;
  restartCount: number;
  status: string;
  restarting: boolean;
  exitCode: number;
  error: string;
  /** Absent when the image has no HEALTHCHECK */
  health?: { status: string; failingStreak: number; lastFailure?: string };
  imageId: string;
  imageRef: string;
}

/**
 * Parse `docker inspect` output (a JSON array). `docker inspect a b` prints
 * the containers it found even when it exits 1 for one that is gone, so the
 * caller parses stdout whatever the exit code.
 */
export function parseInspect(stdout: string): InspectEntry[] {
  const text = stdout.trim();
  if (!text.startsWith("[")) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("docker inspect printed something that is not JSON");
  }
  if (!Array.isArray(parsed)) return [];
  const entries: InspectEntry[] = [];
  for (const item of parsed) {
    const r = record(item);
    if (!r) continue;
    const id = str(r.Id);
    if (!isContainerId(id)) continue;
    const state = record(r.State) ?? {};
    const config = record(r.Config) ?? {};
    const health = record(state.Health);
    let lastFailure: string | undefined;
    if (health && Array.isArray(health.Log)) {
      for (const entry of health.Log) {
        const log = record(entry);
        if (log && num(log.ExitCode) !== 0) lastFailure = str(log.Output).trim() || undefined;
      }
    }
    entries.push({
      id,
      name: str(r.Name).replace(/^\//, ""),
      restartCount: num(r.RestartCount),
      status: str(state.Status).toLowerCase(),
      restarting: state.Restarting === true,
      exitCode: num(state.ExitCode),
      error: str(state.Error),
      health: health
        ? { status: str(health.Status).toLowerCase(), failingStreak: num(health.FailingStreak), lastFailure }
        : undefined,
      imageId: str(r.Image),
      imageRef: str(config.Image),
    });
  }
  return entries;
}

/**
 * The repository part of an image reference, for tagging the previous image:
 * "example/api:dev" -> "example/api", "localhost:5000/api" stays as it is.
 * Null for a reference pinned by digest (it can't be rebuilt under that name).
 */
export function imageRepository(ref: string): string | null {
  if (!isImageRef(ref) || ref.includes("@")) return null;
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  return colon > slash ? ref.slice(0, colon) : ref;
}

/** The tag the image a service ran before a deploy gets (`<repository>:lair-previous`) */
export const PREVIOUS_TAG = "lair-previous";

const ERROR_LINE =
  /\b(error|err|fatal|panic|exception|traceback|failed|failure|refused|denied|cannot|unable|killed|oom|segmentation fault|exited with)\b/i;
const MAX_LINE = 300;

/**
 * The last error lines of a log: the last `max` lines that read like an
 * error, or the last `max` lines when none does.
 */
export function errorLines(log: string, max = 10): string[] {
  const lines = log
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  const errors = lines.filter((line) => ERROR_LINE.test(line));
  const picked = (errors.length > 0 ? errors : lines).slice(-max);
  return picked.map((line) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}...` : line));
}
