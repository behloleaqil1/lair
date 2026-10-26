/**
 * The Decision Inbox wired the way src/server/index.ts wires it: the root
 * guards, mountDecisions() with a real WatchdogManager as producer, a real
 * port, and plain HTTP requests. Only the watchdog's system boundary (the
 * process table and the command runner) is fake, and, for the client helper
 * test, the browser: a fetch that adds what a browser adds (Origin,
 * Sec-Fetch-Site, its cookies).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { request as httpRequest, type IncomingHttpHeaders } from "http";
import type { AddressInfo } from "net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import type { ProjectConfig } from "../../shared/types.js";
import type { Decision } from "../../shared/decision-types.js";
import { registerRootGuards } from "../root-guards.js";
import { WatchdogManager } from "../watchdog/service.js";
import { NodeFileSystem, type CommandOutput } from "../watchdog/probes.js";
import { answerBody, answerSession, listDecisions, postAnswer, startAnswerSession } from "../../client/decisions-api";
import { dashboardUrlFor, maxOpenFromEnv, mountDecisions } from "./mount.js";
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
 * A browser on the dashboard (origin http://127.0.0.1:4777), as a fetch to the test server on `port`: it
 * resolves relative URLs, adds Origin to non-GET requests and
 * Sec-Fetch-Site: same-origin to all, and keeps the cookies it is sent.
 */
function browserFetch(port: number) {
  const origin = "http://127.0.0.1:4777";
  const jar = new Map<string, string>();
  return async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input), origin);
    const method = init.method ?? "GET";
    const headers: Record<string, string> = { ...((init.headers as Record<string, string> | undefined) ?? {}) };
    headers["sec-fetch-site"] = "same-origin";
    if (method !== "GET" && method !== "HEAD") headers.origin = origin;
    if (jar.size > 0 && init.credentials !== "omit") {
      headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    }
    const reply = await call(port, method, url.pathname + url.search, init.body as string | undefined, headers);
    const setCookie = reply.headers["set-cookie"] ?? [];
    for (const cookie of setCookie) {
      const [pair] = cookie.split(";");
      const eq = pair.indexOf("=");
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return new Response(reply.text, { status: reply.status, headers: { "content-type": "application/json" } });
  };
}

