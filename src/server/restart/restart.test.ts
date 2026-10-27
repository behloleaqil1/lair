/**
 * The owner's Restart, mounted as src/server/index.ts mounts it: a real
 * HumanAuth, the real routes and controller, and real child processes for
 * server.update_cmd. Only the shutdown and process.exit are stand-ins.
 */
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { execFileSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import { HumanAuth, OWNER_SESSION_HEADER, registerOwnerRoutes } from "../human-auth/index.js";
import { signIn } from "../../client/owner-session";
import { requestRestart, restartQuestion, restartStatus } from "../../client/server-controls";
import {
  RestartController,
  configuredTokenEnvs,
  loadServerConfig,
  parseServerConfig,
  registerRestartRoutes,
  serviceManagerOf,
  type RestartControllerOptions,
} from "./index.js";

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

async function setup(server?: unknown, extra: Partial<RestartControllerOptions> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "lair-restart-"));
  const configPath = join(dir, "server.yaml");
  // YAML is a superset of JSON; the file must be the owner's and not group/other-writable
  if (server !== undefined) {
    writeFileSync(configPath, JSON.stringify(server));
    chmodSync(configPath, 0o600);
  }
  const calls: string[] = [];
  const shutdown = vi.fn(async () => {
    calls.push("shutdown");
  });
  const exit = vi.fn((code: number) => {
    calls.push(`exit ${code}`);
  });
  const controller = new RestartController({
    shutdown,
    exit,
    configPath,
    cwd: dir,
    env: process.env,
    platform: "linux",
    delayMs: 0,
    log: quiet,
    ...extra,
  });
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

  it("runs the update without Lair's own variables and without the projects' token variables", async () => {
    const h = await setup(
      {
        server: {
          update_cmd: [
            step("console.log(String(process.env.LAIR_GITHUB_TOKEN), String(process.env.REVIEW_TOKEN), process.env.KEEP_ME)"),
          ],
        },
      },
      {
        env: { ...process.env, LAIR_GITHUB_TOKEN: "s3cret", REVIEW_TOKEN: "s3cret-too", KEEP_ME: "kept" },
        secretEnv: () => ["REVIEW_TOKEN"],
      },
    );
    await post(h, { update: true }, h.owner);
    await h.controller.settled();
    expect(h.controller.status().output).toContain("undefined undefined kept");
    expect(h.controller.status().output.join("\n")).not.toContain("s3cret");
  });

  it("answers 409 while a merge or a delivery operation runs, and restarts nothing", async () => {
    let busy = ["a merge in shop", "deploy of shop/local (since 2026-03-02T12:00:00.000Z)"];
    const h = await setup({ server: { update_cmd: [step("console.log('ok')")] } }, { busy: () => busy });
    for (const payload of [{}, { update: true }]) {
      const res = await post(h, payload, h.owner);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe(
        "Not now: a merge in shop; deploy of shop/local (since 2026-03-02T12:00:00.000Z). Restart when it has finished",
      );
    }
    await h.controller.settled();
    expect(h.calls).toEqual([]);
    expect(h.controller.status().state).toBe("idle");

    busy = [];
    expect((await post(h, {}, h.owner)).statusCode).toBe(202);
    await h.controller.settled();
    expect(h.calls).toEqual(["shutdown", "exit 0"]);
  });

  it("after an update, waits for work that started meanwhile before shutting down (bounded)", async () => {
    let checks = 0;
    // Free at the request (check 1); busy at checks 2 and 3, after the update; free again at check 4
    const h = await setup(
      { server: { update_cmd: [step("console.log('ok')")] } },
      { busy: () => (++checks >= 2 && checks <= 3 ? ["a merge in shop"] : []), busyWaitMs: 10_000 },
    );
    expect((await post(h, { update: true }, h.owner)).statusCode).toBe(202);
    await h.controller.settled();
    expect(h.controller.status().output).toContain("Waiting for: a merge in shop");
    expect(checks).toBe(4);
    expect(h.calls).toEqual(["shutdown", "exit 0"]);
  });

  it("exits with code 0 when the shutdown hangs past its deadline", async () => {
    const h = await setup(undefined, { shutdownTimeoutMs: 50 });
    h.shutdown.mockImplementationOnce(() => new Promise(() => undefined));
    expect((await post(h, {}, h.owner)).statusCode).toBe(202);
    await h.controller.settled();
    expect(h.exit).toHaveBeenCalledWith(0);
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

describe("data/server.yaml file checks", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const SERVER = JSON.stringify({ server: { update_cmd: [["git", "pull"]] } });
  function file(mode = 0o600): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), "lair-server-config-"));
    dirs.push(dir);
    const path = join(dir, "server.yaml");
    writeFileSync(path, SERVER);
    chmodSync(path, mode);
    return { dir, path };
  }
  const linux = { platform: "linux" as const };
  const refusal = (result: ReturnType<typeof loadServerConfig>) => (result.ok ? null : result.errors.join("; "));

  it("reads the owner's regular file, mode 600 or 644", () => {
    expect(loadServerConfig(file(0o600).path, linux)).toMatchObject({ ok: true, settings: { updateSteps: [["git", "pull"]] } });
    expect(loadServerConfig(file(0o644).path, linux).ok).toBe(true);
    expect(loadServerConfig(join(tmpdir(), "lair-no-such-dir", "server.yaml"), linux)).toMatchObject({ ok: true });
  });

  it("refuses a symbolic link, a group- or other-writable file, another user's file and a directory", () => {
    const real = file();
    const link = join(real.dir, "link.yaml");
    symlinkSync(real.path, link);
    expect(refusal(loadServerConfig(link, linux))).toBe("refused: it is a symbolic link");
    expect(refusal(loadServerConfig(file(0o664).path, linux))).toBe("refused: its group or other users may write it (mode 664): chmod 600 it");
    expect(refusal(loadServerConfig(file(0o602).path, linux))).toContain("refused: its group or other users may write it");
    const uid = (process.getuid?.() ?? 0) + 1;
    expect(refusal(loadServerConfig(real.path, { ...linux, uid }))).toContain("refused: it is owned by another user");
    const dir = join(real.dir, "dir.yaml");
    mkdirSync(dir);
    expect(refusal(loadServerConfig(dir, linux))).toBe("refused: it is not a regular file");
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO without blocking on it", () => {
    const { dir } = file();
    const fifo = join(dir, "fifo.yaml");
    execFileSync("mkfifo", [fifo]);
    expect(refusal(loadServerConfig(fifo, linux))).toBe("refused: it is not a regular file");
  });

  it("an Update and restart with a refused file is a 400, and Restart says why in its status", async () => {
    const h = await setup({ server: { update_cmd: [step("console.log('ok')")] } });
    chmodSync(join(h.dir, "server.yaml"), 0o666);
    const res = await post(h, { update: true }, h.owner);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("refused: its group or other users may write it");
    expect(h.controller.status().configError).toContain("refused");
    expect(h.calls).toEqual([]);
  });
});

