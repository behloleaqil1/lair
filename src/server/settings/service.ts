/**
 * Settings: project files read, checked and written for the dashboard
 * (docs/design/settings-ui.md). Every write goes through save(): the file's
 * hash at load (409 when it changed), the candidate checked by the same
 * parsers as startup and live reload (422), command changes confirmed (428),
 * no secrets, an atomic write, a history entry, then the live reload.
 *
 * Saves are synchronous from reading the file to renaming the new one, so two
 * requests of this server can't interleave; the hash is checked once more
 * right before the rename for writers outside it.
 */
import { execFile } from "child_process";
import { existsSync, statSync } from "fs";
import { isAbsolute, join, relative, sep } from "path";
import { parse as parseYaml } from "yaml";
import type {
  CommandChange,
  CreateProjectRequest,
  FieldError,
  HistoryAction,
  HistoryDetail,
  HistoryVersion,
  KnownValues,
  ProjectFileInfo,
  ProjectSettingsView,
  RepoCheck,
  SaveRequest,
  SaveResult,
  SecretStatus,
  SettingsChange,
  SettingsCheck,
  SettingsSection,
} from "../../shared/settings-types.js";
import { isPlainObject, redactSecrets } from "../../shared/settings-rules.js";
import { lineDiff } from "../../shared/line-diff.js";
import type { ProjectConfig } from "../../shared/types.js";
import {
  MAX_CONFIG_BYTES,
  PROJECTS_DIR,
  getConfigPath,
  isSafeProjectName,
  listProjects,
  parseProjectConfig,
} from "../config.js";
import { parseDragonRegistry, parseAvailableModels } from "../parsers/dragon-config.js";
import { BUILTIN_ADAPTERS } from "../services/adapters.js";
import { configuredTokenEnvs } from "../restart/secrets.js";
import {
  commandChanges,
  commandsDigest,
  fieldErrors,
  holdsSecrets,
  redactErrors,
  requiredErrors,
  secretErrors,
} from "./checks.js";
import { UnsafeFileError, checkDirectory, fileProblem, readProjectFile, sha256, writeFileAtomic } from "./files.js";
import { ConfigHistory, VERSION_PATTERN } from "./history.js";
import { ownedKeys, settingsSections } from "./registry.js";
import { applyChanges, checkChanges, newConfigText, parseConfigDocument } from "./yaml-doc.js";

/** A refusal, with its HTTP status, a stable code and the details the UI shows. */
export class SettingsError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "SettingsError";
  }
}

export interface GitResult {
  code: number;
  stdout: string;
}

export interface SettingsServiceOptions {
  /** projects/ (default: the one in Lair's working directory) */
  projectsDir?: string;
  /** data/: the history goes to data/config-history, data/owner.token is a known secret */
  dataDir: string;
  /** Paths are shown relative to this (default: the working directory) */
  cwd?: string;
  /** The modules' own parsers, as live reload runs them (ConfigReloader.validate) */
  validate: (config: ProjectConfig) => string[];
  /** Apply a written file now (ConfigReloader.apply) */
  reload?: (project: string) => void;
  /** Live reload's problem with a project, after reload() */
  reloadProblem?: (project: string) => string | null;
  sections?: SettingsSection[];
  env?: NodeJS.ProcessEnv;
  clock?: { now(): number };
  /** Versions kept per project (default 50) */
  keepVersions?: number;
}

interface Target {
  id: string;
  path: string;
  shown: string;
  local: boolean;
}

interface Candidate {
  text: string;
  values: Record<string, unknown> | null;
  errors: FieldError[];
  commands: CommandChange[];
  digest: string;
}

const GIT_TIMEOUT_MS = 5000;
const GITHUB_REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_NAME = 200;
const MAX_PATH = 4096;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function parseValues(text: string): Record<string, unknown> | null {
  try {
    const value = parseYaml(text) as unknown;
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** owner/name of a GitHub remote URL (https, ssh or scp form), or null. */
export function githubOf(url: string): string | null {
  const match =
    /^(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
  return match && GITHUB_REPO.test(match[1]) ? match[1] : null;
}

/** A remote URL without its credentials, so a token in it is never shown. */
function redactUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/\s]+@/i, "$1***@");
}

function unsafeText(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x1f\x7f]/.test(value);
}

export class SettingsService {
  readonly projectsDir: string;
  private readonly cwd: string;
  private readonly sections: SettingsSection[];
  private readonly owned: Set<string>;
  private readonly env: NodeJS.ProcessEnv;
  readonly history: ConfigHistory;

