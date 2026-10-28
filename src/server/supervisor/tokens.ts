/**
 * Ops API tokens: scoped, read-only, and kept in this server's memory only.
 * Never written to disk, so a restart ends every one.
 *
 * - A run token is minted for one supervisor run, bound to its project. It
 *   is accepted only while the agents module's store has that run active,
 *   ends at once on the module's events for the run (endRun()), and at its
 *   TTL, whichever comes first.
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

export interface OpsTokensOptions {
  /**
   * Whether a run is still going (queued, waiting on a lock, running or
   * stopping), from the agents module's store: a run token is accepted only
   * while its run is, however the run ended (completed, failed over, stopped
   * by the owner, recovered into a new run). Without it, a run token ends on
   * the agents module's events and at its TTL only.
   */
  runActive?: (runId: string) => boolean;
}

export class OpsTokens {
  private byHash = new Map<string, OpsToken>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly options: OpsTokensOptions = {},
  ) {}

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

  /**
   * A run token for a run not requested yet: the token goes into the run's
   * environment when it is requested, so it exists first. It reads nothing
   * until bindRun() binds it to that run; revoke() it if the request fails.
   */
  mintForPendingRun(project: string, ttlMs: number): { token: string; info: OpsTokenView } {
    return this.mint({ kind: "run", label: "run (being requested)", projects: [project], runId: null }, ttlMs);
  }

  /** Bind a pending run token to its run: from now on it lives as long as that run. False when it is gone. */
  bindRun(id: string, runId: string): boolean {
    for (const record of this.byHash.values()) {
      if (record.id === id && record.kind === "run" && record.runId === null) {
        record.runId = runId;
        record.label = `run ${runId.slice(0, 64)}`;
        return true;
      }
    }
    return false;
  }

  /** The live record of a token by its id (never the token). */
  byId(id: string): OpsToken | null {
    for (const record of this.byHash.values()) if (record.id === id) return record;
    return null;
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
    // A run token minted before its run was requested reads nothing until it is bound to that run
    if (record.kind === "run" && record.runId === null) return null;
    // A run token lives only as long as its run, whatever event its end raised (or none)
    if (record.runId !== null && this.options.runActive && !this.options.runActive(record.runId)) {
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
