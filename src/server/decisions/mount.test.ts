/**
 * The Decision Inbox wired the way src/server/index.ts wires it: the root
 * guards, mountDecisions() with a real WatchdogManager as producer, a real
 * port, and plain HTTP requests. Only the watchdog's system boundary (the
 * process table and the command runner) is fake.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { request as httpRequest } from "http";
import type { AddressInfo } from "net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import type { ProjectConfig } from "../../shared/types.js";
import { registerRootGuards } from "../root-guards.js";
import { WatchdogManager } from "../watchdog/service.js";
import { NodeFileSystem, type CommandOutput } from "../watchdog/probes.js";
import { mountDecisions } from "./mount.js";
import type { DecisionResolution } from "./types.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");

let app: FastifyInstance | null = null;
let manager: WatchdogManager | null = null;
let dir: string | null = null;

afterEach(async () => {
  await manager?.stop();
  await app?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  app = null;
  manager = null;
  dir = null;
});

interface Reply {
  status: number;
  text: string;
  body: any;
}

/** A plain HTTP request, with no Origin header (like curl or another local tool). */
function call(port: number, method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: payload
          ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }
          : {},
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text, body: text ? JSON.parse(text) : null }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** One project, watchdog in observe mode, with an orphaned claim and its release command configured. */
async function boot() {
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
  const inbox = await mountDecisions(app, {
    dbPath: join(dir, "data", "decisions.db"),
    defaultProject: () => "example",
    producers: [manager],
    sweepSeconds: 3600,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  return { inbox, manager, port, calls, claim, inboxFile: config.inbox_file! };
}

describe("mountDecisions (the server's wiring)", () => {
  it("is what src/server/index.ts mounts, with the watchdog as a producer", () => {
    const index = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf-8");
    expect(index).toContain('import { mountDecisions } from "./decisions/index.js";');
    expect(index).toMatch(
      /await mountDecisions\(fastify, \{\s*dbPath: join\(process\.cwd\(\), "data", "decisions\.db"\),[\s\S]*?producers: \[watchdogs\],\s*\}\);/,
    );
    // Mounted before the server starts the watchdogs, so no escalation goes elsewhere
    expect(index.indexOf("await mountDecisions(")).toBeLessThan(index.indexOf("watchdogs.start()"));
  });

  it("drives raise -> list -> answer -> producer resumed over HTTP", async () => {
    const { inbox, manager, port, calls, claim, inboxFile } = await boot();
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

    // 3. Answer over HTTP: delivered to the watchdog right away
    const answered = await call(port, "POST", `/api/decisions/${decision.id}/answer`, { optionId: "run_playbook" });
    expect(answered.status).toBe(200);
    expect(answered.body.data).toMatchObject({ status: "answered", answer: { optionId: "run_playbook" } });
    expect(answered.body.data.deliveredAt).toBeDefined();
    expect(answered.body.data.audit.map((a: { action: string }) => a.action)).toEqual([
      "raised",
      "answered",
      "delivered",
    ]);

    // 4. Resumed: the next tick runs the playbook once, and the breach recovers
    await watchdog.tick();
    expect(calls).toEqual([["./bin/release-claim", "worker-b", claim]]);
    expect(existsSync(claim)).toBe(false);
    expect(manager.getStore()!.listBreaches("demo")[0]).toMatchObject({ status: "resolved", resolution: "recovered" });
    await watchdog.tick();
    expect(calls).toHaveLength(1);

    // Any other producer: raise over HTTP, resume through onResolved
    const resumed: DecisionResolution[] = [];
    inbox.onResolved("intake", (r) => {
      resumed.push(r);
    });
    const raised = await call(port, "POST", "/api/decisions?project=example", {
      kind: "pricing",
      title: "Price of the starter plan",
      context: "The pricing page is blocked until the starter plan has a price.",
      options: [
        { id: "low", label: "9 per month", consequences: "More sign-ups, less revenue per user." },
        { id: "high", label: "19 per month", consequences: "Fewer sign-ups, more revenue per user." },
      ],
      recommended: { optionId: "low", reasoning: "Similar tools start low." },
      source: { module: "intake", ref: "request-7" },
      key: "starter-price",
      blocks: ["card:pricing-page"],
    });
    expect(raised.status).toBe(201);
    const priceId = raised.body.data.decision.id;
    expect(inbox.blockedOn("card:pricing-page")?.id).toBe(priceId);

    const all = await call(port, "GET", "/api/decisions");
    expect(all.body.data.map((d: { id: string }) => d.id)).toEqual([priceId, decision.id]);

    const priced = await call(port, "POST", `/api/decisions/${priceId}/answer`, { optionId: "high", note: "Niche." });
    expect(priced.status).toBe(200);
    expect(resumed.map((r) => [r.decision.id, r.optionId, r.note])).toEqual([[priceId, "high", "Niche."]]);
    expect(inbox.blockedOn("card:pricing-page")).toBeNull();
  });

  it("refuses cross-site browser requests on the mounted routes", async () => {
    const { port } = await boot();
    const reply = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, method: "GET", path: "/api/decisions", headers: { origin: "http://attacker.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(reply).toBe(403);
  });

  it("closes with the server: fastify.close() stops the sweeps and closes the store", async () => {
    const { inbox } = await boot();
    await app!.close();
    app = null;
    expect(() => inbox.list()).toThrow();
  });
});