  constructor(private readonly options: SettingsServiceOptions) {
    this.projectsDir = options.projectsDir ?? PROJECTS_DIR;
    this.cwd = options.cwd ?? process.cwd();
    this.sections = options.sections ?? settingsSections();
    this.owned = ownedKeys(this.sections);
    this.env = options.env ?? process.env;
    this.history = new ConfigHistory({
      dir: join(options.dataDir, "config-history"),
      shown: this.display(join(options.dataDir, "config-history")),
      keep: options.keepVersions,
      maxBytes: MAX_CONFIG_BYTES,
      clock: options.clock,
    });
  }

  modules(): SettingsSection[] {
    return this.sections;
  }

  private display(path: string): string {
    const rel = relative(this.cwd, path);
    return rel && !rel.startsWith("..") ? rel.split(sep).join("/") : path;
  }

  // ============ FILES ============

  private target(id: unknown): Target {
    if (typeof id !== "string" || !isSafeProjectName(id)) {
      throw new SettingsError(400, "Invalid project name", "invalid_project");
    }
    if (!listProjects(this.projectsDir).includes(id)) {
      throw new SettingsError(404, `Unknown project: ${id}`, "unknown_project");
    }
    const path = getConfigPath(id, this.projectsDir);
    const local = path.startsWith(join(this.projectsDir, "local") + sep);
    return { id, path, shown: this.display(path), local };
  }

  private checkDirs(local: boolean, create = false): void {
    checkDirectory(this.projectsDir, this.display(this.projectsDir));
    if (local) checkDirectory(join(this.projectsDir, "local"), this.display(join(this.projectsDir, "local")), create);
  }

  /** The file's text; refused when it is a symlink or not a regular file. */
  private readTarget(target: Target): string {
    this.checkDirs(target.local);
    const text = readProjectFile(target.path, target.shown, MAX_CONFIG_BYTES);
    if (text === null) throw new SettingsError(404, `${target.shown} does not exist`, "unknown_project");
    return text;
  }

  listProjects(): ProjectFileInfo[] {
    return listProjects(this.projectsDir).map((id) => {
      const target = this.target(id);
      let problem: string | null = null;
      try {
        this.checkDirs(target.local);
        problem = fileProblem(target.path, target.shown);
      } catch (e) {
        problem = message(e);
      }
      return { id, file: target.shown, local: target.local, writable: problem === null, ...(problem ? { problem } : {}) };
    });
  }

  // ============ CHECKS ============

  /** Everything that keeps `text` from being saved as project `id` ([] when nothing does). */
  validateText(id: string, text: string, shown: string): { values: Record<string, unknown> | null; errors: FieldError[] } {
    const { errors: yamlErrors } = parseConfigDocument(text);
    if (yamlErrors.length > 0) {
      // Only a YAML error's first line (where it is): the lines it quotes after it could hold a secret
      const errors = yamlErrors
        .slice(0, 20)
        .map((m) => ({ path: "", message: redactSecrets(`YAML: ${m.split("\n")[0]}`) }));
      return { values: null, errors: [...errors, ...secretErrors({}, text)] };
    }
    const values = parseValues(text);
    if (!values) return { values: null, errors: [{ path: "", message: "the file's top level must be a mapping (key: value)" }] };

    const errors: FieldError[] = [...secretErrors(values, text), ...requiredErrors(values)];
    let config: ProjectConfig | null = null;
    try {
      config = parseProjectConfig(text, id, shown);
    } catch (e) {
      const problem = message(e);
      const prefix = `Invalid project config ${id}: `;
      if (problem.startsWith(prefix)) errors.push(...fieldErrors([problem.slice(prefix.length)]));
      // The required fields are already one error each
      else if (!problem.includes("missing required fields")) errors.push(...fieldErrors([problem]));
    }
    if (config) errors.push(...fieldErrors(this.options.validate(config)));
    // A parser may quote the value it refused (an enum's "received '...'"): never a secret
    return { values, errors: redactErrors(errors, values) };
  }

  private candidate(id: string, shown: string, before: Record<string, unknown> | null, text: string): Candidate {
    if (Buffer.byteLength(text, "utf-8") > MAX_CONFIG_BYTES) {
      throw new SettingsError(413, `The file would be larger than ${MAX_CONFIG_BYTES / 1024} KiB`, "too_large");
    }
    const { values, errors } = this.validateText(id, text, shown);
    const commands = values ? commandChanges(before ?? {}, values, this.sections) : [];
    return { text, values, errors, commands, digest: commandsDigest(commands) };
  }

