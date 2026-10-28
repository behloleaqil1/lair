/**
 * Ops API tokens: scoped, read-only, and kept in this server's memory only.
 * Never written to disk, so a restart ends every one.
 *
 * - A run token is minted for one supervisor run, bound to its project. It
 *   ends with the run (endRun(), when the agents module says the run ended)
 *   or at its TTL, whichever comes first.
 * - A session token is minted by the owner, from a signed-in dashboard, for
 *   an interactive session of any MCP-capable tool (1 hour by default). It
 *   reads every project. The owner can revoke it.
 *
 * A token is 32 random bytes, prefixed `lairops_` so it is recognisable in
 * a leak (and redact.ts takes it out of any text). Only its SHA-256 is
 * kept: a lookup by hash, so no comparison depends on the secret. It is
 * accepted only by the ops API (Authorization: Bearer); it is not an owner
 * session, and no other route reads it.
 */
import { createHash, randomBytes, randomUUID } from "crypto";
import type { OpsTokenView } from "../../shared/supervisor-types.js";

export const TOKEN_PREFIX = "lairops_";
export const SESSION_TTL_MS = 60 * 60_000;
export const MAX_TTL_MS = 8 * 60 * 60_000;
/** Tokens alive at once; the one that expires soonest goes when another is minted */
export const MAX_TOKENS = 50;

export interface OpsToken {
  id: string;
  kind: "run" | "session";
  label: string;
  projects: string[] | "*";
  runId: string | null;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  calls: number;
}

const TOKEN_SHAPE = /^lairops_[A-Za-z0-9_-]{43}$/;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export class OpsTokens {
  private byHash = new Map<string, OpsToken>();

  constructor(private readonly now: () => number = Date.now) {}

  private mint(input: Omit<OpsToken, "id" | "createdAt" | "lastUsedAt" | "calls" | "expiresAt">, ttlMs: number): { token: string; info: OpsTokenView } {
    this.prune();
    while (this.byHash.size >= MAX_TOKENS) {
      const soonest = [...this.byHash.entries()].reduce((a, b) => (b[1].expiresAt < a[1].expiresAt ? b : a));
      this.byHash.delete(soonest[0]);
    }
    const now = this.now();
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const record: OpsToken = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      expiresAt: now + Math.max(1000, Math.min(ttlMs, MAX_TTL_MS)),
      lastUsedAt: null,
      calls: 0,
    };
    this.byHash.set(hash(token), record);
    return { token, info: view(record) };
  }

  /** A token for one supervisor run in `project`: it ends with the run, or after `ttlMs`. */
  mintForRun(runId: string, project: string, ttlMs: number): { token: string; info: OpsTokenView } {
    return this.mint({ kind: "run", label: `run ${runId.slice(0, 64)}`, projects: [project], runId }, ttlMs);
  }

  /** A token for the owner's interactive session, over every project. */
  mintSession(ttlMs: number = SESSION_TTL_MS, label = "owner session"): { token: string; info: OpsTokenView } {
    return this.mint({ kind: "session", label: label.slice(0, 80), projects: "*", runId: null }, ttlMs);
  }

  /** The token's record when it is one of ours and alive; counts the use. */
  verify(presented: string | undefined): OpsToken | null {
    if (!presented || !TOKEN_SHAPE.test(presented)) return null;
    const key = hash(presented);
    const record = this.byHash.get(key);
    if (!record) return null;
    const now = this.now();
    if (now >= record.expiresAt) {
      this.byHash.delete(key);
      return null;
    }
    record.lastUsedAt = now;
    record.calls++;
    return record;
  }

  /** The run ended: its tokens stop working now. Returns how many ended. */
  endRun(runId: string): number {
    let n = 0;
    for (const [key, record] of this.byHash) {
      if (record.runId === runId) {
        this.byHash.delete(key);
        n++;
      }
    }
    return n;
  }

  revoke(id: string): boolean {
    for (const [key, record] of this.byHash) {
      if (record.id === id) {
        this.byHash.delete(key);
        return true;
      }
    }
    return false;
  }

  list(): OpsTokenView[] {
    this.prune();
    return [...this.byHash.values()].sort((a, b) => b.createdAt - a.createdAt).map(view);
  }

  private prune(): void {
    const now = this.now();
    for (const [key, record] of this.byHash) if (now >= record.expiresAt) this.byHash.delete(key);
  }
}

function view(t: OpsToken): OpsTokenView {
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    id: t.id,
    kind: t.kind,
    label: t.label,
    projects: t.projects,
    scope: "read",
    runId: t.runId,
    createdAt: iso(t.createdAt),
    expiresAt: iso(t.expiresAt),
    lastUsedAt: t.lastUsedAt === null ? null : iso(t.lastUsedAt),
    calls: t.calls,
  };
}
