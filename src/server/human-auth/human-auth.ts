/**
 * The owner's credential: who may use the routes only a human may use
 * (answering decisions; reviews and policy reuse it). The server has no user
 * accounts, and every local process can reach its port, including the agents
 * whose work those routes gate.
 *
 * - On first start the server writes a random owner token to
 *   data/owner.token (mode 0600) and prints a setup link once (announce()).
 * - A browser on the dashboard exchanges the token for a session
 *   (createSession): a random value returned once, which the dashboard keeps
 *   in its own origin's localStorage. The server stores only an HMAC of it
 *   (keyed by the token), with when it was made and last used and the
 *   browser's user agent, so a new token invalidates every session.
 * - An owner-only request carries the session in the X-Lair-Owner-Session
 *   header, from the dashboard's own origin, as a same-origin browser
 *   request (Origin + Sec-Fetch-Site). No cookie is involved: cookies ignore
 *   the port, so any other local listener the browser visits would get one.
 *   A custom header also makes other origins need a CORS preflight, which
 *   these routes never grant (cors.ts).
 *
 * Limits: a process running as the same OS user can read data/ (the token)
 * and the server's log (the setup link). Run agents as a separate OS user.
 */
import Database from "better-sqlite3";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { IncomingHttpHeaders } from "http";
import type { FastifyReply, FastifyRequest } from "fastify";
import { allowedOrigins } from "../origin.js";

/** The request header that carries an owner session. */
export const OWNER_SESSION_HEADER = "x-lair-owner-session";

const MIN_TOKEN_LENGTH = 32;
/** Older sessions (least recently used) are dropped past this many */
const MAX_SESSIONS = 20;
const MAX_USER_AGENT = 200;

export interface OwnerSession {
  /** Public id, for the list and for revoking; not the secret value */
  id: string;
  createdAt: string;
  lastUsedAt: string;
  userAgent: string;
}

export type OwnerCheck = { ok: true; session: OwnerSession } | { ok: false; reason: string };

interface SessionRow {
  id: string;
  hash: string;
  created_at: string;
  last_used_at: string;
  user_agent: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS owner_sessions (
    id TEXT PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    user_agent TEXT NOT NULL
  );
`;

function printable(text: string): string {
  return [...text].map((ch) => (ch < " " || ch === "\u007f" ? " " : ch)).join("");
}

function toSession(row: SessionRow): OwnerSession {
  return { id: row.id, createdAt: row.created_at, lastUsedAt: row.last_used_at, userAgent: row.user_agent };
}

/** The dashboard's URL for a bind address: a wildcard means this machine (localhost). */
export function dashboardUrlFor(host: string, port: number): string {
  const h = host.trim();
  if (h === "" || h === "0.0.0.0" || h === "::" || h === "[::]") return `http://localhost:${port}`;
  return `http://${h.includes(":") && !h.startsWith("[") ? `[${h}]` : h}:${port}`;
}

export interface RequestCheckOptions {
  /** The request's method: browsers send no Origin on a same-origin GET or HEAD */
  method?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Why a request is not a same-origin request from the dashboard in a
 * browser, or null when it is. Non-browser clients (curl, scripts, agents)
 * send no Origin and no Sec-Fetch-Site. A same-origin GET or HEAD from a
 * browser has no Origin either; Sec-Fetch-Site says where it came from.
 */
export function dashboardRequestProblem(
  headers: IncomingHttpHeaders,
  options: RequestCheckOptions = {},
): string | null {
  const env = options.env ?? process.env;
  const sameOrigin = headers["sec-fetch-site"] === "same-origin";
  const origin = headers.origin;
  if (typeof origin !== "string" || origin === "") {
    if ((options.method === "GET" || options.method === "HEAD") && sameOrigin) return null;
    return "no Origin header";
  }
  let normalized: string;
  try {
    normalized = new URL(origin).origin.toLowerCase();
  } catch {
    return "an invalid Origin header";
  }
  if (!allowedOrigins(env).has(normalized)) return "not the dashboard's origin";
  if (!sameOrigin) return "not a same-origin browser request";
  return null;
}

/** The token in `path`, or a new one written there (mode 0600) when it is missing or too short. */
function loadOrCreateToken(path: string): { token: string; created: boolean } {
  if (existsSync(path)) {
    const token = readFileSync(path, "utf-8").trim();
    if (token.length >= MIN_TOKEN_LENGTH) return { token, created: false };
  }
  mkdirSync(dirname(path), { recursive: true });
  const token = randomBytes(32).toString("base64url");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  // writeFileSync keeps the mode of a file that already existed
  chmodSync(path, 0o600);
  return { token, created: true };
}

export interface HumanAuthOptions {
  /** data/owner.token in the server */
  tokenPath: string;
  /** data/owner-sessions.db in the server; ":memory:" in tests */
  dbPath: string;
  clock?: { now(): number };
}

export class HumanAuth {
  private verified = new WeakMap<object, OwnerSession>();

  private constructor(
    private readonly token: string,
    private readonly db: Database.Database,
    /** True when this start created the token (announce() prints the setup link then) */
    readonly created: boolean,
    readonly tokenPath: string,
    private readonly clock: { now(): number },
  ) {}

  static open(options: HumanAuthOptions): HumanAuth {
    const { token, created } = loadOrCreateToken(options.tokenPath);
    if (options.dbPath !== ":memory:") mkdirSync(dirname(options.dbPath), { recursive: true });
    const db = new Database(options.dbPath);
    if (options.dbPath !== ":memory:") db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    // A new token invalidates every session (their hashes no longer match); drop them
    if (created) db.exec("DELETE FROM owner_sessions");
    return new HumanAuth(token, db, created, options.tokenPath, options.clock ?? { now: () => Date.now() });
  }