  private report(current: string | null, candidate: Candidate, conflict: boolean): SettingsCheck {
    return {
      ok: candidate.errors.length === 0 && !conflict,
      errors: candidate.errors,
      diff: lineDiff(current ?? "", candidate.text),
      yaml: candidate.text,
      commands: candidate.commands,
      commandsDigest: candidate.digest,
      conflict,
      currentHash: current === null ? null : sha256(current),
    };
  }

  /** The candidate of a save request: the text sent, or the changes applied to `current`. */
  private textOf(request: Partial<SaveRequest>, current: string): string {
    const hasYaml = request.yaml !== undefined;
    const hasChanges = request.changes !== undefined;
    if (hasYaml === hasChanges) throw new SettingsError(400, "Send either yaml or changes", "bad_request");
    if (hasYaml) {
      if (typeof request.yaml !== "string") throw new SettingsError(400, "yaml must be a string", "bad_request");
      return request.yaml;
    }
    const changes: SettingsChange[] = checkChanges(request.changes);
    return applyChanges(current, changes);
  }

  // ============ READ ============

  view(id: string): ProjectSettingsView {
    const target = this.target(id);
    const problem = (() => {
      try {
        this.checkDirs(target.local);
        return fileProblem(target.path, target.shown);
      } catch (e) {
        return message(e);
      }
    })();
    if (problem) throw new UnsafeFileError(problem);
    const yaml = this.readTarget(target);
    const { values, errors } = this.validateText(id, yaml, target.shown);
    return {
      id,
      file: target.shown,
      local: target.local,
      writable: true,
      hash: sha256(yaml),
      yaml,
      values,
      errors,
      unknownKeys: values ? Object.keys(values).filter((k) => !this.owned.has(k)) : [],
      known: this.known(values ?? {}),
      secrets: this.secrets(values ?? {}),
    };
  }

  private known(values: Record<string, unknown>): KnownValues {
    const set = (items: Iterable<string>) => [...new Set(items)].filter((v) => v.length > 0).sort();
    const config = values as unknown as ProjectConfig;
    let agents: string[] = [];
    let models: string[] = [];
    try {
      const dragons = parseDragonRegistry(config);
      agents = [...dragons.keys()];
      models = [...parseAvailableModels(config).map((m) => m.id), ...[...dragons.values()].map((d) => d.model)];
    } catch {
      // A broken dragons: block lists nothing
    }
    const adapters = Object.keys({
      ...BUILTIN_ADAPTERS,
      ...(isPlainObject(values.agent_adapters) ? values.agent_adapters : {}),
    });
    const machines = isPlainObject(values.machines) ? values.machines : {};
    const lanes: string[] = [];
    for (const machine of Object.values(machines)) if (isPlainObject(machine)) lanes.push(...strings(machine.runners));
    if (isPlainObject(values.pipelines)) {
      for (const pipeline of Object.values(values.pipelines)) {
        if (!isPlainObject(pipeline)) continue;
        if (isPlainObject(pipeline.lanes)) lanes.push(...Object.keys(pipeline.lanes));
        for (const step of Array.isArray(pipeline.steps) ? pipeline.steps : []) {
          if (isPlainObject(step) && typeof step.lane === "string") lanes.push(step.lane);
        }
      }
    }
    return {
      agents: set(agents),
      adapters: set(adapters),
      models: set(models),
      lanes: set(lanes),
      machines: set(["local", ...Object.keys(machines)]),
    };
  }