/** One project, watchdog in observe mode, with an orphaned claim and its release command configured. */
async function boot(options: { log?: string[] } = {}) {
  dir ??= mkdtempSync(join(tmpdir(), "lair-decisions-mount-"));
  const root = join(dir, "demo");
  mkdirSync(join(root, "agents"), { recursive: true });
  const claim = join(root, "agents", "worker-b.running");
  if (!existsSync(claim)) mkdirSync(claim);
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
      actions: { release_claim: ["./bin/release-claim", "{agent}", "{claim}"] },
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

  app = Fastify();
  registerRootGuards(app);
  const tokenPath = join(dir, "data", "decisions.answer-token");
  const inbox = await mountDecisions(app, {
    dbPath: join(dir, "data", "decisions.db"),
    answerTokenPath: tokenPath,
    dashboardUrl: "http://127.0.0.1:4777",
    defaultProject: () => "example",
    producers: [manager],
    sweepSeconds: 3600,
    log: (line) => options.log?.push(line),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  const answerToken = readFileSync(tokenPath, "utf-8").trim();
  return { inbox, manager, port, calls, claim, tokenPath, answerToken, inboxFile: config.inbox_file! };
}

describe("mountDecisions (the server's wiring)", () => {
  it("is what src/server/index.ts mounts, with the answer token and the watchdog as a producer", () => {
    const index = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf-8");
    expect(index).toContain('import { dashboardUrlFor, mountDecisions } from "./decisions/index.js";');
    expect(index).toMatch(
      /await mountDecisions\(fastify, \{\s*dbPath: join\(process\.cwd\(\), "data", "decisions\.db"\),\s*answerTokenPath: join\(process\.cwd\(\), "data", "decisions\.answer-token"\),[\s\S]*?producers: \[watchdogs\],\s*\}\);/,
    );
    // Mounted before the server starts the watchdogs, so no escalation goes elsewhere
    expect(index.indexOf("await mountDecisions(")).toBeLessThan(index.indexOf("watchdogs.start()"));
  });

  it("drives raise -> list -> answer -> producer resumed over HTTP", async () => {
    const { inbox, manager, port, calls, claim, answerToken, inboxFile } = await boot();
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

    // 3. A local process can't answer: no Origin and no session (403, still open, nothing runs)
    const answerPath = `/api/decisions/${decision.id}/answer`;
    const agent = await call(port, "POST", answerPath, { optionId: "run_playbook" });
    expect(agent.status).toBe(403);
    const forged = await call(port, "POST", answerPath, { optionId: "run_playbook" }, {
      origin: "http://localhost:4777",
      "sec-fetch-site": "same-origin",
    });
    expect(forged.status).toBe(403);
    await watchdog.tick();
    expect(calls).toEqual([]);
    expect(inbox.get(decision.id)?.status).toBe("open");

    // 4. The owner unlocks answering in the browser and answers over HTTP; the watchdog gets it right away
    const dashboard = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };
    const session = await call(port, "POST", "/api/decisions/session", { token: answerToken }, dashboard);
    expect(session.status).toBe(200);
    const cookie = String(session.headers["set-cookie"]).split(";")[0];
    const answered = await call(port, "POST", answerPath, { optionId: "run_playbook" }, { ...dashboard, cookie });
    expect(answered.status).toBe(200);
    expect(answered.body.data).toMatchObject({ status: "answered", answer: { optionId: "run_playbook" } });
    expect(answered.body.data.deliveredAt).toBeDefined();
    expect(answered.body.data.audit.map((a: { action: string }) => a.action)).toEqual([
      "raised",
      "answered",
      "delivered",
    ]);
    expect(answered.body.data.audit[1].detail).toContain("from 127.0.0.1");

    // 5. Resumed: the next tick runs the playbook once, and the breach recovers
    await watchdog.tick();
    expect(calls).toEqual([["./bin/release-claim", "worker-b", claim]]);
    expect(existsSync(claim)).toBe(false);
    expect(manager.getStore()!.listBreaches("demo")[0]).toMatchObject({ status: "resolved", resolution: "recovered" });
    await watchdog.tick();
    expect(calls).toHaveLength(1);
  });

  it("answers through the real client helpers, as the Decisions view does", async () => {
    const { inbox, port, answerToken } = await boot();
    vi.stubGlobal("fetch", browserFetch(port));

    // Any producer: raise over HTTP, resume through onResolved
    const resumed: DecisionResolution[] = [];
    inbox.onResolved("intake", (r) => {
      resumed.push(r);
    });
    const raised = await call(port, "POST", "/api/decisions?project=example", {
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
    });
    expect(raised.status).toBe(201);
    const id = raised.body.data.decision.id as string;
    expect(inbox.blockedOn("card:error-reports")?.id).toBe(id);

    const decision = (await listDecisions()).find((d: Decision) => d.id === id)!;
    const body = answerBody(decision, { optionId: "pay", note: "Within budget." });
    expect(body).toEqual({ optionId: "pay", note: "Within budget.", confirm: true });

    // Locked: the browser has no session yet
    expect(await answerSession()).toEqual({ answering: false });
    await expect(postAnswer(id, body)).rejects.toThrow("answering is not unlocked in this browser");
    await expect(startAnswerSession("not-the-token-at-all-not-the-token-at-all")).rejects.toThrow(
      "That is not the answer token",
    );

    // Unlocked with the token: the answer goes through and the producer resumes
    expect(await startAnswerSession(answerToken)).toEqual({ answering: true });
    expect(await answerSession()).toEqual({ answering: true });
    const answered = await postAnswer(id, body);
    expect(answered).toMatchObject({ status: "answered", answeredBy: "owner", answer: { optionId: "pay" } });
    expect(resumed.map((r) => [r.decision.id, r.optionId, r.note])).toEqual([[id, "pay", "Within budget."]]);
    expect(inbox.blockedOn("card:error-reports")).toBeNull();
  });

  it("creates the answer token once (mode 0600) and prints the setup link only then", async () => {
    const firstLog: string[] = [];
    const { tokenPath, answerToken } = await boot({ log: firstLog });
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(answerToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(firstLog.join("\n")).toContain(`http://127.0.0.1:4777/#answer-token=${answerToken}`);

    await manager!.stop();
    await app!.close();
    const secondLog: string[] = [];
    const again = await boot({ log: secondLog });
    expect(again.answerToken).toBe(answerToken);
    expect(secondLog.join("\n")).not.toContain(answerToken);
    expect(secondLog.join("\n")).toContain(tokenPath);
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

describe("mount helpers", () => {
  it("builds the dashboard URL for a bind address", () => {
    expect(dashboardUrlFor("127.0.0.1", 4777)).toBe("http://127.0.0.1:4777");
    expect(dashboardUrlFor("0.0.0.0", 4777)).toBe("http://localhost:4777");
    expect(dashboardUrlFor("::", 4777)).toBe("http://localhost:4777");
    expect(dashboardUrlFor("::1", 4777)).toBe("http://[::1]:4777");
  });

  it("reads LAIR_DECISIONS_MAX_OPEN as a positive whole number", () => {
    expect(maxOpenFromEnv({})).toBeUndefined();
    expect(maxOpenFromEnv({ LAIR_DECISIONS_MAX_OPEN: "20" })).toBe(20);
    expect(maxOpenFromEnv({ LAIR_DECISIONS_MAX_OPEN: "0" })).toBeUndefined();
    expect(maxOpenFromEnv({ LAIR_DECISIONS_MAX_OPEN: "lots" })).toBeUndefined();
  });
});
