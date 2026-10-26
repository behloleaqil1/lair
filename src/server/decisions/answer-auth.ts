/**
 * Who may answer: only a human in the Decisions view.
 *
 * The server has no user accounts, and every local process can reach its
 * port, including the agents whose work the decisions gate. So answering
 * needs a capability that only the dashboard holds:
 *
 * - On first start the server writes a random answer token to
 *   data/decisions.answer-token (mode 0600) and prints a one-time setup link.
 * - The Decisions view sends the token once (from the link, or pasted) to
 *   POST /api/decisions/session, which sets an httpOnly, SameSite=Strict
 *   session cookie derived from the token. Page scripts can't read it, and
 *   other sites can't make the browser send it.
 * - Answering requires that cookie AND a browser request from the
 *   dashboard: an Origin that is one of the dashboard's own, and
 *   `Sec-Fetch-Site: same-origin`. Anything else gets 403.
 *
 * Limits: a process running as the same OS user can read data/ and so the
 * token. Running agents as a separate OS user closes that gap.
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { IncomingHttpHeaders } from "http";
import { allowedOrigins } from "../origin.js";

export const SESSION_COOKIE = "lair_decisions";
const COOKIE_PATH = "/api/decisions";
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;
const MIN_TOKEN_LENGTH = 32;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** The value of one cookie in a Cookie header, or undefined. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * Why a request is not a same-origin request from the dashboard in a
 * browser, or null when it is. Non-browser clients (curl, scripts, agents)
 * send no Origin and no Sec-Fetch-Site.
 */
export function dashboardRequestProblem(
  headers: IncomingHttpHeaders,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const origin = headers.origin;
  if (typeof origin !== "string" || origin === "") return "no Origin header";
  let normalized: string;
  try {
    normalized = new URL(origin).origin.toLowerCase();
  } catch {
    return "an invalid Origin header";
  }
  if (!allowedOrigins(env).has(normalized)) return "not the dashboard's origin";
  if (headers["sec-fetch-site"] !== "same-origin") return "not a same-origin browser request";
  return null;
}

export class AnswerCredential {
  private readonly session: string;

  /** True when this start created the token (the setup link is printed then). */
  readonly created: boolean;

  constructor(
    private readonly token: string,
    created = false,
  ) {
    this.created = created;
    this.session = createHmac("sha256", token).update("lair-decisions-session-v1").digest("base64url");
  }

  /**
   * The token in `path`, or a new random one written there with mode 0600
   * when the file is missing (or too short to be one Lair wrote).
   */
  static loadOrCreate(path: string): AnswerCredential {
    if (existsSync(path)) {
      const token = readFileSync(path, "utf-8").trim();
      if (token.length >= MIN_TOKEN_LENGTH) return new AnswerCredential(token, false);
    }
    mkdirSync(dirname(path), { recursive: true });
    const token = randomBytes(32).toString("base64url");
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
    // writeFileSync keeps the mode of a file that already existed
    chmodSync(path, 0o600);
    return new AnswerCredential(token, true);
  }

  /** The link that unlocks answering in a browser; the token is in the fragment, which is never sent. */
  setupUrl(dashboardUrl: string): string {
    return `${dashboardUrl.replace(/\/+$/, "")}/#answer-token=${this.token}`;
  }

  matchesToken(candidate: unknown): boolean {
    return typeof candidate === "string" && safeEqual(candidate, this.token);
  }

  /** The Set-Cookie value that unlocks answering in this browser. */
  sessionCookie(): string {
    return `${SESSION_COOKIE}=${this.session}; HttpOnly; SameSite=Strict; Path=${COOKIE_PATH}; Max-Age=${ONE_YEAR_SECONDS}`;
  }

  /** True when the Cookie header carries this server's answer session. */
  hasSession(cookieHeader: string | undefined): boolean {
    const value = cookieValue(cookieHeader, SESSION_COOKIE);
    return value !== undefined && safeEqual(value, this.session);
  }

  /** Why this request may not answer, or null when it may. */
  answerProblem(headers: IncomingHttpHeaders, env: NodeJS.ProcessEnv = process.env): string | null {
    const problem = dashboardRequestProblem(headers, env);
    if (problem) return problem;
    const cookie = typeof headers.cookie === "string" ? headers.cookie : undefined;
    return this.hasSession(cookie) ? null : "answering is not unlocked in this browser";
  }
}
