/**
 * Browser-origin and peer checks for the loopback server.
 *
 * The server has no user authentication and binds 127.0.0.1 by default, so
 * the main threat is a malicious web page in the user's browser talking to
 * it. Browsers always send an Origin header on WebSocket handshakes and on
 * cross-origin requests; only the dashboard's own origins are accepted.
 * Requests without an Origin come from non-browser clients (curl, lair-node)
 * and are allowed.
 */
import { timingSafeEqual } from "crypto";
import type { IncomingMessage } from "http";

/** Port of the Lair API server (see src/server/index.ts). */
export const SERVER_PORT = 4777;
/** Port of the Vite dev server that serves the dashboard. */
export const DEV_CLIENT_PORT = 5173;

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** Origins the dashboard is served from: loopback (or LAIR_HOST) on the server or Vite port. */
export function allowedOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const hosts = new Set(LOOPBACK_HOSTS);
  const lairHost = env.LAIR_HOST?.trim();
  // A wildcard bind address is not an origin a browser can have
  if (lairHost && lairHost !== "0.0.0.0" && lairHost !== "::" && lairHost !== "[::]") {
    hosts.add(lairHost.includes(":") && !lairHost.startsWith("[") ? `[${lairHost}]` : lairHost);
  }
  const origins = new Set<string>();
  for (const host of hosts) {
    for (const port of [SERVER_PORT, DEV_CLIENT_PORT]) {
      origins.add(`http://${host.toLowerCase()}:${port}`);
    }
  }
  return origins;
}

/**
 * True if a request with this Origin header may talk to the server.
 * No Origin (a non-browser client) is allowed; "null" and foreign origins are not.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (origin === undefined || origin === "") return true;
  let normalized: string;
  try {
    normalized = new URL(origin).origin.toLowerCase();
  } catch {
    return false;
  }
  return allowedOrigins(env).has(normalized);
}

/** True if LAIR_HOST is a wildcard bind address (the server listens on every interface). */
function bindsAllInterfaces(env: NodeJS.ProcessEnv): boolean {
  const host = env.LAIR_HOST?.trim();
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

/**
 * True if the Host header names this server. Blocks DNS rebinding, where a
 * page on attacker.example re-resolves its own name to 127.0.0.1 and becomes
 * "same origin" with the API. Skipped when LAIR_HOST binds every interface.
 */
export function isAllowedHost(
  host: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (host === undefined || host === "" || bindsAllInterfaces(env)) return true;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  const allowed = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const lairHost = env.LAIR_HOST?.trim().toLowerCase();
  if (lairHost) {
    allowed.add(lairHost.includes(":") && !lairHost.startsWith("[") ? `[${lairHost}]` : lairHost);
  }
  return allowed.has(hostname);
}

/**
 * Fastify onRequest hook: refuse requests from foreign browser origins
 * (cross-site requests, including no-CORS "simple" POSTs that never get a
 * preflight) and requests whose Host isn't this server (DNS rebinding).
 */
export async function rejectCrossSiteRequests(
  request: { headers: IncomingMessage["headers"] },
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
): Promise<unknown> {
  const origin = request.headers.origin;
  if (!isAllowedOrigin(typeof origin === "string" ? origin : undefined)) {
    return reply.code(403).send({
      success: false,
      error: "Cross-origin request refused",
      timestamp: new Date().toISOString(),
    });
  }
  if (!isAllowedHost(request.headers.host)) {
    return reply.code(403).send({
      success: false,
      error: "Unexpected Host header",
      timestamp: new Date().toISOString(),
    });
  }
  return undefined;
}

/** True for 127.0.0.0/8 and ::1, including IPv4-mapped IPv6 forms. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const addr = address.startsWith("::ffff:") ? address.slice(7) : address;
  return addr === "::1" || /^127(\.\d{1,3}){3}$/.test(addr);
}

/** Constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** The token a node presented: `Authorization: Bearer <token>`, or `?token=` in the URL. */
export function presentedNodeToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }
  try {
    return new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * May this handshake join /ws/node? Loopback peers are always allowed.
 * Other peers are refused unless LAIR_NODE_TOKEN is set and they present it.
 */
export function isAllowedNodePeer(
  req: IncomingMessage,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isLoopbackAddress(req.socket.remoteAddress)) return true;
  const expected = env.LAIR_NODE_TOKEN;
  if (!expected) return false;
  const presented = presentedNodeToken(req);
  return presented !== undefined && safeEqual(presented, expected);
}
