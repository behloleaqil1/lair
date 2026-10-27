/**
 * Live config reload: the modules pick up a project's YAML when it changes,
 * without a restart.
 *
 * The project files (projects/*.yaml and projects/local/*.yaml, .yml too)
 * are watched. A change is debounced per project (1 s), then the effective
 * file is read and checked by loadProjectConfig and by every module's own
 * parser:
 * - invalid: nothing changes. The modules keep running their previous
 *   config, and the error is logged, emitted as `config.invalid`, and kept
 *   for the dashboard's banner (GET /api/config/status);
 * - valid: each module whose part of the config changed (fingerprint()) is
 *   reloaded through its manager's reloadProject(): its instance for that
 *   project stops cleanly, then starts with the new config. Modules whose
 *   part did not change are not touched.
 *
 * Reloads of one module for one project never overlap: a change that comes
 * in while one runs waits for it, and only the latest config is applied
 * after it. A module that fails to start with the new config is started
 * again with the previous one, so none is left half-started.
 */
import { watch, type FSWatcher } from "chokidar";
import { relative, sep } from "path";
import type { EventBus } from "../core/event-bus.js";
import type { ProjectConfig } from "../../shared/types.js";
import type { ConfigProblem, ConfigReload, ConfigStatusView } from "../../shared/lifecycle-types.js";
import { PROJECTS_DIR, getConfigPath, isSafeProjectName, listProjects, loadProjectConfig } from "../config.js";
import { fingerprint, type ProjectEntry, type ReloadableModule } from "./modules.js";

export interface ConfigReloaderOptions {
  modules: ReloadableModule[];
  /** The configs the modules were loaded with at startup */
  initial: ProjectEntry[];
  /** projects/ (default: the one in Lair's working directory) */
  projectsDir?: string;
  /** Quiet time after the last change before the file is read (default 1000 ms) */
  debounceMs?: number;
  events?: EventBus;
  /** A project's new config was accepted (valid); its modules reload next */
  onAccepted?: (project: string, config: ProjectConfig) => void;
  /** File names are shown relative to this (default: the working directory) */
  cwd?: string;
  log?: Pick<Console, "log" | "warn">;
}

const MAX_RECENT = 50;
const MAX_ERROR = 2000;

interface Running {
  fingerprint: string | null;
  entry: ProjectEntry;
}

interface Slot {
  running: Promise<void> | null;
  again: boolean;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function clip(text: string): string {
  return text.length > MAX_ERROR ? `${text.slice(0, MAX_ERROR)}...` : text;
}

export class ConfigReloader {
  private readonly dir: string;
  private readonly cwd: string;
  private readonly debounceMs: number;
  private readonly log: Pick<Console, "log" | "warn">;
  private readonly owned: Set<string>;
  private watcher: FSWatcher | null = null;
  private readyPromise: Promise<void> = Promise.resolve();
  private stopped = false;
  private timers = new Map<string, NodeJS.Timeout>();
  /** project -> the latest valid config and its file */
  private desired = new Map<string, { config: ProjectConfig; file: string }>();
  /** project\0module -> what that module runs for the project */
  private running = new Map<string, Running>();
  private slots = new Map<string, Slot>();
  private problems = new Map<string, ConfigProblem>();
  private recent: ConfigReload[] = [];

  constructor(private readonly options: ConfigReloaderOptions) {
    this.dir = options.projectsDir ?? PROJECTS_DIR;
    this.cwd = options.cwd ?? process.cwd();
    this.debounceMs = options.debounceMs ?? 1000;
    this.log = options.log ?? console;
    this.owned = new Set(options.modules.flatMap((m) => m.blocks));
    for (const entry of options.initial) {
      if (!entry.config) continue;
      try {
        this.desired.set(entry.name, { config: entry.config, file: this.display(getConfigPath(entry.name, this.dir)) });
      } catch {
        // Not a file of this directory: it is only compared against
      }
      for (const module of options.modules) {
        this.running.set(this.key(entry.name, module), {
          fingerprint: this.fingerprintOf(module, entry.config),
          entry: { name: entry.name, config: entry.config },
        });
      }
    }
  }

  private key(project: string, module: ReloadableModule): string {
    return `${project}\0${module.name}`;
  }

  private fingerprintOf(module: ReloadableModule, config: ProjectConfig): string | null {
    try {
      return fingerprint(module, config, this.owned);
    } catch {
      return null;
    }
  }

  /** Watch the project files. */
  start(): void {
    if (this.watcher || this.stopped) return;
    const watcher = watch(this.dir, { ignoreInitial: true, depth: 1, persistent: true });
    const onFile = (path: string) => {
      const project = this.projectOf(path);
      if (project) this.schedule(project);
    };
    watcher.on("add", onFile);
    watcher.on("change", onFile);
    watcher.on("unlink", onFile);
    watcher.on("error", (error: unknown) => {
      this.log.warn(`[config] watching ${this.display(this.dir)} failed: ${message(error)}`);
    });
    this.readyPromise = new Promise<void>((resolve) => {
      watcher.once("ready", () => resolve());
    });
    this.watcher = watcher;
  }

  /** Resolves once the watcher has scanned the directory (changes made after it are seen). */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Stop watching; pending changes are dropped. Reloads in progress are not
   * waited for: the shutdown that follows stops the modules, and a module's
   * reloadProject() does nothing once its manager stopped.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    const watcher = this.watcher;
    this.watcher = null;
    await watcher?.close();
  }

  /** Resolves when no change is waiting and no reload runs (for tests). */
  async settled(): Promise<void> {
    for (;;) {
      if (this.timers.size > 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        continue;
      }
      const busy = [...this.slots.values()].flatMap((s) => (s.running ? [s.running] : []));
      if (busy.length === 0) return;
      await Promise.allSettled(busy);
    }
  }

