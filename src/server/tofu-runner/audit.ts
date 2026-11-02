/**
 * The runner's audit log: one JSON line per plan, per apply request and refusal,
 * per apply start and end, appended to `audit.jsonl` in the plan directory (mode
 * 0600). Who (the owner session id), what (project, environment, root, the full
 * plan hash) and the outcome. It holds no tool output and no credential.
 */
import { appendFile, readFile } from "fs/promises";
import { join } from "path";

export type AuditAction = "plan" | "apply-refused" | "apply-started" | "apply-finished";

export interface AuditEntry {
  at: string;
  action: AuditAction;
  /** The owner session id, or `lair` for what Lair itself does (restart reconciliation) */
  actor: string;
  project: string;
  env?: string;
  root?: string;
  planId?: string;
  /** The full SHA-256 of the plan file */
  planHash?: string;
  outcome: string;
  reason?: string;
  destroys?: string[];
  replaces?: string[];
}

export class AuditLog {
  private readonly file: string;

  constructor(dir: string) {
    this.file = join(dir, "audit.jsonl");
  }

  async append(entry: AuditEntry): Promise<void> {
    await appendFile(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  /** The newest `limit` entries, oldest first */
  async read(limit = 100): Promise<AuditEntry[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return [];
    }
    const entries: AuditEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // a torn last line after a crash is skipped
      }
    }
    return entries.slice(-limit);
  }
}