  /** The secrets Lair knows for this config: set or not, never their values. */
  private secrets(values: Record<string, unknown>): SecretStatus[] {
    const ownerToken = join(this.options.dataDir, "owner.token");
    const out: SecretStatus[] = [
      {
        label: "Owner token",
        where: this.display(ownerToken),
        set: existsSync(ownerToken) && statSync(ownerToken).size > 0,
      },
    ];
    const envs = new Map<string, string>();
    const walk = (node: unknown, path: string[], depth: number) => {
      if (depth > 16 || !isPlainObject(node)) return;
      for (const [key, value] of Object.entries(node)) {
        const here = [...path, key];
        if (/(^|_)(token|secret|password|key)_env$/i.test(key) && typeof value === "string" && ENV_NAME.test(value)) {
          envs.set(value, here.join("."));
        } else {
          walk(value, here, depth + 1);
        }
      }
    };
    walk(values, [], 0);
    // The defaults a configured block uses when it names no variable
    const review = values.review;
    if (isPlainObject(review) && review.token_env === undefined) envs.set("GITHUB_TOKEN", "review.token_env (default)");
    const github = isPlainObject(values.executors) && isPlainObject(values.executors.github) ? values.executors.github : null;
    if (values.pipelines !== undefined && github?.token_env === undefined) {
      envs.set("LAIR_GITHUB_TOKEN", "executors.github.token_env (default)");
    }
    // The names the restart keeps from the update command, the agents' provider keys among them
    try {
      for (const name of configuredTokenEnvs([values as unknown as ProjectConfig])) {
        if (!envs.has(name)) envs.set(name, "agents.env_passthrough");
      }
    } catch {
      // A block that doesn't parse names nothing
    }
    for (const [name, label] of envs) {
      out.push({ label, where: `env ${name}`, set: (this.env[name] ?? "").length > 0 });
    }
    out.push({ label: "lair-node token", where: "env LAIR_NODE_TOKEN", set: (this.env.LAIR_NODE_TOKEN ?? "").length > 0 });
    return out;
  }

  // ============ SAVE ============

  /** A save's checks without writing anything. */
  dryRun(id: string, request: Partial<SaveRequest>): SettingsCheck {
    const target = this.target(id);
    const current = this.readTarget(target);
    const candidate = this.candidate(id, target.shown, parseValues(current), this.textOf(request, current));
    const conflict = typeof request.baseHash === "string" && request.baseHash !== sha256(current);
    return this.report(current, candidate, conflict);
  }

  save(id: string, request: Partial<SaveRequest>, by: string | null, action: HistoryAction = "save", restoredFrom?: string): SaveResult {
    if (typeof request.baseHash !== "string" || !/^[0-9a-f]{64}$/.test(request.baseHash)) {
      throw new SettingsError(400, "baseHash (the file's hash when it was loaded) is required", "bad_request");
    }
    const target = this.target(id);
    const current = this.readTarget(target);
    const currentHash = sha256(current);
    const before = parseValues(current);
    const candidate = this.candidate(id, target.shown, before, this.textOf(request, current));

    if (request.baseHash !== currentHash) {
      throw new SettingsError(
        409,
        `${target.shown} changed since it was loaded (by hand or from another browser); review the changes against the current file and save again`,
        "conflict",
        this.report(current, candidate, true),
      );
    }
    if (candidate.errors.length > 0) {
      throw new SettingsError(422, "The change is not valid; nothing was written", "invalid", this.report(current, candidate, false));
    }
    if (candidate.commands.length > 0 && request.confirmCommands !== candidate.digest) {
      throw new SettingsError(
        428,
        "The change adds or changes commands Lair runs; confirm them to save",
        "confirm_commands",
        this.report(current, candidate, false),
      );
    }
    const diff = lineDiff(current, candidate.text);
    if (candidate.text === current) {
      return { hash: currentHash, version: this.history.list(id)[0]?.version ?? "", diff, reloadProblem: null };
    }

    this.keepFoundOnDisk(id, current, currentHash);
    writeFileAtomic(target.path, candidate.text, {
      beforeRename: () => {
        const now = readProjectFile(target.path, target.shown, MAX_CONFIG_BYTES);
        if (now === null || sha256(now) !== currentHash) {
          throw new SettingsError(409, `${target.shown} changed while it was being saved; nothing was written`, "conflict");
        }
      },
    });
    const version = this.history.record(id, candidate.text, { action, by, restoredFrom });
    return { hash: sha256(candidate.text), version: version.version, diff, reloadProblem: this.reloadNow(id) };
  }

  /**
   * The file as it is on disk, when Settings has not recorded it (a hand
   * edit), so it can be restored. A file that holds anything that is or
   * looks like a secret is never copied into the history: only a note of it
   * is kept, with its hash, so it is not noted again.
   */
  private keepFoundOnDisk(id: string, current: string, hash: string): void {
    if (this.history.list(id)[0]?.hash === hash) return;
    if (holdsSecrets(parseValues(current) ?? {}, current)) {
      this.history.record(id, null, { action: "file", by: null, hash });
    } else {
      this.history.record(id, current, { action: "file", by: null });
    }
  }

  private reloadNow(id: string): string | null {
    try {
      this.options.reload?.(id);
    } catch (e) {
      return message(e);
    }
    return this.options.reloadProblem?.(id) ?? null;
  }

  // ============ HISTORY ============

