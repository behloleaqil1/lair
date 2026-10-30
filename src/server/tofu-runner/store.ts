/**
 * Plan storage: one `<id>.tfplan` and one `<id>.json` per plan in the configured
 * directory (mode 0600). A plan can be applied once; a newer plan of the same
 * project, root and environment supersedes the older.
 */
import { createHash } from "crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";

export type PlanStatus = "planned" | "applying" | "applied" | "failed" | "stale" | "superseded";

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
}

const ID = /^[a-f0-9]{24}$/;

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export class PlanStore {
  constructor(private readonly dir: string) {}

  async save(record: PlanRecord, planFile: Buffer): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const old of await this.list()) {
      if (old.status === "planned" && old.project === record.project && old.root === record.root && old.env === record.env) {
        await this.update({ ...old, status: "superseded" });
        await this.dropFile(old.id);
      }
    }
    await writeFile(join(this.dir, `${record.id}.tfplan`), planFile, { mode: 0o600 });
    await writeFile(join(this.dir, `${record.id}.json`), JSON.stringify(record), { mode: 0o600 });
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
    await writeFile(join(this.dir, `${record.id}.json`), JSON.stringify(record), { mode: 0o600 });
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
