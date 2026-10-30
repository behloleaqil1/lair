/**
 * The owner's credential: the token file, sessions (only their HMAC stored),
 * the request check, the owner routes behind the root guards, and CORS kept
 * off the owner-only paths with the real @fastify/cors.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerRootGuards } from "../root-guards.js";
import { HumanAuth, OWNER_SESSION_HEADER, dashboardRequestProblem, dashboardUrlFor } from "./human-auth.js";
import { registerOwnerRoutes } from "./routes.js";
import { OWNER_ONLY_PREFIXES, corsOptionsWithout, isUnder } from "./cors.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const DASHBOARD = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };

let dir: string | null = null;
const opened: HumanAuth[] = [];
let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
  for (const auth of opened.splice(0)) {
    try {
      auth.close();
    } catch {}
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function paths() {
  dir ??= mkdtempSync(join(tmpdir(), "lair-human-auth-"));
  return { tokenPath: join(dir, "data", "owner.token"), dbPath: join(dir, "data", "owner-sessions.db") };
}

function open(clock = { t: NOW, now: (): number => clock.t }) {
  const auth = HumanAuth.open({ ...paths(), clock });
  opened.push(auth);
  return { auth, clock, token: readFileSync(paths().tokenPath, "utf-8").trim() };
}

describe("HumanAuth", () => {
  it("creates the owner token once, mode 0600, and announces the setup link only then", () => {
    const lines: string[] = [];
    const first = open();
    expect(first.auth.created).toBe(true);
    expect(statSync(paths().tokenPath).mode & 0o777).toBe(0o600);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    first.auth.announce("http://127.0.0.1:4777", (line) => lines.push(line));
    expect(lines.join("\n")).toContain(`http://127.0.0.1:4777/#owner-token=${first.token}`);
    first.auth.close();
    opened.splice(0);

    const later: string[] = [];
    const second = open();
    expect(second.auth.created).toBe(false);
    expect(second.token).toBe(first.token);
    second.auth.announce("http://127.0.0.1:4777", (line) => later.push(line));
    expect(later.join("\n")).not.toContain(first.token);
    expect(later.join("\n")).toContain(paths().tokenPath);
  });

  it("returns a session value once and stores only its HMAC", () => {
    const { auth, token } = open();
    expect(auth.createSession("x".repeat(43), "Browser")).toBeNull();
    const created = auth.createSession(token, "ExampleBrowser/1.0")!;
    expect(created.session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.info).toMatchObject({ userAgent: "ExampleBrowser/1.0", createdAt: "2026-03-02T12:00:00.000Z" });
    expect(auth.findSession(created.session)).toEqual(created.info);
    expect(auth.findSession("y".repeat(43))).toBeNull();
    expect(auth.listSessions()).toEqual([created.info]);
    auth.close();
    opened.splice(0);
    for (const file of readdirSync(join(dir!, "data"))) {
      const bytes = readFileSync(join(dir!, "data", file));
      if (file === "owner.token") continue;
      expect(bytes.includes(Buffer.from(created.session))).toBe(false);
    }
  });

  it("verifies a request: dashboard Origin, same-origin, and a live session in the header, never a cookie", () => {
    const { auth, token, clock } = open();
    const { session, info } = auth.createSession(token, "ExampleBrowser/1.0")!;
    const withHeader = { ...DASHBOARD, [OWNER_SESSION_HEADER]: session };

    clock.t += 60_000;
    const ok = auth.verifyRequest(withHeader);
    expect(ok).toEqual({ ok: true, session: { ...info, lastUsedAt: "2026-03-02T12:01:00.000Z" } });
    expect(auth.listSessions()[0].lastUsedAt).toBe("2026-03-02T12:01:00.000Z");

    expect(auth.verifyRequest({ ...DASHBOARD, cookie: `lair_owner=${session}; session=${session}` })).toEqual({
      ok: false,
      reason: "this browser is not signed in as the owner",
    });
    expect(auth.verifyRequest({ [OWNER_SESSION_HEADER]: session })).toEqual({ ok: false, reason: "no Origin header" });
    expect(auth.verifyRequest({ ...withHeader, origin: "http://localhost:9999" })).toEqual({
      ok: false,
      reason: "not the dashboard's origin",
    });
    expect(auth.verifyRequest({ ...withHeader, "sec-fetch-site": "same-site" })).toEqual({
      ok: false,
      reason: "not a same-origin browser request",
    });
    expect(auth.verifyRequest({ ...DASHBOARD, [OWNER_SESSION_HEADER]: "z".repeat(43) }).ok).toBe(false);

    expect(auth.revoke(info.id)).toBe(true);
    expect(auth.verifyRequest(withHeader)).toMatchObject({ ok: false });
    expect(auth.revoke(info.id)).toBe(false);
  });

  it("keeps at most 20 sessions, dropping the least recently used", () => {
    const { auth, token, clock } = open();
    const first = auth.createSession(token)!;
    for (let i = 0; i < 20; i++) {
      clock.t += 1000;
      auth.createSession(token);
    }
    expect(auth.listSessions()).toHaveLength(20);
    expect(auth.findSession(first.session)).toBeNull();
  });

  it("signs every browser out when the token file is deleted (or replaced by one too short)", () => {
    const { auth, token } = open();
    const { session } = auth.createSession(token)!;
    auth.close();
    opened.splice(0);

    rmSync(paths().tokenPath);
    const fresh = open();
    expect(fresh.auth.created).toBe(true);
    expect(fresh.token).not.toBe(token);
    expect(fresh.auth.findSession(session)).toBeNull();
    expect(fresh.auth.listSessions()).toEqual([]);
    const again = fresh.auth.createSession(fresh.token)!;
    fresh.auth.close();
    opened.splice(0);

    writeFileSync(paths().tokenPath, "weak\n", { mode: 0o644 });
    const replaced = open();
    expect(replaced.auth.created).toBe(true);
    expect(replaced.auth.matchesToken("weak")).toBe(false);
    expect(statSync(paths().tokenPath).mode & 0o777).toBe(0o600);
    expect(replaced.auth.findSession(again.session)).toBeNull();
  });

  it("checks for a same-origin dashboard request", () => {
    expect(dashboardRequestProblem(DASHBOARD)).toBeNull();
    expect(dashboardRequestProblem({ origin: "http://127.0.0.1:5173", "sec-fetch-site": "same-origin" })).toBeNull();
    expect(dashboardRequestProblem({})).toBe("no Origin header");
    expect(dashboardRequestProblem({ origin: "null", "sec-fetch-site": "same-origin" })).toBe("an invalid Origin header");
    expect(dashboardRequestProblem({ origin: "http://localhost:3000", "sec-fetch-site": "same-origin" })).toBe(
      "not the dashboard's origin",
    );
    // Browsers without Sec-Fetch-* (Safari before 16.4) can't answer
    expect(dashboardRequestProblem({ origin: "http://localhost:4777" })).toBe("not a same-origin browser request");
    // A same-origin GET carries no Origin in browsers; Sec-Fetch-Site vouches for it, for reads only
    expect(dashboardRequestProblem({ "sec-fetch-site": "same-origin" }, { method: "GET" })).toBeNull();
    expect(dashboardRequestProblem({ "sec-fetch-site": "same-origin" }, { method: "POST" })).toBe("no Origin header");
    expect(dashboardRequestProblem({}, { method: "GET" })).toBe("no Origin header");
  });

  it("builds the dashboard URL for a bind address", () => {
    expect(dashboardUrlFor("127.0.0.1", 4777)).toBe("http://127.0.0.1:4777");
    expect(dashboardUrlFor("0.0.0.0", 4777)).toBe("http://localhost:4777");
    expect(dashboardUrlFor("::", 4777)).toBe("http://localhost:4777");
    expect(dashboardUrlFor("::1", 4777)).toBe("http://[::1]:4777");
  });
});

describe("owner routes", () => {
  async function build() {
    const { auth, token } = open();
    app = Fastify();
    registerRootGuards(app);
    await registerOwnerRoutes(app, auth);
    await app.ready();
    return { app, auth, token };
  }

  async function signIn(a: FastifyInstance, token: string, userAgent = "ExampleBrowser/1.0") {
    const res = await a.inject({
      method: "POST",
      url: "/api/owner/sessions",
      payload: { token },
      headers: { ...DASHBOARD, "user-agent": userAgent },
    });
    expect(res.statusCode).toBe(201);
    return res.json().data as { session: string; info: { id: string } };
  }

  it("signs a browser in from the dashboard only, returns the session once, and sets no cookie", async () => {
    const { app, token } = await build();
    const bare = await app.inject({ method: "POST", url: "/api/owner/sessions", payload: { token } });
    expect(bare.statusCode).toBe(403);
    const wrong = await app.inject({ method: "POST", url: "/api/owner/sessions", payload: { token: "x".repeat(43) }, headers: DASHBOARD });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.body).not.toContain(token);

    const res = await app.inject({ method: "POST", url: "/api/owner/sessions", payload: { token }, headers: DASHBOARD });
    expect(res.statusCode).toBe(201);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers["cache-control"]).toBe("no-store");
    const { session, info } = res.json().data;
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body).not.toContain(token);

    const status = await app.inject({ url: "/api/owner/session", headers: { [OWNER_SESSION_HEADER]: session } });
    expect(status.json().data).toMatchObject({ signedIn: true, session: { id: info.id } });
    expect((await app.inject({ url: "/api/owner/session" })).json().data).toEqual({ signedIn: false, session: null });
  });

  it("refuses an unauthorised request before reading its body", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/owner/sessions",
      payload: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(403);
    const revoke = await app.inject({
      method: "POST",
      url: "/api/owner/sessions/0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b/revoke",
      payload: "{not json",
      headers: { ...DASHBOARD, "content-type": "application/json" },
    });
    expect(revoke.statusCode).toBe(403);
  });

  it("lists and signs out browsers, only for a signed-in browser", async () => {
    const { app, token } = await build();
    const mine = await signIn(app, token, "ThisBrowser/1.0");
    const other = await signIn(app, token, "OtherBrowser/2.0");
    const me = { ...DASHBOARD, [OWNER_SESSION_HEADER]: mine.session };

    expect((await app.inject({ url: "/api/owner/sessions", headers: DASHBOARD })).statusCode).toBe(403);
    const list = await app.inject({ url: "/api/owner/sessions", headers: me });
    expect(list.statusCode).toBe(200);
    const sessions = list.json().data as { id: string; userAgent: string; current: boolean }[];
    expect(sessions.map((s) => [s.userAgent, s.current]).sort()).toEqual([
      ["OtherBrowser/2.0", false],
      ["ThisBrowser/1.0", true],
    ]);
    expect(JSON.stringify(sessions)).not.toContain(mine.session);

    const revoked = await app.inject({ method: "POST", url: `/api/owner/sessions/${other.info.id}/revoke`, headers: me });
    expect(revoked.json().data).toEqual({ revoked: other.info.id, current: false });
    const otherHeaders = { ...DASHBOARD, [OWNER_SESSION_HEADER]: other.session };
    expect((await app.inject({ url: "/api/owner/sessions", headers: otherHeaders })).statusCode).toBe(403);

    const self = await app.inject({ method: "POST", url: `/api/owner/sessions/${mine.info.id}/revoke`, headers: me });
    expect(self.json().data).toEqual({ revoked: mine.info.id, current: true });
    expect((await app.inject({ url: "/api/owner/sessions", headers: me })).statusCode).toBe(403);
  });
});

describe("CORS", () => {
  async function corsApp() {
    app = Fastify();
    await app.register(cors, corsOptionsWithout(["http://localhost:5173"], ["/api/owner", "/api/decisions"]));
    app.post("/api/decisions/:id/answer", async () => ({ ok: true }));
    app.post("/api/owner/sessions", async () => ({ ok: true }));
    app.get("/api/other", async () => ({ ok: true }));
    await app.ready();
    return app;
  }

  const preflight = (a: FastifyInstance, url: string) =>
    a.inject({
      method: "OPTIONS",
      url,
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
        "access-control-request-headers": OWNER_SESSION_HEADER,
      },
    });

  it("grants no preflight for owner-only paths, even to the dev server's origin", async () => {
    const a = await corsApp();
    for (const url of ["/api/decisions/0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b/answer", "/api/owner/sessions"]) {
      const res = await preflight(a, url);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      expect(res.headers["access-control-allow-headers"]).toBeUndefined();
    }
    const allowed = await preflight(a, "/api/other");
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("matches paths under a prefix only", () => {
    expect(isUnder("/api/decisions", ["/api/decisions"])).toBe(true);
    expect(isUnder("/api/decisions/x/answer?y=1", ["/api/decisions"])).toBe(true);
    expect(isUnder("/api/decisionsx", ["/api/decisions"])).toBe(false);
    expect(isUnder("/api/other", ["/api/decisions"])).toBe(false);
  });
});

describe("requireOwnerForChanges", () => {
  it("lets every read through and holds every write to the owner's session, before the handler runs", async () => {
    const { auth, token } = open();
    const { session } = auth.createSession(token)!;
    const ran: string[] = [];
    app = Fastify();
    await app.register(async (routes) => {
      routes.addHook("onRequest", auth.requireOwnerForChanges());
      routes.get("/api/module/state", async () => ({ ok: true }));
      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
        routes.route({
          method,
          url: "/api/module/state",
          handler: async () => {
            ran.push(method);
            return { ok: true };
          },
        });
      }
    });
    await app.ready();

    expect((await app.inject({ url: "/api/module/state" })).statusCode).toBe(200);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const refused = await app.inject({ method, url: "/api/module/state", headers: DASHBOARD });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error).toContain("this browser is not signed in as the owner");
    }
    expect(ran).toEqual([]);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const owner = await app.inject({ method, url: "/api/module/state", headers: { ...DASHBOARD, [OWNER_SESSION_HEADER]: session } });
      expect(owner.statusCode).toBe(200);
    }
    expect(ran).toEqual(["POST", "PUT", "PATCH", "DELETE"]);
  });

  it("keeps CORS off every prefix whose writes are the owner's, and on the bus's reads", () => {
    for (const path of [
      "/api/delivery/environments/local/up",
      "/api/controls/dragon/start",
      "/api/processes/api/start",
      "/api/settings",
      "/api/scheduler/start",
      "/api/tasks",
      "/api/fleet/machines",
      "/api/pipelines/runs",
      "/api/bus/send",
      "/api/lessons",
      "/api/lessons/L1",
    ]) {
      expect(isUnder(path, OWNER_ONLY_PREFIXES)).toBe(true);
    }
    expect(isUnder("/api/bus/events", OWNER_ONLY_PREFIXES)).toBe(false);
    expect(isUnder("/api/watchdog/status", OWNER_ONLY_PREFIXES)).toBe(false);
  });
});
