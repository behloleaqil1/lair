/**
 * Plan storage: one `<id>.tfplan` and one `<id>.json` per plan in the configured
 * directory (mode 0600, the directory 0700 and the process's own). A plan can be
 * applied once; a newer plan of the same project, root and environment
 * supersedes the older. Writes are atomic (a new file, then a rename) and saves
 * go one at a time, so two plans of one workspace cannot both stay `planned`.
 */
import { createHash, randomBytes } from "crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { join } from "path";

export type PlanStatus = "planned" | "applying" | "applied" | "failed" | "stale" | "superseded" | "expired";

export interface PlanRecord {
  id: string;
  project: string;
  root: string;
  env: string;
  /** SHA-256 of the plan file: what the approval carries */
  planHash: string;
  /** Hash of the code the plan was made on */
  codeHash: string;
  createdAt: string;
  status: PlanStatus;
  finishedAt?: string;
  /** Addresses the plan deletes, and those it replaces (delete and create): either needs its own confirmation to apply */
  destroys: string[];
  replaces: string[];
  /** Why a plan ended `failed` without a result (an error, or Lair stopping mid-apply) */
  note?: string;
}

const ID = /^[a-f0-9]{24}$/;

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function writeAtomic(path: string, data: string | Buffer): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, path);
}

export class PlanStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string) {}

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Create the directory when missing (0700) and check it: a directory, owned by
   * this process's user, with no access for group or others. Returns the problem, or undefined.
   */
  async checkDir(): Promise<string | undefined> {
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const st = await stat(this.dir);
      if (!st.isDirectory()) return "plan_dir is not a directory";
      if (typeof process.getuid === "function" && st.uid !== process.getuid()) return "plan_dir is not owned by the user Lair runs as";
      if ((st.mode & 0o077) !== 0) return `plan_dir must not be accessible to group or others (mode is ${(st.mode & 0o777).toString(8)}, needs 700)`;
      return undefined;
    } catch {
      return "plan_dir cannot be created or read";
    }
  }

  save(record: PlanRecord, planFile: Buffer): Promise<void> {
    return this.exclusive(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      for (const old of await this.list()) {
        if (old.status === "planned" && old.project === record.project && old.root === record.root && old.env === record.env) {
          await this.update({ ...old, status: "superseded" });
          await this.dropFile(old.id);
        }
      }
      await writeAtomic(join(this.dir, `${record.id}.tfplan`), planFile);
      await writeAtomic(join(this.dir, `${record.id}.json`), JSON.stringify(record));
    });
  }

  async get(id: string): Promise<PlanRecord | undefined> {
    if (!ID.test(id)) return undefined;
    try {
      return JSON.parse(await readFile(join(this.dir, `${id}.json`), "utf8")) as PlanRecord;
    } catch {
      return undefined;
    }
  }

  async file(id: string): Promise<Buffer | undefined> {
    if (!ID.test(id)) return undefined;
    try {
      return await readFile(join(this.dir, `${id}.tfplan`));
    } catch {
      return undefined;
    }
  }

  async update(record: PlanRecord): Promise<void> {
    await writeAtomic(join(this.dir, `${record.id}.json`), JSON.stringify(record));
  }

  /** A used-up or stale plan keeps its record (the audit trail) but not its file */
  async dropFile(id: string): Promise<void> {
    if (ID.test(id)) await rm(join(this.dir, `${id}.tfplan`), { force: true });
  }

  async list(): Promise<PlanRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: PlanRecord[] = [];
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      const r = await this.get(n.slice(0, -5));
      if (r) out.push(r);
    }
    return out;
  }
}