  versions(id: string): HistoryVersion[] {
    this.target(id);
    return this.history.list(id);
  }

  version(id: string, version: string): HistoryDetail {
    const target = this.target(id);
    if (!VERSION_PATTERN.test(version)) throw new SettingsError(400, "Invalid version", "bad_request");
    const found = this.history.read(id, version);
    if (!found) throw new SettingsError(404, `No version ${version} of ${id}`, "unknown_version");
    if (found.yaml === null) {
      throw new SettingsError(
        404,
        `Version ${version} of ${id} is not kept: the file held what looks like a secret when Settings found it, so only a note of it was kept`,
        "not_kept",
      );
    }
    const list = this.history.list(id);
    const older = list.find((v) => v.version < version);
    const previous = older ? this.history.read(id, older.version) : null;
    const current = this.readTarget(target);
    return {
      info: found.info,
      yaml: found.yaml,
      fromPrevious: previous && previous.yaml !== null ? lineDiff(previous.yaml, found.yaml) : null,
      restoreDiff: lineDiff(current, found.yaml),
    };
  }

  restore(id: string, version: string, request: Partial<SaveRequest>, by: string | null): SaveResult {
    const detail = this.version(id, version);
    return this.save(id, { baseHash: request.baseHash, yaml: detail.yaml, confirmCommands: request.confirmCommands }, by, "restore", version);
  }

  restoreDryRun(id: string, version: string, request: Partial<SaveRequest>): SettingsCheck {
    const detail = this.version(id, version);
    return this.dryRun(id, { baseHash: request.baseHash, yaml: detail.yaml });
  }

  // ============ CREATE ============

  private async git(repo: string, args: string[]): Promise<GitResult> {
    return new Promise((resolve) => {
      execFile(
        "git",
        ["-c", "core.fsmonitor=false", "-C", repo, ...args],
        {
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: 256 * 1024,
          // Never the server's environment (tokens): what git needs, and no prompt
          env: {
            PATH: this.env.PATH ?? "/usr/bin:/bin",
            HOME: this.env.HOME ?? "/",
            GIT_TERMINAL_PROMPT: "0",
            GIT_OPTIONAL_LOCKS: "0",
            LC_ALL: "C",
          },
        },
        (error, stdout) => {
          const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
          resolve({ code, stdout: String(stdout) });
        },
      );
    });
  }

  private repoPathProblem(path: unknown): string | null {
    if (typeof path !== "string" || path.length === 0) return "required";
    if (path.length > MAX_PATH || unsafeText(path)) return "not a path";
    if (path.startsWith("-")) return "must not start with '-'";
    if (!isAbsolute(path)) return "use an absolute path";
    return null;
  }

  /** Whether `path` is a git work tree, and its GitHub remote. Reads only (`git rev-parse`, `git remote -v`). */
  async checkRepo(path: unknown): Promise<RepoCheck> {
    const shown = typeof path === "string" ? path : "";
    const base = join(shown || "/", "work");
    const suggested = {
      queue_file: join(base, "queue.md"),
      agents_dir: join(base, "agents"),
      gates_dir: join(base, "gates"),
    };
    const empty: RepoCheck = { path: shown, exists: false, gitRepo: false, github: null, remotes: [], suggested };
    const problem = this.repoPathProblem(path);
    if (problem) return { ...empty, problem };
    const repo = path as string;
    let isDir = false;
    try {
      isDir = statSync(repo).isDirectory();
    } catch {
      return { ...empty, problem: "no such directory" };
    }
    if (!isDir) return { ...empty, problem: "not a directory" };
    const inside = await this.git(repo, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") {
      return { ...empty, exists: true, problem: "not a git work tree (git rev-parse --is-inside-work-tree)" };
    }
    const listed = await this.git(repo, ["remote", "-v"]);
    const remotes = new Map<string, { name: string; url: string; github: string | null }>();
    for (const line of listed.stdout.split("\n").slice(0, 200)) {
      const match = /^(\S{1,100})\t(\S{1,2000}) \((fetch|push)\)$/.exec(line.slice(0, 2200));
      if (!match || remotes.has(match[1])) continue;
      remotes.set(match[1], { name: match[1], url: redactUrl(match[2]), github: githubOf(match[2]) });
    }
    const ordered = [...remotes.values()].sort((a, b) => (a.name === "origin" ? -1 : b.name === "origin" ? 1 : a.name.localeCompare(b.name)));
    return {
      path: repo,
      exists: true,
      gitRepo: true,
      github: ordered.find((r) => r.github)?.github ?? null,
      remotes: ordered,
      suggested,
    };
  }

