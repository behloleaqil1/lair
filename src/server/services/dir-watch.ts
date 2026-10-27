/**
 * Watch the entries of one folder, at the cost of one watch for the folder.
 *
 * The folder itself is watched with fs.watch: inotify on Linux (one watch,
 * no descriptor), FSEvents on macOS (no descriptor), ReadDirectoryChangesW
 * on Windows (one handle). No file is ever watched or opened to be watched:
 * a watch per file (what chokidar 4 does on macOS, where it has no fsevents)
 * holds a descriptor for every file, and folders that grow by hundreds of
 * files a day ran a long-running server out of them.
 *
 * Only the folder's direct entries whose name `accept` takes are looked at,
 * with one lstat after the debounce. The rest (subfolders and what they
 * hold, archives, other files) costs nothing.
 *
 * A folder that can't be watched (missing, the watch failed or was lost) is
 * polled instead every `pollMs`, with a bounded scan: one readdir, then an
 * lstat of the new names and of the `pollLimit` most recently changed
 * files. When the folder can be watched again, polling stops.
 */
import { lstatSync, readdirSync, statSync, watch as fsWatch, type FSWatcher, type Stats, type WatchListener } from "fs";
import { join } from "path";

export type DirEntryEvent = "add" | "change" | "unlink" | "addDir" | "unlinkDir";

/** fs.watch on one folder (injectable, so tests can count the watches) */
export type WatchFn = (dir: string, listener: WatchListener<string>) => FSWatcher;

export interface DirWatchOptions {
  /** Whether an entry (its name in the folder) is worth an event */
  accept: (name: string) => boolean;
  onEvent: (event: DirEntryEvent, path: string, name: string) => void;
  /** Quiet time per entry before it is looked at (default 100 ms) */
  debounceMs?: number;
  /** Polling interval when the folder isn't watched (default 5000 ms) */
  pollMs?: number;
  /** Files a poll re-checks, newest first (default 200) */
  pollLimit?: number;
  /** "poll": never fs.watch, for folders whose events can wait (default "watch") */
  mode?: "watch" | "poll";
  watch?: WatchFn;
  /** A watch that failed or was lost (the folder is polled from then on) */
  onError?: (message: string) => void;
}

export const defaultWatch: WatchFn = (dir, listener) =>
  // persistent: false, so a watch never keeps the process alive by itself
  fsWatch(dir, { persistent: false }, listener);

/** Not looked at yet (an entry of the first listing) */
const UNKNOWN = -1;
/** Timer keys that can't be file names */
const RESCAN = "\0rescan";
const FOLDER = "\0folder";

interface Entry {
  dir: boolean;
  mtimeMs: number;
  size: number;
  ino: number;
}

function message(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code ?? (e instanceof Error ? e.message : String(e));
}

export class DirWatch {
  private readonly entries = new Map<string, Entry>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private watcher: FSWatcher | null = null;
  private dirIno: number | null = null;
  private poller: NodeJS.Timeout | null = null;
  /** The last failure reported, so a watch that keeps failing is said once */
  private failure: string | null = null;
  private started = false;
  private stopped = false;
  private readonly debounceMs: number;
  private readonly pollMs: number;
  private readonly pollLimit: number;

  constructor(
    readonly dir: string,
    private readonly options: DirWatchOptions,
  ) {
    this.debounceMs = options.debounceMs ?? 100;
    this.pollMs = options.pollMs ?? 5000;
    this.pollLimit = options.pollLimit ?? 200;
  }

  /** "watching" (fs.watch on the folder), "polling", "stopped", or "idle" before start() */
  get state(): "idle" | "watching" | "polling" | "stopped" {
    if (this.stopped) return "stopped";
    if (this.watcher) return "watching";
    return this.poller ? "polling" : "idle";
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    // The watch first, then the listing: an entry made between the two is
    // in the listing, or its event comes after it
    const watching = this.options.mode !== "poll" && this.arm();
    // A polled folder's files are looked at once now, so its first poll can
    // tell a change; a watched one learns them from its events
    this.scan(false, !watching);
    if (!watching) this.startPolling();
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.disarm();
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }

  private arm(): boolean {
    let watcher: FSWatcher;
    try {
      // stat, not lstat: a folder given as a symbolic link is watched where it points
      const st = statSync(this.dir);
      if (!st.isDirectory()) throw Object.assign(new Error("not a folder"), { code: "ENOTDIR" });
      this.dirIno = st.ino;
      watcher = (this.options.watch ?? defaultWatch)(this.dir, (type, name) => this.onRaw(type, name));
    } catch (e) {
      // A missing folder is polled until it exists; anything else is said once
      const why = `watching ${this.dir} failed (${message(e)}); polling it every ${this.pollMs / 1000} s`;
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" && why !== this.failure) this.report(why);
      this.failure = why;
      return false;
    }
    watcher.on("error", (e) => this.lost(`the watch on ${this.dir} failed (${message(e)})`));
    this.watcher = watcher;
    return true;
  }

  private disarm(): void {
    const watcher = this.watcher;
    this.watcher = null;
    try {
      watcher?.close();
    } catch {
      // Already closed
    }
  }

