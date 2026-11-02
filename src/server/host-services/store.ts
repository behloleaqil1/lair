/**
 * Host services store: each service's state, kept in one JSON file per
 * project (data/host-services/<project>.json) so the start count, the
 * backoff, a start in its grace window and the open decision survive a
 * restart. A reload keeps the same store object.
 *
 * The file is read once, asynchronously, before the first tick, and written
 * after each change that matters (a new file, then a rename; one write at a
 * time). No synchronous fs call runs on a tick or request path.
 */
import { randomBytes } from "crypto";
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { dirname } from "path";
import { z } from "zod";
import type { ServiceConfig, StoredServiceState } from "./types.js";

/** The file format's version. Version 1 is the first; there is nothing older to migrate. */
export const STORE_VERSION = 1;

const Iso = z.string().max(40);
const ProbeSchema = z.object({ up: z.boolean(), code: z.number().int(), timedOut: z.boolean(), checkedAt: Iso }).strict();
const StartSchema = z.object({ at: Iso, code: z.number().int().nullable(), timedOut: z.boolean() }).strict();
const StateSchema = z
  .object({
    machine: z.string().max(64),
    name: z.string().max(64),
    state: z.enum(["up", "down", "unknown", "starting", "failing"]),
    lastProbe: ProbeSchema.nullable(),
    lastUpAt: Iso.nullable(),
    upSince: Iso.nullable(),
    outageStartedAt: Iso.nullable(),
    failedProbes: z.number().int().min(0),
    starts: z.number().int().min(0),
    lastStart: StartSchema.nullable(),
    recoveredAfterStart: z.boolean(),
    escalated: z.boolean(),
    decisionId: z.string().max(200).nullable(),
  })
  .strict();
const FileSchema = z.object({ version: z.literal(STORE_VERSION), services: z.array(StateSchema).max(10_000) }).strict();

function key(machine: string, name: string): string {
  return `${machine}\0${name}`;
}

/** A fresh state: nothing probed yet, so nothing is known (and nothing is held). */
export function freshState(machine: string, name: string): StoredServiceState {
  return {
    machine,
    name,
    state: "unknown",
    lastProbe: null,
    lastUpAt: null,
    upSince: null,
    outageStartedAt: null,
    failedProbes: 0,
    starts: 0,
    lastStart: null,
    recoveredAfterStart: false,
    escalated: false,
    decisionId: null,
  };
}

export class HostServicesStore {
  private states = new Map<string, StoredServiceState>();
  private restoring: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();
  /** Why the saved file was not used (kept until the next start) */
  private readProblem: string | null = null;
  /** Why the last write failed (cleared by the next good write) */
  private writeProblem: string | null = null;
  /** A file written by a newer Lair is never overwritten: the states stay in memory */
  private keepFile = false;

  /** @param file the JSON file; without one the store lives in memory only */
  constructor(readonly file?: string) {}

  /** The read or write problem the status shows, or null */
  get problem(): string | null {
    return this.writeProblem ?? this.readProblem;
  }

  /** Read the saved states once; a missing file is an empty store. Never throws. */
  restore(): Promise<void> {
    this.restoring ??= this.read();
    return this.restoring;
  }

  private async read(): Promise<void> {
    if (!this.file) return;
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      this.readFailed(`the saved states could not be read (${(e as NodeJS.ErrnoException).code ?? "error"}); starting fresh`);
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.readFailed("the saved states are not valid JSON; starting fresh");
      return;
    }
    const version = (raw as { version?: unknown } | null)?.version;
    if (typeof version === "number" && version > STORE_VERSION) {
      this.keepFile = true;
      this.readFailed(
        `the saved states were written by a newer Lair (version ${version}, this one reads ${STORE_VERSION}); the file is left as it is and the states are kept in memory only`,
      );
      return;
    }
    const parsed = FileSchema.safeParse(raw);
    if (!parsed.success) {
      this.readFailed(`the saved states (version ${String(version)}) do not have the expected shape; starting fresh`);
      return;
    }
    for (const state of parsed.data.services) {
      const k = key(state.machine, state.name);
      // A state changed in memory before the read finished is newer
      if (!this.states.has(k)) this.states.set(k, state);
    }
  }

  private readFailed(problem: string): void {
    this.readProblem = problem;
    console.warn(`[host-services] ${problem}`);
  }

  /** Write every state (a new file, then a rename). Writes run one at a time; a failure is kept in `problem`. */
  save(): Promise<void> {
    const file = this.file;
    if (!file || this.keepFile) return this.writing;
    const body = `${JSON.stringify({ version: STORE_VERSION, services: this.all() }, null, 2)}\n`;
    const write = async () => {
      const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(tmp, body, { mode: 0o600 });
        await rename(tmp, file);
        this.writeProblem = null;
      } catch (e) {
        this.writeProblem = `the states could not be saved (${(e as NodeJS.ErrnoException).code ?? "error"})`;
        await rm(tmp, { force: true }).catch(() => undefined);
      }
    };
    this.writing = this.writing.then(write, write);
    return this.writing;
  }

  /** Resolves once the writes asked for so far are done. */
  flush(): Promise<void> {
    return this.writing;
  }

  all(): StoredServiceState[] {
    return [...this.states.values()];
  }

  get(machine: string, name: string): StoredServiceState | null {
    return this.states.get(key(machine, name)) ?? null;
  }

  getOrInit(machine: string, name: string): StoredServiceState {
    const k = key(machine, name);
    let state = this.states.get(k);
    if (!state) {
      state = freshState(machine, name);
      this.states.set(k, state);
    }
    return state;
  }

  /** The state whose decision has this key (`<machine>:<service>`), or null. */
  byDecisionKey(decisionKey: string): StoredServiceState | null {
    return this.all().find((s) => `${s.machine}:${s.name}` === decisionKey) ?? null;
  }

  /** Forget services the config no longer has. Returns whether any was dropped. */
  prune(machines: Map<string, ServiceConfig[]>): boolean {
    let dropped = false;
    for (const [k, state] of this.states) {
      if (!(machines.get(state.machine) ?? []).some((s) => s.name === state.name)) {
        this.states.delete(k);
        dropped = true;
      }
    }
    return dropped;
  }
}
