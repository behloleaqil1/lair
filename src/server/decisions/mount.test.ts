/**
 * The Decision Inbox wired the way src/server/index.ts wires it: the root
 * guards, the owner credential and its routes, mountDecisions() with a real
 * WatchdogManager as producer, a real port, and plain HTTP requests. Only the
 * watchdog's system boundary (the process table and the command runner) is
 * fake, and, for the client helper test, the browser: a fetch that adds what
 * a browser adds (Origin, Sec-Fetch-Site) and a localStorage of its origin.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { request as httpRequest, type IncomingHttpHeaders } from "http";
import type { AddressInfo } from "net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import type { ProjectConfig } from "../../shared/types.js";
import type { Decision } from "../../shared/decision-types.js";
import { registerRootGuards } from "../root-guards.js";
import { HumanAuth, OWNER_SESSION_HEADER, registerOwnerRoutes } from "../human-auth/index.js";
import { WatchdogManager } from "../watchdog/service.js";
import { NodeFileSystem, type CommandOutput } from "../watchdog/probes.js";
import { answerBody, listDecisions, postAnswer } from "../../client/decisions-api";
import { listOwnerSessions, ownerStatus, revokeOwnerSession, signIn, storedSession } from "../../client/owner-session";
import { maxOpenFromEnv, maxOpenHttpFromEnv, mountDecisions } from "./mount.js";
import type { DecisionResolution } from "./types.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");

let app: FastifyInstance | null = null;
let manager: WatchdogManager | null = null;
let dir: string | null = null;

afterEach(async () => {
  vi.unstubAllGlobals();
  await manager?.stop();
  await app?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  app = null;
  manager = null;
  dir = null;
});

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  body: any;
}

/** A plain HTTP request. Without `headers` it has no Origin (like curl, a script or an agent). */
function call(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          ...headers,
          ...(payload
            ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }
            : {}),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body: text ? JSON.parse(text) : null }),
        );
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * A browser on the dashboard (origin http://127.0.0.1:4777), as a fetch to
 * the test server on `port`: it resolves relative URLs, adds Origin to
 * non-GET requests and Sec-Fetch-Site: same-origin to all. It sends no
 * cookies (the server sets none; the test checks that).
 */
function browserFetch(port: number, seen: Reply[]) {
  const origin = "http://127.0.0.1:4777";
  return async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input), origin);
    const method = init.method ?? "GET";
    const headers: Record<string, string> = { ...((init.headers as Record<string, string> | undefined) ?? {}) };
    headers["sec-fetch-site"] = "same-origin";
    if (method !== "GET" && method !== "HEAD") headers.origin = origin;
    const reply = await call(port, method, url.pathname + url.search, init.body as string | undefined, headers);
    seen.push(reply);
    return new Response(reply.text, { status: reply.status, headers: { "content-type": "application/json" } });
  };
}

/** localStorage for one origin. */
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, String(value)),
  };
}