describe("configuredTokenEnvs", () => {
  const base = { name: "x", repo: "/r", github: "o/r", queue_file: "/q", agents_dir: "/a", gates_dir: "/g", machines: {} };
  it("names the token variables of the modules that are on", () => {
    const configs = [
      { ...base, review: { enabled: true, token_env: "REVIEW_TOKEN", merge: { gate: { source: "checks", required: ["build"] } } } },
      { ...base, executors: { github: { token_env: "CI_TOKEN" } } },
      { ...base, review: { enabled: false, token_env: "UNUSED_TOKEN" } },
    ] as unknown as ProjectConfig[];
    expect(configuredTokenEnvs(configs)).toEqual(["CI_TOKEN", "REVIEW_TOKEN"]);
  });
});

describe("serviceManagerOf", () => {
  it("prefers server.service_manager", () => {
    expect(serviceManagerOf("launchd", {}, "linux", 999)).toMatchObject({ name: "launchd", source: "configured" });
    expect(serviceManagerOf("none", { INVOCATION_ID: "abc", JOURNAL_STREAM: "8:1" }, "linux", 1)).toMatchObject({
      name: null,
      source: "configured",
    });
  });

  it("takes systemd's INVOCATION_ID only beside JOURNAL_STREAM or a parent pid of 1, and says probably", () => {
    expect(serviceManagerOf(null, { INVOCATION_ID: "abc", JOURNAL_STREAM: "8:1" }, "linux", 999)).toMatchObject({
      name: "systemd",
      source: "detected",
    });
    const viaPid1 = serviceManagerOf(null, { INVOCATION_ID: "abc" }, "linux", 1);
    expect(viaPid1).toMatchObject({ name: "systemd", source: "detected" });
    expect(viaPid1.note).toMatch(/^Probably started by systemd/);
    // A terminal of a systemd user session inherits INVOCATION_ID alone
    expect(serviceManagerOf(null, { INVOCATION_ID: "abc" }, "linux", 999)).toMatchObject({ name: null, source: "unknown" });
    expect(serviceManagerOf(null, { XPC_SERVICE_NAME: "dev.lair.server" }, "darwin", 999)).toMatchObject({
      name: "launchd",
      source: "detected",
    });
  });

  it("says when it can't tell", () => {
    for (const env of [{}, { XPC_SERVICE_NAME: "0" }, { XPC_SERVICE_NAME: "application.com.apple.Terminal.1" }]) {
      const view = serviceManagerOf(null, env, "darwin", 999);
      expect(view).toMatchObject({ name: null, source: "unknown" });
      expect(view.note).toContain("can't tell");
    }
    expect(serviceManagerOf(null, { XPC_SERVICE_NAME: "dev.lair.server" }, "linux", 999).source).toBe("unknown");
  });
});
