/**
 * The owner's Restart, mounted as src/server/index.ts mounts it: a real
 * HumanAuth, the real routes and controller, and real child processes for
 * server.update_cmd. Only the shutdown and process.exit are stand-ins.
 */
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HumanAuth, OWNER_SESSION_HEADER, registerOwnerRoutes } from "../human-auth/index.js";
import { signIn } from "../../client/owner-session";
import { requestRestart, restartQuestion, restartStatus } from "../../client/server-controls";
import { RestartController, parseServerConfig, registerRestartRoutes, serviceManagerOf } from "./index.js";

/** The dashboard in a browser, as requests carry it (no session yet) */
const BROWSER = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };
const NODE = process.execPath;
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };

interface Harness {
  dir: string;
  app: FastifyInstance;
  controller: RestartController;
  calls: string[];
  shutdown: Mock;
  exit: Mock;
  token: string;
  owner: Record<string, string>;
}

let harness: Harness | null = null;

afterEach(async () => {
  vi.unstubAllGlobals();
  if (harness) {
    await harness.app.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
  harness = null;
});

async function setup(server?: unknown, env: NodeJS.ProcessEnv = process.env): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "lair-restart-"));
  const configPath = join(dir, "server.yaml");
  // YAML is a superset of JSON
  if (server !== undefined) writeFileSync(configPath, JSON.stringify(server));
  const calls: string[] = [];
  const shutdown = vi.fn(async () => {
    calls.push("shutdown");
  });
  const exit = vi.fn((code: number) => {
    calls.push(`exit ${code}`);
  });
  const controller = new RestartController({ shutdown, exit, configPath, cwd: dir, env, platform: "linux", delayMs: 0, log: quiet });
  const app = Fastify({ logger: false });
  const tokenPath = join(dir, "owner.token");
  const auth = HumanAuth.open({ tokenPath, dbPath: ":memory:" });
  await registerOwnerRoutes(app, auth);
  await registerRestartRoutes(app, auth, controller);
  await app.ready();
  const token = readFileSync(tokenPath, "utf-8").trim();
  const owner = { ...BROWSER, [OWNER_SESSION_HEADER]: auth.createSession(token)!.session };
  harness = { dir, app, controller, calls, shutdown, exit, token, owner };
  return harness;
}

function post(h: Harness, payload: Record<string, unknown> | undefined, headers: Record<string, string>) {
  return h.app.inject({
    method: "POST",
    url: "/api/owner/restart",
    headers: payload === undefined ? headers : { ...headers, "content-type": "application/json" },
    payload,
  });
}

const step = (code: string) => [NODE, "-e", code];