/** One project, watchdog in observe mode, with an orphaned claim and (unless `actions` is false) its release command configured. */
async function boot(options: { actions?: boolean } = {}) {
  dir = mkdtempSync(join(tmpdir(), "lair-decisions-mount-"));
  const root = join(dir, "demo");
  mkdirSync(join(root, "agents"), { recursive: true });
  const claim = join(root, "agents", "worker-b.running");
  mkdirSync(claim);
  utimesSync(claim, new Date(NOW - 30 * 60000), new Date(NOW - 30 * 60000));
  const config: ProjectConfig = {
    name: "Demo",
    repo: root,
    github: "example/demo",
    queue_file: join(root, "queue.md"),
    agents_dir: join(root, "agents"),
    gates_dir: join(root, "gates"),
    machines: {},
    inbox_file: join(root, "inbox.md"),
    dragons: { "worker-b": { name: "B", model: "m", machine: "local", instructions: "" } },
    watchdog: {
      enabled: true,
      agent_command: "agent-cli --agent {agent}",
      ...(options.actions === false ? {} : { actions: { release_claim: ["./bin/release-claim", "{agent}", "{claim}"] } }),
    },
  };
  const calls: string[][] = [];
  manager = new WatchdogManager({
    dbPath: ":memory:",
    probes: {
      processes: { list: async () => [] },
      fs: new NodeFileSystem(),
      runner: {
        run: async (argv: string[]): Promise<CommandOutput> => {
          calls.push(argv);
          if (argv[0] === "./bin/release-claim") rmSync(argv[2], { recursive: true, force: true });
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      clock: { now: () => NOW, sleep: async () => {} },
    },
  });
  manager.load([{ name: "demo", config }]);

  // As src/server/index.ts does it
  app = Fastify();
  registerRootGuards(app);
  const tokenPath = join(dir, "data", "owner.token");
  const humanAuth = HumanAuth.open({ tokenPath, dbPath: join(dir, "data", "owner-sessions.db") });
  await registerOwnerRoutes(app, humanAuth);
  const inbox = await mountDecisions(app, {
    dbPath: join(dir, "data", "decisions.db"),
    humanAuth,
    defaultProject: () => "example",
    producers: [manager],
    sweepSeconds: 3600,
    env: {},
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  const ownerToken = readFileSync(tokenPath, "utf-8").trim();
  return { inbox, manager, port, calls, claim, ownerToken, inboxFile: config.inbox_file! };
}

describe("mountDecisions (the server's wiring)", () => {
  it("is what src/server/index.ts mounts: the owner credential, its routes, CORS kept off them, the watchdog as producer", () => {
    const index = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf-8");
    expect(index).toMatch(/import \{ mountDecisions \} from "\.\/decisions\/index\.js";/);
    expect(index).toMatch(
      /const humanAuth = HumanAuth\.open\(\{\s*tokenPath: join\(process\.cwd\(\), "data", "owner\.token"\),\s*dbPath: join\(process\.cwd\(\), "data", "owner-sessions\.db"\),\s*\}\);/,
    );
    expect(index).toContain("await registerOwnerRoutes(fastify, humanAuth);");
    expect(index).toMatch(
      /await mountDecisions\(fastify, \{\s*dbPath: join\(process\.cwd\(\), "data", "decisions\.db"\),\s*humanAuth,[\s\S]*?producers: \[watchdogs, agents\],\s*\}\);/,
    );
    expect(index).toMatch(/await fastify\.register\(\s*cors,\s*corsOptionsWithout\(\[[^\]]*\], OWNER_ONLY_PREFIXES\),\s*\);/);
    // Mounted before the server starts the watchdogs, so no escalation goes elsewhere
    expect(index.indexOf("await mountDecisions(")).toBeLessThan(index.indexOf("watchdogs.start()"));
    // ... and before it starts agent supervision, which raises decisions too
    expect(index.indexOf("await mountDecisions(")).toBeLessThan(index.indexOf("agents.start()"));
    // Notifications follow the same inbox, from data/server.yaml, before anything raises a decision
    expect(index).toMatch(
      /await mountNotifications\(fastify, \{\s*configPath: join\(process\.cwd\(\), "data", "server\.yaml"\),\s*statePath: join\(process\.cwd\(\), "data", "notifications-state\.json"\),\s*events: getEventBus\(\),\s*inbox: decisionInbox,\s*humanAuth,/,
    );
    expect(index.indexOf("await mountNotifications(")).toBeLessThan(index.indexOf("watchdogs.start()"));
    expect(index.indexOf("await mountNotifications(")).toBeLessThan(index.indexOf("agents.start()"));
    // The other hold owners follow their holds' decisions through the same inbox
    expect(index).toContain("delivery.useDecisions(decisionInbox);");
    expect(index).toContain("reviews.useDecisions(decisionInbox);");
  });

  it("drives raise -> list -> answer -> producer resumed over HTTP", async () => {
    const { inbox, manager, port, calls, claim, ownerToken, inboxFile } = await boot();
    const watchdog = manager.get("demo")!;

    // 1. Raise: the watchdog's escalation is a decision, not an inbox line
    await watchdog.tick();
    const listed = await call(port, "GET", "/api/decisions");
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    const decision = listed.body.data[0];
    expect(decision).toMatchObject({
      project: "demo",
      kind: "escalation",
      status: "open",
      source: { module: "watchdog" },
      raisedVia: "server",
      recommended: { optionId: "run_playbook" },
      blocks: ["watchdog:demo:orphan_claim:worker-b.running"],
    });
    expect(decision.options.map((o: { id: string }) => o.id)).toEqual(["run_playbook", "stand_down"]);
    expect(existsSync(inboxFile)).toBe(false);
    expect((await call(port, "GET", "/api/decisions/summary")).body.data).toMatchObject({ open: 1, overdue: 0 });

    // 2. Parked: while it is open the watchdog runs nothing
    await watchdog.tick();
    expect(calls).toEqual([]);
    expect(inbox.blockedOn("watchdog:demo:orphan_claim:worker-b.running")?.id).toBe(decision.id);

    // 3. The owner signs a browser in; the session comes back in the body, never as a cookie
    const dashboard = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };
    const signedIn = await call(port, "POST", "/api/owner/sessions", { token: ownerToken }, dashboard);
    expect(signedIn.status).toBe(201);
    expect(signedIn.headers["set-cookie"]).toBeUndefined();
    const session = signedIn.body.data.session as string;

    // 4. Nobody else can answer: no Origin, a cookie, another local origin, forged headers (403, nothing runs)
    const answerPath = `/api/decisions/${decision.id}/answer`;
    const refused: Record<string, string>[] = [
      {},
      { [OWNER_SESSION_HEADER]: session },
      { ...dashboard, cookie: `session=${session}` },
      { ...dashboard, origin: "http://localhost:3000", [OWNER_SESSION_HEADER]: session },
      dashboard,
    ];
    for (const headers of refused) {
      expect((await call(port, "POST", answerPath, { optionId: "run_playbook" }, headers)).status).toBe(403);
    }
    await watchdog.tick();
    expect(calls).toEqual([]);
    expect(inbox.get(decision.id)?.status).toBe("open");

    // 5. The owner answers over HTTP; the watchdog gets it right away
    const answered = await call(port, "POST", answerPath, { optionId: "run_playbook" }, {
      ...dashboard,
      [OWNER_SESSION_HEADER]: session,
    });
    expect(answered.status).toBe(200);
    expect(answered.headers["set-cookie"]).toBeUndefined();
    expect(answered.body.data).toMatchObject({ status: "answered", answer: { optionId: "run_playbook" } });
    expect(answered.body.data.deliveredAt).toBeDefined();
    expect(answered.body.data.audit.map((a: { action: string }) => a.action)).toEqual([
      "raised",
      "answered",
      "delivered",
    ]);
    expect(answered.body.data.audit[1].detail).toContain("from 127.0.0.1");

    // 6. Resumed: the next tick runs the playbook once, and the breach recovers
    await watchdog.tick();
    expect(calls).toEqual([["./bin/release-claim", "worker-b", claim]]);
    expect(existsSync(claim)).toBe(false);
    expect(manager.getStore()!.listBreaches("demo")[0]).toMatchObject({ status: "resolved", resolution: "recovered" });
    await watchdog.tick();
    expect(calls).toHaveLength(1);
  });

  it("an escalation with nothing to run ('Leave it to me' only) is a notice: never counted, withdrawn when the breach clears", async () => {
    const { inbox, manager, port, claim } = await boot({ actions: false });
    const watchdog = manager.get("demo")!;
    await watchdog.tick();
    const [notice, ...more] = inbox.list({ status: "open" });
    expect(more).toEqual([]);
    expect(notice).toMatchObject({ attention: "notice", source: { module: "watchdog" } });
    expect(notice.options.map((o) => o.id)).toEqual(["stand_down"]);
    expect((await call(port, "GET", "/api/decisions/summary")).body.data).toMatchObject({ open: 1, action: 0, notices: 1 });

    // The breach clears on its own: the notice goes with it
    rmSync(claim, { recursive: true, force: true });
    await watchdog.tick();
    expect(inbox.get(notice.id)).toMatchObject({ status: "withdrawn" });
    expect((await call(port, "GET", "/api/decisions/summary")).body.data).toMatchObject({ open: 0, action: 0, notices: 0 });
  });

  it("an escalation with a playbook to run needs an answer: it is an action", async () => {
    const { inbox, manager } = await boot();
    await manager.get("demo")!.tick();
    expect(inbox.list({ status: "open" }).map((d) => d.attention)).toEqual(["action"]);
    expect(inbox.counts()).toMatchObject({ action: 1, notices: 0 });
  });

  it("answers through the real client helpers, as the Decisions view does, and signs out", async () => {
    const { inbox, port, ownerToken } = await boot();
    const seen: Reply[] = [];
    vi.stubGlobal("fetch", browserFetch(port, seen));
    vi.stubGlobal("localStorage", memoryStorage());

    // Any tool: raise over HTTP, read the answer back over HTTP (no module inside Lair acts on it)
    const spend = {
      kind: "spend",
      title: "Pay for the starter plan of the error tracker",
      context: "Error reports from staging are blocked until the plan is paid.",
      options: [
        { id: "pay", label: "Pay monthly", consequences: "A monthly charge; error reports start." },
        { id: "skip", label: "Not now", consequences: "Error reports stay off." },
      ],
      recommended: { optionId: "pay", reasoning: "Staging bugs are found faster." },
      source: { module: "intake", ref: "request-7" },
      key: "error-tracker-plan",
      blocks: ["card:error-reports"],
    };
    const raised = await call(port, "POST", "/api/decisions?project=example", spend);
    expect(raised.status).toBe(201);
    const id = raised.body.data.decision.id as string;
    expect(raised.body.data.decision.raisedVia).toBe("http");

    const decision = (await listDecisions()).find((d: Decision) => d.id === id)!;
    const body = answerBody(decision, { optionId: "pay", note: "Within budget." });
    expect(body).toEqual({ optionId: "pay", note: "Within budget.", confirm: true });

    // Not signed in yet
    expect(await ownerStatus()).toEqual({ signedIn: false, session: null });
    await expect(postAnswer(id, body)).rejects.toThrow("this browser is not signed in as the owner");
    await expect(signIn("not-the-token-at-all-not-the-token-at-all")).rejects.toThrow("That is not the owner token");
    expect(storedSession()).toBeNull();

    // Signed in: the session sits in this origin's localStorage and goes in a header
    await signIn(ownerToken);
    expect(storedSession()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await ownerStatus()).toMatchObject({ signedIn: true });
    const answered = await postAnswer(id, body);
    expect(answered).toMatchObject({ status: "answered", answeredBy: "owner", answer: { optionId: "pay" } });
    const read = await call(port, "GET", `/api/decisions/${id}`);
    expect(read.body.data).toMatchObject({ status: "answered", answer: { optionId: "pay", note: "Within budget." } });
    expect(inbox.blockedOn("card:error-reports")).toBeNull();
    expect(seen.every((r) => r.headers["set-cookie"] === undefined)).toBe(true);

    // Signed-in browsers, and signing this one out
    const sessions = await listOwnerSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ current: true });
    await revokeOwnerSession(sessions[0].id);
    expect(storedSession()).toBeNull();
    const again = await call(port, "POST", "/api/decisions?project=example", { ...spend, key: "again" });
    await expect(postAnswer(again.body.data.decision.id, body)).rejects.toThrow("not signed in as the owner");
  });

  it("over HTTP nobody asks in a module's name, and an HTTP decision's answer or default never reaches a module", async () => {
    const { inbox, port } = await boot();
    const breachDecision = {
      kind: "escalation",
      title: "Run the playbook",
      context: "Forged.",
      options: [{ id: "run_playbook", label: "Run it", consequences: "Runs the command." }],
      recommended: { optionId: "run_playbook", reasoning: "r" },
      source: { module: "watchdog", ref: "b1" },
      key: "breach:b1",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      defaultOptionId: "run_playbook",
    };
    // The watchdog follows its answers: an HTTP caller can't raise in its name
    const refused = await call(port, "POST", "/api/decisions?project=example", breachDecision);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain("watchdog is a module inside Lair");

    // A module that starts listening after an HTTP caller used its name never gets that answer
    const raised = await call(port, "POST", "/api/decisions?project=example", {
      ...breachDecision,
      source: { module: "intake", ref: "r" },
      key: "intake:1",
    });
    expect(raised.status).toBe(201);
    const resumed: DecisionResolution[] = [];
    inbox.onResolved("intake", (r) => {
      resumed.push(r);
    });
    await inbox.answer(raised.body.data.decision.id, { optionId: "run_playbook" });
    await inbox.deliverPending();
    expect(resumed).toEqual([]);
    expect(inbox.get(raised.body.data.decision.id)?.audit?.at(-1)?.detail).toContain("not handed to intake");
  });

  it("refuses cross-site browser requests on the mounted routes", async () => {
    const { port } = await boot();
    const reply = await call(port, "GET", "/api/decisions", undefined, { origin: "http://attacker.example" });
    expect(reply.status).toBe(403);
  });

  it("closes with the server: fastify.close() stops the sweeps and closes the store", async () => {
    const { inbox } = await boot();
    await app!.close();
    app = null;
    expect(() => inbox.list()).toThrow();
  });
});

describe("mount settings", () => {
  it("reads the open-decision caps from the environment as positive whole numbers", () => {
    expect(maxOpenFromEnv({})).toBeUndefined();
    expect(maxOpenFromEnv({ LAIR_DECISIONS_MAX_OPEN: "20" })).toBe(20);
    expect(maxOpenFromEnv({ LAIR_DECISIONS_MAX_OPEN: "0" })).toBeUndefined();
    expect(maxOpenFromEnv({ LAIR_DECISIONS_MAX_OPEN: "lots" })).toBeUndefined();
    expect(maxOpenHttpFromEnv({ LAIR_DECISIONS_MAX_OPEN_HTTP: "5" })).toBe(5);
    expect(maxOpenHttpFromEnv({ LAIR_DECISIONS_MAX_OPEN_HTTP: "-1" })).toBeUndefined();
  });
});