  status(): ConfigStatusView {
    return {
      watching: this.watcher !== null,
      problems: [...this.problems.values()].sort((a, b) => a.project.localeCompare(b.project)),
      recent: [...this.recent],
    };
  }

  /** The project a file in projects/ or projects/local/ configures, or null. */
  private projectOf(path: string): string | null {
    const parts = relative(this.dir, path).split(sep);
    const file = parts.length === 1 ? parts[0] : parts.length === 2 && parts[0] === "local" ? parts[1] : null;
    const match = file ? /^(.+)\.ya?ml$/.exec(file) : null;
    return match && isSafeProjectName(match[1]) ? match[1] : null;
  }

  private display(path: string): string {
    const rel = relative(this.cwd, path);
    return rel && !rel.startsWith("..") ? rel.split(sep).join("/") : path;
  }

  private schedule(project: string): void {
    if (this.stopped) return;
    clearTimeout(this.timers.get(project));
    const timer = setTimeout(() => {
      this.timers.delete(project);
      this.apply(project);
    }, this.debounceMs);
    timer.unref();
    this.timers.set(project, timer);
  }

  private problem(project: string, file: string, error: string, previousRunning: boolean): void {
    const text = clip(error);
    this.problems.set(project, { project, file, error: text, previousRunning, at: new Date().toISOString() });
    const kept = previousRunning ? "; the previous config is still running" : "";
    this.log.warn(`[config] ${file} has an error${kept}: ${text}`);
    void this.options.events?.emit("config.invalid", { project, file, error: text, previousRunning });
  }

  /** Whether any module runs a config of `project` (one it loaded at startup or took since). */
  private runsSomething(project: string): boolean {
    return [...this.running.entries()].some(([k, r]) => k.startsWith(`${project}\0`) && r.entry.config !== undefined);
  }

  /** Read and check the project's file; when it is valid, reload the modules whose part changed. */
  apply(project: string): void {
    if (this.stopped) return;
    const previousRunning = this.runsSomething(project);
    if (!listProjects(this.dir).includes(project)) {
      if (previousRunning) {
        const file = this.desired.get(project)?.file ?? `projects/${project}.yaml`;
        this.problem(project, file, "the file was removed; Lair keeps running the previous config until it restarts", true);
      } else {
        this.problems.delete(project);
      }
      return;
    }
    const file = this.display(getConfigPath(project, this.dir));
    let config: ProjectConfig;
    try {
      config = loadProjectConfig(project, this.dir);
    } catch (e) {
      this.problem(project, file, message(e), previousRunning);
      return;
    }
    const errors: string[] = [];
    for (const module of this.options.modules) {
      try {
        errors.push(...module.validate(config));
      } catch (e) {
        errors.push(`${module.name}: ${message(e)}`);
      }
      if (this.fingerprintOf(module, config) === null) errors.push(`${module.name}: the config can't be compared`);
    }
    if (errors.length > 0) {
      this.problem(project, file, [...new Set(errors)].join("; "), previousRunning);
      return;
    }
    this.problems.delete(project);
    this.desired.set(project, { config, file });
    try {
      this.options.onAccepted?.(project, config);
    } catch (e) {
      this.log.warn(`[config] ${file}: ${message(e)}`);
    }
    const changed = this.options.modules.filter(
      (m) => this.running.get(this.key(project, m))?.fingerprint !== this.fingerprintOf(m, config),
    );
    if (changed.length === 0) {
      this.log.log(`[config] ${file} changed; no module's settings did`);
      return;
    }
    for (const module of changed) this.queue(project, module);
  }

  private queue(project: string, module: ReloadableModule): void {
    const key = this.key(project, module);
    const slot: Slot = this.slots.get(key) ?? { running: null, again: false };
    this.slots.set(key, slot);
    if (slot.running) {
      // One reload at a time: the latest config is applied once this one ends
      slot.again = true;
      return;
    }
    const run = async () => {
      do {
        slot.again = false;
        await this.reloadOne(project, module);
      } while (slot.again && !this.stopped);
    };
    slot.running = run()
      .catch((e) => this.log.warn(`[config] ${project}: reloading ${module.name} failed: ${message(e)}`))
      .finally(() => {
        slot.running = null;
      });
  }

  private async reloadOne(project: string, module: ReloadableModule): Promise<void> {
    const desired = this.desired.get(project);
    if (!desired || this.stopped) return;
    const key = this.key(project, module);
    const want = this.fingerprintOf(module, desired.config);
    const before = this.running.get(key);
    if (before && before.fingerprint === want) return;
    const entry: ProjectEntry = { name: project, config: desired.config };
    try {
      await module.reload(entry);
    } catch (e) {
      if (this.stopped) return;
      // Never half-started: back to what ran before (off when nothing did)
      const previous = before?.entry ?? { name: project };
      try {
        await module.reload(previous);
        this.problem(
          project,
          desired.file,
          `${module.name} could not start with the new config (${message(e)}); it runs its previous config again`,
          true,
        );
      } catch (again) {
        this.running.set(key, { fingerprint: null, entry: { name: project } });
        this.problem(
          project,
          desired.file,
          `${module.name} could not start with the new config (${message(e)}) nor with the previous one (${message(again)}): it is off for ${project}`,
          false,
        );
      }
      return;
    }
    this.running.set(key, { fingerprint: want, entry });
    const reload: ConfigReload = { project, file: desired.file, module: module.name, at: new Date().toISOString() };
    this.recent.unshift(reload);
    this.recent.length = Math.min(this.recent.length, MAX_RECENT);
    this.log.log(`[config] ${desired.file}: ${module.name} reloaded`);
    void this.options.events?.emit("config.reloaded", { project, file: desired.file, module: module.name });
  }
}