  /** The watch stopped working: poll the folder until it can be watched again. */
  private lost(why: string): void {
    if (this.stopped || !this.watcher) return;
    this.disarm();
    const text = `${why}; polling it every ${this.pollMs / 1000} s`;
    if (text !== this.failure) this.report(text);
    this.failure = text;
    this.startPolling();
  }

  private startPolling(): void {
    if (this.stopped || this.poller) return;
    this.poller = setInterval(() => this.poll(), this.pollMs);
    this.poller.unref?.();
  }

  private poll(): void {
    if (this.stopped) return;
    if (this.options.mode !== "poll" && this.arm()) {
      // Watched again: what changed meanwhile is caught up once
      if (this.poller) clearInterval(this.poller);
      this.poller = null;
    }
    this.scan(true);
  }

  private onRaw(type: string, filename: string | null): void {
    if (this.stopped) return;
    // The folder itself removed or replaced shows as a rename (of it, or of
    // what it held): its watch would see nothing more, so it is checked
    if (type === "rename") this.schedule(FOLDER);
    const name = filename ?? "";
    // No name (the kernel's queue overflowed): look at the whole folder again
    if (name === "") return this.schedule(RESCAN);
    // Only the folder's own entries
    if (name.includes("/") || name.includes("\\")) return;
    if (this.options.accept(name)) this.schedule(name);
  }

  /** Still the folder that is watched? If not, poll it until it can be watched again. */
  private checkFolder(): void {
    let ino: number | null = null;
    try {
      ino = statSync(this.dir).ino;
    } catch {
      // Gone
    }
    if (ino === null || ino !== this.dirIno) this.lost(`${this.dir} was removed or replaced`);
  }

  private schedule(name: string): void {
    clearTimeout(this.timers.get(name));
    const timer = setTimeout(() => {
      this.timers.delete(name);
      if (this.stopped) return;
      if (name === FOLDER) this.checkFolder();
      else if (name === RESCAN) this.scan(true);
      else this.check(name, true);
    }, this.debounceMs);
    timer.unref?.();
    this.timers.set(name, timer);
  }

  /**
   * List the folder's accepted entries. The first listing is the baseline
   * (no events, as for entries that were there before the watch); later ones
   * report what was added or removed, and re-check the newest files.
   */
  private scan(emit: boolean, learn = true): void {
    const now = new Map<string, boolean>();
    try {
      for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
        if (this.options.accept(entry.name)) now.set(entry.name, entry.isDirectory());
      }
    } catch {
      // Missing or unreadable: nothing known changes until it can be read
      return;
    }
    if (!emit) {
      for (const [name, dir] of now) {
        if (!this.entries.has(name)) this.entries.set(name, { dir, mtimeMs: UNKNOWN, size: UNKNOWN, ino: UNKNOWN });
      }
      if (learn) this.learn();
      return;
    }
    for (const [name, entry] of [...this.entries]) {
      if (!now.has(name)) {
        this.entries.delete(name);
        this.emit(entry.dir ? "unlinkDir" : "unlink", name);
      }
    }
    for (const name of now.keys()) {
      if (!this.entries.has(name)) this.check(name, true);
    }
    this.learn();
    // Bounded: only the newest files are re-checked for a change
    const newest = [...this.entries]
      .filter(([, e]) => !e.dir)
      .sort((a, b) => b[1].mtimeMs - a[1].mtimeMs)
      .slice(0, this.pollLimit);
    for (const [name] of newest) this.check(name, true);
  }

  /** Look once (without an event) at the files of the listing not looked at yet. */
  private learn(): void {
    for (const [name, entry] of [...this.entries]) {
      if (!entry.dir && entry.mtimeMs === UNKNOWN) this.check(name, false);
    }
  }

  /** Look at one entry (one lstat, never an open) and report what changed. */
  private check(name: string, emit: boolean): void {
    let st: Stats | undefined;
    try {
      st = lstatSync(join(this.dir, name), { throwIfNoEntry: false });
    } catch {
      // Can't be looked at now (permissions): nothing known changes
      return;
    }
    const prev = this.entries.get(name);
    if (!st) {
      if (!prev) return;
      this.entries.delete(name);
      if (emit) this.emit(prev.dir ? "unlinkDir" : "unlink", name);
      return;
    }
    if (st.isDirectory()) {
      if (prev?.dir) return; // A folder's own changes aren't events
      this.entries.set(name, { dir: true, mtimeMs: st.mtimeMs, size: 0, ino: st.ino });
      if (emit) this.emit("addDir", name);
      return;
    }
    const next: Entry = { dir: false, mtimeMs: st.mtimeMs, size: st.size, ino: st.ino };
    this.entries.set(name, next);
    if (!emit) return;
    if (!prev || prev.dir) {
      this.emit("add", name);
    } else if (
      prev.mtimeMs === UNKNOWN ||
      prev.mtimeMs !== next.mtimeMs ||
      prev.size !== next.size ||
      prev.ino !== next.ino
    ) {
      this.emit("change", name);
    }
  }

  private emit(event: DirEntryEvent, name: string): void {
    try {
      this.options.onEvent(event, join(this.dir, name), name);
    } catch (e) {
      this.report(`handling ${event} of ${join(this.dir, name)} failed (${message(e)})`);
    }
  }

  private report(text: string): void {
    if (this.options.onError) this.options.onError(text);
    else console.warn(`[watch] ${text}`);
  }
}