  private createTarget(id: unknown): Target {
    if (typeof id !== "string" || !isSafeProjectName(id)) {
      const check: SettingsCheck = {
        ok: false,
        errors: [{ path: "id", message: "letters, digits, '.', '_' and '-', starting with a letter or digit (at most 100)" }],
        diff: lineDiff("", ""),
        yaml: "",
        commands: [],
        commandsDigest: "",
        conflict: false,
        currentHash: null,
      };
      throw new SettingsError(422, "The project can't be created", "invalid", check);
    }
    if (listProjects(this.projectsDir).includes(id)) {
      throw new SettingsError(409, `A project named ${id} exists already`, "exists");
    }
    const path = join(this.projectsDir, "local", `${id}.yaml`);
    return { id, path, shown: this.display(path), local: true };
  }

  /** The new project's file and its checks, without writing it. */
  async createCheck(request: Partial<CreateProjectRequest>): Promise<{ target: Target; check: SettingsCheck }> {
    const target = this.createTarget(request.id);
    const errors: FieldError[] = [];
    const name = typeof request.name === "string" ? request.name.trim() : "";
    if (name.length === 0 || name.length > MAX_NAME || unsafeText(name)) {
      errors.push({ path: "name", message: `a name of 1 to ${MAX_NAME} characters` });
    }
    const repo = await this.checkRepo(request.repo);
    if (repo.problem) errors.push({ path: "repo", message: repo.problem });
    const github = typeof request.github === "string" && request.github.trim() !== "" ? request.github.trim() : repo.github;
    if (github !== null && !GITHUB_REPO.test(github)) errors.push({ path: "github", message: "use owner/name" });
    const pathOf = (key: "queue_file" | "agents_dir" | "gates_dir"): string => {
      const value = request[key];
      if (value === undefined || value === "") return repo.suggested[key];
      if (typeof value !== "string" || value.length > MAX_PATH || unsafeText(value) || value.startsWith("-")) {
        errors.push({ path: key, message: "not a path" });
        return "";
      }
      return value;
    };
    const modules = request.modules ?? [];
    const toggles = new Set(this.sections.filter((s) => s.toggle).map((s) => s.key));
    if (!Array.isArray(modules) || modules.some((m) => typeof m !== "string" || !toggles.has(m))) {
      errors.push({ path: "modules", message: `modules to switch on: ${[...toggles].join(", ")}` });
    }

    const values: Record<string, unknown> = {
      name: name || target.id,
      repo: repo.path,
      github: github ?? undefined,
      queue_file: pathOf("queue_file"),
      agents_dir: pathOf("agents_dir"),
      gates_dir: pathOf("gates_dir"),
      read_only: true,
      machines: { local: { name: "This machine", type: "local" } },
    };
    for (const key of Array.isArray(modules) ? modules.filter((m) => toggles.has(m)) : []) values[key] = { enabled: true };
    const text = newConfigText(
      values,
      ` ${name || target.id}: created from Lair's Settings.\n Edit it there or by hand; Settings keeps comments and key order.`,
    );
    const candidate = this.candidate(target.id, target.shown, {}, text);
    candidate.errors.unshift(...errors);
    return { target, check: this.report(null, candidate, false) };
  }

  /** Write projects/local/<id>.yaml for a new project; live reload starts its modules. */
  async create(request: Partial<CreateProjectRequest>, by: string | null): Promise<SaveResult & { id: string; file: string }> {
    const { target, check } = await this.createCheck(request);
    if (check.errors.length > 0) throw new SettingsError(422, "The project can't be created", "invalid", check);
    if (check.commands.length > 0 && request.confirmCommands !== check.commandsDigest) {
      throw new SettingsError(428, "The project runs commands; confirm them to create it", "confirm_commands", check);
    }
    this.checkDirs(true, true);
    writeFileAtomic(target.path, check.yaml, {
      mode: 0o600,
      beforeRename: () => {
        if (fileProblem(target.path, target.shown) !== null || existsSync(target.path) || listProjects(this.projectsDir).includes(target.id)) {
          throw new SettingsError(409, `A project named ${target.id} exists already`, "exists");
        }
      },
    });
    const version = this.history.record(target.id, check.yaml, { action: "create", by });
    return {
      id: target.id,
      file: target.shown,
      hash: sha256(check.yaml),
      version: version.version,
      diff: check.diff,
      reloadProblem: this.reloadNow(target.id),
    };
  }
}