describe("POST /api/owner/restart", () => {
  it("refuses (403) without the owner's session, and restarts nothing", async () => {
    const h = await setup();
    for (const headers of [BROWSER, { ...BROWSER, [OWNER_SESSION_HEADER]: "not-a-session" }]) {
      expect((await post(h, {}, headers)).statusCode).toBe(403);
      expect((await post(h, { update: true }, headers)).statusCode).toBe(403);
      expect((await h.app.inject({ url: "/api/owner/restart", headers })).statusCode).toBe(403);
    }
    await h.controller.settled();
    expect(h.shutdown).not.toHaveBeenCalled();
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.controller.status().state).toBe("idle");
  });

  it("answers 202, then runs the graceful shutdown and exits with code 0", async () => {
    const h = await setup();
    const res = await post(h, {}, h.owner);
    expect(res.statusCode).toBe(202);
    expect(res.json().data).toMatchObject({ state: "restarting", error: null });

    await h.controller.settled();
    expect(h.calls).toEqual(["shutdown", "exit 0"]);
    // One restart at a time
    expect((await post(h, {}, h.owner)).statusCode).toBe(409);
    expect(h.calls).toEqual(["shutdown", "exit 0"]);
  });

  it("exits with code 0 even when the shutdown fails", async () => {
    const h = await setup();
    h.shutdown.mockImplementationOnce(async () => {
      throw new Error("a store would not close");
    });
    expect((await post(h, {}, h.owner)).statusCode).toBe(202);
    await h.controller.settled();
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it("Update and restart: runs each update_cmd step, streams its output, then restarts", async () => {
    const h = await setup({
      server: { update_cmd: [step("console.log('pulled')"), step("console.log('built'); console.error('one warning')")] },
    });
    const res = await post(h, { update: true }, h.owner);
    expect(res.statusCode).toBe(202);
    expect(res.json().data.state).toBe("updating");

    await h.controller.settled();
    const { output, state, error } = h.controller.status();
    expect(state).toBe("restarting");
    expect(error).toBeNull();
    expect(output).toEqual(
      expect.arrayContaining([`$ ${NODE} -e console.log('pulled')`, "pulled", "built", "one warning", "Update finished: restarting"]),
    );
    expect(output.indexOf("pulled")).toBeLessThan(output.indexOf("built"));
    expect(h.calls).toEqual(["shutdown", "exit 0"]);
  });

  it("a failed update_cmd step stops the update: nothing restarts, and the error is shown", async () => {
    const marker = join(tmpdir(), `lair-restart-marker-${process.pid}-${Date.now()}`);
    const h = await setup({
      server: {
        update_cmd: [
          step("console.log('pulled')"),
          step("console.error('merge conflict in package.json'); process.exit(3)"),
          step(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`),
        ],
      },
    });
    expect((await post(h, { update: true }, h.owner)).statusCode).toBe(202);
    await h.controller.settled();

    expect(h.shutdown).not.toHaveBeenCalled();
    expect(h.exit).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
    const shown = (await h.app.inject({ url: "/api/owner/restart", headers: h.owner })).json().data;
    expect(shown.state).toBe("failed");
    expect(shown.error).toBe(`Update step 2 of 3 (${NODE}) exited with code 3: Lair was not restarted`);
    expect(shown.output).toContain("merge conflict in package.json");

    // After a failed update the owner may still restart, or try again
    expect((await post(h, {}, h.owner)).statusCode).toBe(202);
    await h.controller.settled();
    expect(h.calls).toEqual(["shutdown", "exit 0"]);
  });

  it("a command that can't start fails the update the same way", async () => {
    const h = await setup({ server: { update_cmd: [join(tmpdir(), "lair-no-such-command")] } });
    expect((await post(h, { update: true }, h.owner)).statusCode).toBe(202);
    await h.controller.settled();
    expect(h.controller.status()).toMatchObject({ state: "failed" });
    expect(h.controller.status().error).toContain("could not start");
    expect(h.exit).not.toHaveBeenCalled();
  });

  it("refuses an update without server.update_cmd, an invalid server config and an unknown body (400)", async () => {
    const none = await setup();
    const res = await post(none, { update: true }, none.owner);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("no server.update_cmd in server.yaml");
    expect((await post(none, { update: "yes" }, none.owner)).statusCode).toBe(400);
    expect((await post(none, { now: true }, none.owner)).statusCode).toBe(400);
    await none.controller.settled();
    expect(none.calls).toEqual([]);
    await none.app.close();
    rmSync(none.dir, { recursive: true, force: true });

    const invalid = await setup({ server: { update_cmd: "git pull && npm run build" } });
    const refused = await post(invalid, { update: true }, invalid.owner);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toContain("server.yaml has an error");
    expect(invalid.controller.status().configError).toContain("server.update_cmd");
    expect(invalid.calls).toEqual([]);
  });

  it("runs the update without Lair's own variables", async () => {
    const h = await setup(
      { server: { update_cmd: [step("console.log(String(process.env.LAIR_GITHUB_TOKEN), process.env.KEEP_ME)")] } },
      { ...process.env, LAIR_GITHUB_TOKEN: "s3cret", KEEP_ME: "kept" },
    );
    await post(h, { update: true }, h.owner);
    await h.controller.settled();
    expect(h.controller.status().output).toContain("undefined kept");
    expect(h.controller.status().output.join("\n")).not.toContain("s3cret");
  });

  it("the dashboard's helpers send the same requests (owner only)", async () => {
    const h = await setup({ server: { update_cmd: [step("console.log('ok')")], service_manager: "systemd" } });
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, String(value)),
      removeItem: (key: string) => void values.delete(key),
    });
    vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
      const res = await h.app.inject({
        method: (init.method ?? "GET") as "GET" | "POST",
        url: input,
        headers: { ...(init.headers as Record<string, string> | undefined), ...BROWSER },
        payload: typeof init.body === "string" ? init.body : undefined,
      });
      return { status: res.statusCode, json: async () => res.json() };
    });
    await signIn(h.token);
    const status = await restartStatus();
    expect(status).toMatchObject({ state: "idle", update: { configured: true }, serviceManager: { name: "systemd", source: "configured" } });
    expect(restartQuestion(true, status)).toContain(`Update Lair (${NODE} -e console.log('ok')) and then restart it?`);
    const answer = await requestRestart(true);
    expect(answer).toMatchObject({ success: true, data: { state: "updating" } });
    await h.controller.settled();
    expect(h.calls).toEqual(["shutdown", "exit 0"]);
  });
});

describe("server config", () => {
  it("reads one argv as one step, and a list of argvs as steps", () => {
    expect(parseServerConfig({ server: { update_cmd: ["./scripts/update.sh"] } })).toMatchObject({
      ok: true,
      settings: { updateSteps: [["./scripts/update.sh"]], updateTimeoutSeconds: 900, serviceManager: null },
    });
    expect(parseServerConfig({ server: { update_cmd: [["git", "pull", "--ff-only"], ["npm", "ci"]] } })).toMatchObject({
      ok: true,
      settings: { updateSteps: [["git", "pull", "--ff-only"], ["npm", "ci"]] },
    });
    expect(parseServerConfig(null)).toMatchObject({ ok: true, settings: { updateSteps: [] } });
  });

  it("refuses shell strings, options as the command and unknown keys", () => {
    expect(parseServerConfig({ server: { update_cmd: "git pull && npm ci" } }).ok).toBe(false);
    expect(parseServerConfig({ server: { update_cmd: ["--version"] } }).ok).toBe(false);
    expect(parseServerConfig({ server: { update_command: ["git"] } }).ok).toBe(false);
    expect(parseServerConfig({ server: { service_manager: "upstart" } }).ok).toBe(false);
  });
});

describe("serviceManagerOf", () => {
  it("prefers server.service_manager", () => {
    expect(serviceManagerOf("launchd", {}, "linux")).toMatchObject({ name: "launchd", source: "configured" });
    expect(serviceManagerOf("none", { INVOCATION_ID: "abc" }, "linux")).toMatchObject({ name: null, source: "configured" });
  });

  it("detects systemd and launchd from their environment", () => {
    expect(serviceManagerOf(null, { INVOCATION_ID: "abc" }, "linux")).toMatchObject({ name: "systemd", source: "detected" });
    expect(serviceManagerOf(null, { XPC_SERVICE_NAME: "dev.lair.server" }, "darwin")).toMatchObject({
      name: "launchd",
      source: "detected",
    });
  });

  it("says when it can't tell", () => {
    for (const env of [{}, { XPC_SERVICE_NAME: "0" }, { XPC_SERVICE_NAME: "application.com.apple.Terminal.1" }]) {
      const view = serviceManagerOf(null, env, "darwin");
      expect(view).toMatchObject({ name: null, source: "unknown" });
      expect(view.note).toContain("can't tell");
    }
    expect(serviceManagerOf(null, { XPC_SERVICE_NAME: "dev.lair.server" }, "linux").source).toBe("unknown");
  });
});
