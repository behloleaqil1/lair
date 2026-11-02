/**
 * Versioned artifacts on disk (data/brain/): one directory per run, never
 * overwritten, holding the model and its bench report. A run history and the
 * pointer to the model that shadows are kept beside them. Nothing here is a
 * promotion: `best` only says which model writes proposals into the trace.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { MAX_MODEL_BYTES, parseModel } from "./model.js";
import type { RunReport, TreeModel } from "./types.js";

const VERSION = /^m-\d{14}(-\d{1,3})?$/;
const MAX_REPORT_BYTES = 1024 * 1024;

export function isVersion(v: string): boolean {
  return VERSION.test(v);
}

function stamp(at: Date): string {
  return at.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

function readBounded(path: string, max: number): string | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  if (Buffer.byteLength(text) > max) throw new Error(`${path} is over ${max} bytes`);
  return text;
}

/** Write through a temporary file so a reader never sees half of it. */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

export interface BestPointer {
  version: string;
  at: string;
}

export class ModelStore {
  constructor(private readonly root: string) {}

  private ensure(): void {
    mkdirSync(join(this.root, "models"), { recursive: true, mode: 0o700 });
  }

  get shadowTracePath(): string {
    return join(this.root, "shadow-trace.jsonl");
  }

  /** A fresh version directory name for a run at `at`; an existing one is never reused. */
  newVersion(at: Date): string {
    this.ensure();
    const base = `m-${stamp(at)}`;
    for (let n = 1; n < 1000; n++) {
      const version = n === 1 ? base : `${base}-${n}`;
      try {
        mkdirSync(join(this.root, "models", version), { mode: 0o700 });
        return version;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    throw new Error("could not make a model version");
  }

  versionDir(version: string): string {
    if (!isVersion(version)) throw new Error("not a model version");
    return join(this.root, "models", version);
  }

  saveModel(version: string, model: TreeModel, report: RunReport): void {
    const dir = this.versionDir(version);
    writeAtomic(join(dir, "model.json"), JSON.stringify(model));
    writeAtomic(join(dir, "report.json"), JSON.stringify(report, null, 2));
  }

  loadModel(version: string): TreeModel | null {
    const text = readBounded(join(this.versionDir(version), "model.json"), MAX_MODEL_BYTES);
    return text === null ? null : parseModel(text);
  }

  loadReport(version: string): RunReport | null {
    try {
      const text = readBounded(join(this.versionDir(version), "report.json"), MAX_REPORT_BYTES);
      return text === null ? null : (JSON.parse(text) as RunReport);
    } catch {
      return null;
    }
  }

  /** Every run, trained or not, oldest first: the curve is drawn from it. */
  appendRun(report: RunReport): void {
    this.ensure();
    appendFileSync(join(this.root, "runs.jsonl"), `${JSON.stringify(report)}\n`, { mode: 0o600 });
  }

  runs(limit = 500): RunReport[] {
    return this.readRuns(limit).runs;
  }

  /** The newest `limit` runs; a line that is not a run is skipped and counted, never an error. */
  readRuns(limit = 500): { runs: RunReport[]; skipped: number } {
    let text: string | null;
    try {
      text = readBounded(join(this.root, "runs.jsonl"), 8 * 1024 * 1024);
    } catch {
      return { runs: [], skipped: 1 };
    }
    if (text === null) return { runs: [], skipped: 0 };
    const runs: RunReport[] = [];
    let skipped = 0;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || typeof (parsed as RunReport).status !== "string") throw new Error("not a run");
        runs.push(parsed as RunReport);
      } catch {
        skipped++;
      }
    }
    return { runs: runs.slice(-limit), skipped };
  }

  best(): BestPointer | null {
    try {
      const text = readBounded(join(this.root, "best.json"), 4096);
      if (text === null) return null;
      const raw = JSON.parse(text) as BestPointer;
      return typeof raw?.version === "string" && isVersion(raw.version) ? raw : null;
    } catch {
      return null;
    }
  }

  setBest(version: string, at: string): void {
    this.versionDir(version);
    writeAtomic(join(this.root, "best.json"), JSON.stringify({ version, at }));
  }
}