  close(): void {
    this.db.close();
  }

  private iso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private hash(value: string): Buffer {
    return createHmac("sha256", this.token).update(value).digest();
  }

  /** The link that signs a browser in; the token is in the fragment, which browsers never send. */
  setupUrl(dashboardUrl: string): string {
    return `${dashboardUrl.replace(/\/+$/, "")}/#owner-token=${this.token}`;
  }

  /** Print where the token is, and on first start the setup link, to `log` (the server's stdout). */
  announce(dashboardUrl: string, log: (line: string) => void = (line) => console.log(line)): void {
    if (this.created) {
      log(
        `[owner] Only you answer decisions. Open this link once in your browser to sign it in: ` +
          `${this.setupUrl(dashboardUrl)} (or paste the token from ${this.tokenPath} in the Decisions view)`,
      );
    } else {
      log(`[owner] The owner token is in ${this.tokenPath}`);
    }
  }

  matchesToken(candidate: unknown): boolean {
    if (typeof candidate !== "string") return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * A new session for a browser that presented the token, or null when the
   * token is wrong. The value is returned here once and never stored.
   */
  createSession(token: unknown, userAgent?: string): { session: string; info: OwnerSession } | null {
    if (!this.matchesToken(token)) return null;
    const value = randomBytes(32).toString("base64url");
    const at = this.iso();
    const row: SessionRow = {
      id: randomUUID(),
      hash: this.hash(value).toString("hex"),
      created_at: at,
      last_used_at: at,
      user_agent: printable(userAgent ?? "").slice(0, MAX_USER_AGENT),
    };
    this.db
      .prepare(`INSERT INTO owner_sessions (id, hash, created_at, last_used_at, user_agent) VALUES (?, ?, ?, ?, ?)`)
      .run(row.id, row.hash, row.created_at, row.last_used_at, row.user_agent);
    this.db
      .prepare(
        `DELETE FROM owner_sessions WHERE id NOT IN
           (SELECT id FROM owner_sessions ORDER BY last_used_at DESC, rowid DESC LIMIT ?)`,
      )
      .run(MAX_SESSIONS);
    return { session: value, info: toSession(row) };
  }

  /** The session a presented value belongs to, comparing against every stored hash in constant time. */
  findSession(value: unknown): OwnerSession | null {
    if (typeof value !== "string" || value.length < 20 || value.length > 200) return null;
    const presented = this.hash(value);
    const rows = this.db.prepare(`SELECT * FROM owner_sessions`).all() as SessionRow[];
    let match: SessionRow | null = null;
    for (const row of rows) {
      const stored = Buffer.from(row.hash, "hex");
      if (stored.length === presented.length && timingSafeEqual(stored, presented)) match = row;
    }
    return match ? toSession(match) : null;
  }

  /**
   * Is this the owner? A same-origin browser request from the dashboard
   * carrying a live session in the X-Lair-Owner-Session header. Records the
   * session's use.
   */
  verifyRequest(headers: IncomingHttpHeaders, options: RequestCheckOptions = {}): OwnerCheck {
    const problem = dashboardRequestProblem(headers, options);
    if (problem) return { ok: false, reason: problem };
    const raw = headers[OWNER_SESSION_HEADER];
    if (typeof raw !== "string" || raw === "") return { ok: false, reason: "this browser is not signed in as the owner" };
    const session = this.findSession(raw);
    if (!session) {
      return { ok: false, reason: "this browser's owner session is not valid (signed out, or the owner token changed)" };
    }
    const at = this.iso();
    this.db.prepare(`UPDATE owner_sessions SET last_used_at = ? WHERE id = ?`).run(at, session.id);
    return { ok: true, session: { ...session, lastUsedAt: at } };
  }

  /** Signed-in browsers, most recently used first. */
  listSessions(): OwnerSession[] {
    const rows = this.db
      .prepare(`SELECT * FROM owner_sessions ORDER BY last_used_at DESC, rowid DESC`)
      .all() as SessionRow[];
    return rows.map(toSession);
  }

  /** Sign one browser out. True when the session existed. */
  revoke(id: string): boolean {
    return this.db.prepare(`DELETE FROM owner_sessions WHERE id = ?`).run(id).changes > 0;
  }

  /**
   * A route `onRequest` hook: only the owner gets past it (403 otherwise),
   * before the body is read. sessionOf(request) then gives the session.
   */
  requireOwner(refusal = "Only the owner can do this, from the dashboard") {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const check = this.verifyRequest(request.headers, { method: request.method });
      if (!check.ok) {
        return reply
          .code(403)
          .send({ success: false, error: `${refusal}: ${check.reason}`, timestamp: new Date().toISOString() });
      }
      this.verified.set(request, check.session);
    };
  }

  /**
   * A module-wide `onRequest` hook: every request that can change something
   * (any method but GET, HEAD and OPTIONS) needs the owner, as requireOwner();
   * reads stay open. For route modules whose writes are all the human's, so a
   * write route added later can't be left open by mistake.
   */
  requireOwnerForChanges(refusal = "Only the owner can do this, from the dashboard signed in as the owner") {
    const owner = this.requireOwner(refusal);
    return async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
      return owner(request, reply);
    };
  }

  /** A route `onRequest` hook: only a same-origin browser request from the dashboard (403 otherwise). */
  requireDashboard(refusal = "Only the dashboard can do this") {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const problem = dashboardRequestProblem(request.headers, { method: request.method });
      if (problem) {
        return reply
          .code(403)
          .send({ success: false, error: `${refusal}: ${problem}`, timestamp: new Date().toISOString() });
      }
    };
  }

  /** The owner session requireOwner() verified for this request. */
  sessionOf(request: FastifyRequest): OwnerSession | undefined {
    return this.verified.get(request);
  }
}
