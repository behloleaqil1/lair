/**
 * Settings, through the production code: the real routes behind the real
 * HumanAuth, the dashboard's own request helpers (src/client/settings-api.ts),
 * the parsers live reload uses (the real delivery and watchdog managers, via
 * serverModules), the real ConfigReloader, and real files in a temporary
 * projects/ and data/. Only docker (FakeDocker) and the clock are fake; git
 * is the real one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { MAX_CONFIG_BYTES, loadProjectConfig } from "../config.js";
import { FakeClock, FakeDocker } from "../delivery/fake-docker.js";
import { DeliveryManager } from "../delivery/service.js";
import type { AgentsManager } from "../agents/service.js";
import type { PipelineManager } from "../gates/pipeline-service.js";
import type { ReviewManager } from "../review/service.js";
import type { TriageManager } from "../triage/manager.js";
import { NodeFileSystem } from "../watchdog/probes.js";
import { WatchdogManager } from "../watchdog/service.js";
import { HumanAuth, OWNER_SESSION_HEADER, registerOwnerRoutes } from "../human-auth/index.js";
import { registerRootGuards } from "../root-guards.js";
import { ConfigReloader, serverModules } from "../reload/index.js";
import { signIn, storedSession } from "../../client/owner-session";
import {
  checkNewProject,
  checkProjectSettings,
  checkRepository,
  createProject,
  loadHistory,
  loadProjectSettings,
  loadSections,
  loadVersion,
  restoreVersion,
  saveProjectSettings,
} from "../../client/settings-api";
import { diffValues, fieldsOf, sectionFields, type FieldModel } from "../../client/settings-form";
import type { SettingsCheck } from "../../shared/settings-types.js";
import { SETTINGS_BODY_LIMIT, SettingsService, registerSettingsUiRoutes } from "./index.js";

const BROWSER = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };
const quiet = { log: () => undefined, warn: () => undefined };

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  vi.unstubAllGlobals();
  await cleanup?.();
  cleanup = null;
});

async function waitFor(what: string, done: () => boolean, timeoutMs = 8000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The project file the tests start from: comments, quoting and flow lists that must survive a save. */
function shopYaml(root: string, extra = ""): string {
  const q = JSON.stringify;
  return [
    "# Shop: the example project of the Settings tests",
    "",
    "name: Shop",
    `repo: ${q(root)}`,
    "github: example/shop",
    `queue_file: ${q(join(root, "queue.md"))}`,
    `agents_dir: ${q(join(root, "agents"))}`,
    `gates_dir: ${q(join(root, "gates"))}`,
    "machines: {}",
    "# The watchdog looks every minute",
    "watchdog:",
    "  enabled: true",
    "  interval_seconds: 60 # once a minute",
    "  mode: observe",
    "delivery:",
    "  enabled: true",
    "  interval_seconds: 30",
    "  environments:",
    "    local:",
    '      compose_files: ["./deploy/compose.yaml"]',
    "      project_name: shop-local",
    "      services:",
    "        web: {}",
    extra,
  ].join("\n");
}

async function setup(options: { extra?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lair-settings-"));
  const projects = join(root, "projects");
  const data = join(root, "data");
  mkdirSync(join(projects, "local"), { recursive: true });
  mkdirSync(join(root, "agents"));
  const file = join(projects, "local", "shop.yaml");
  const original = shopYaml(root, options.extra);
  writeFileSync(file, original);

  const docker = new FakeDocker("shop-local", { web: {} });
  const clock = new FakeClock();
  const deliveries = new DeliveryManager({ dbPath: ":memory:", probes: { runner: docker, clock, http: docker.http } });
  const watchdogs = new WatchdogManager({
    dbPath: ":memory:",
    probes: { processes: { list: async () => [] }, fs: new NodeFileSystem(), runner: docker, clock },
    services: deliveries,
  });
  const initial = [{ name: "shop", config: loadProjectConfig("shop", projects) }];
  deliveries.load(initial);
  watchdogs.load(initial);
  deliveries.start();
  watchdogs.start();
  // Not watching: a reload here can only come from the Settings route
  const reloader = new ConfigReloader({
    modules: serverModules({ delivery: deliveries, watchdogs }),
    initial,
    projectsDir: projects,
    cwd: root,
    log: quiet,
  });

  const auth = HumanAuth.open({ tokenPath: join(data, "owner.token"), dbPath: ":memory:" });
  const token = readFileSync(join(data, "owner.token"), "utf-8").trim();
  const service = new SettingsService({
    projectsDir: projects,
    dataDir: data,
    cwd: root,
    validate: (config) => reloader.validate(config),
    reload: (project) => reloader.apply(project),
    reloadProblem: (project) => reloader.problemOf(project),
    env: {},
  });
  const app: FastifyInstance = Fastify({ logger: false });
  registerRootGuards(app);
  await registerOwnerRoutes(app, auth);
  await registerSettingsUiRoutes(app, { service, auth });
  await app.ready();

  // The dashboard's helpers send their requests to this app, as the same-origin page does
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const res = await app.inject({
      method: (init.method ?? "GET") as "GET" | "POST" | "PUT",
      url: input,
      headers: { ...(init.headers as Record<string, string> | undefined), ...BROWSER },
      payload: typeof init.body === "string" ? init.body : undefined,
    });
    return { status: res.statusCode, json: async () => res.json() };
  });

  cleanup = async () => {
    await app.close();
    auth.close();
    await reloader.stop();
    await watchdogs.stop();
    await deliveries.stop();
    rmSync(root, { recursive: true, force: true });
  };
  const owner = async () => {
    await signIn(token);
  };
  const historyDir = join(data, "config-history", "shop");
  const versions = () => (existsSync(historyDir) ? readdirSync(historyDir).filter((f) => f.endsWith(".json")) : []);
  return { root, projects, data, file, original, app, auth, service, reloader, deliveries, watchdogs, owner, versions, historyDir };
}


async function hashOf(): Promise<string> {
  const view = await loadProjectSettings("shop");
  expect(view.success).toBe(true);
  return view.data!.hash;
}

describe("Settings is the owner's only, reads included", () => {
  it("answers 403 to no session, a browser that is not signed in, and an invalid session, on every route", async () => {
    const h = await setup();
    const routes: [string, string, unknown?][] = [
      ["GET", "/api/settings/modules"],
      ["GET", "/api/settings/projects"],
      ["GET", "/api/settings/projects/shop"],
      ["PUT", "/api/settings/projects/shop", { baseHash: "0".repeat(64), changes: [{ path: ["watchdog", "interval_seconds"], value: 90 }] }],
      ["POST", "/api/settings/validate", { project: "shop", yaml: "name: x\n" }],
      ["POST", "/api/settings/projects", { id: "intruder", name: "Intruder", repo: h.root }],
      ["POST", "/api/settings/repo", { path: h.root }],
      ["GET", "/api/settings/projects/shop/history"],
      ["GET", "/api/settings/projects/shop/history/20260101T000000000Z-abcdef"],
      ["POST", "/api/settings/projects/shop/history/20260101T000000000Z-abcdef/restore", { baseHash: "0".repeat(64) }],
    ];
    const kinds: [string, Record<string, string>][] = [
      // curl, a script or an agent: no Origin, no session
      ["no session", {}],
      ["a browser that is not signed in", BROWSER],
      ["an invalid session", { ...BROWSER, [OWNER_SESSION_HEADER]: "x".repeat(43) }],
    ];
    for (const [method, url, payload] of routes) {
      for (const [kind, headers] of kinds) {
        const res = await h.app.inject({
          method: method as "GET" | "POST" | "PUT",
          url,
          headers: payload === undefined ? headers : { ...headers, "content-type": "application/json" },
          payload: payload === undefined ? undefined : JSON.stringify(payload),
        });
        expect(res.statusCode, `${method} ${url} with ${kind}`).toBe(403);
        expect(res.json().error).toContain("Only the owner can do this");
        // Nothing of the config in the answer
        expect(res.body).not.toContain(h.root);
        expect(res.body).not.toContain("interval_seconds");
      }
    }
    expect(readFileSync(h.file, "utf-8")).toBe(h.original);
    expect(existsSync(join(h.projects, "local", "intruder.yaml"))).toBe(false);
    expect(h.versions()).toEqual([]);
  });
});

describe("saving", () => {
  it("refuses an invalid change with errors per field and writes nothing", async () => {
    const h = await setup();
    await h.owner();
    const before = h.watchdogs.get("shop");
    const reply = await saveProjectSettings("shop", {
      baseHash: await hashOf(),
      changes: [{ path: ["watchdog", "interval_seconds"], value: 1 }],
    });
    expect(reply.status).toBe(422);
    expect(reply.code).toBe("invalid");
    expect(reply.check?.errors).toContainEqual({
      path: "watchdog.interval_seconds",
      message: expect.stringContaining("greater than or equal to 5"),
    });
    expect(readFileSync(h.file, "utf-8")).toBe(h.original);
    expect(h.versions()).toEqual([]);
    await h.reloader.settled();
    expect(h.watchdogs.get("shop")).toBe(before);

    // A missing required field and a YAML error, from the YAML tab
    const missing = await saveProjectSettings("shop", { baseHash: await hashOf(), yaml: h.original.replace("name: Shop\n", "") });
    expect(missing.status).toBe(422);
    expect(missing.check?.errors).toContainEqual({ path: "name", message: "required" });
    const broken = await saveProjectSettings("shop", { baseHash: await hashOf(), yaml: "name: [unclosed\n" });
    expect(broken.status).toBe(422);
    expect(broken.check?.errors[0]).toMatchObject({ path: "", message: expect.stringContaining("YAML") });
    expect(readFileSync(h.file, "utf-8")).toBe(h.original);
  });

  it("writes a valid change with comments, quoting and key order kept, and the reloader applies it", async () => {
    const h = await setup();
    await h.owner();
    const view = (await loadProjectSettings("shop")).data!;
    const oldWatchdog = h.watchdogs.get("shop")!;
    const oldDelivery = h.deliveries.get("shop")!;
    // What the form sends: only the field that changed
    const changes = diffValues(view.values, { ...view.values, watchdog: { ...(view.values!.watchdog as object), interval_seconds: 120 } });
    expect(changes).toEqual([{ path: ["watchdog", "interval_seconds"], value: 120 }]);

    const dry = await checkProjectSettings("shop", { baseHash: view.hash, changes });
    expect(dry.data).toMatchObject({ ok: true, errors: [], commands: [], conflict: false });
    expect(dry.data!.diff).toMatchObject({ added: 1, removed: 1 });
    expect(readFileSync(h.file, "utf-8")).toBe(h.original);

    const saved = await saveProjectSettings("shop", { baseHash: view.hash, changes });
    expect(saved.status).toBe(200);
    const after = readFileSync(h.file, "utf-8");
    expect(after).toBe(h.original.replace("interval_seconds: 60 # once a minute", "interval_seconds: 120 # once a minute"));
    expect(saved.data).toMatchObject({ reloadProblem: null, diff: { added: 1, removed: 1 } });

    // The route ran the reload (the reloader is not watching the directory)
    await waitFor("the watchdog reload", () => h.watchdogs.get("shop") !== oldWatchdog);
    await h.reloader.settled();
    expect(h.watchdogs.get("shop")!.settings.intervalSeconds).toBe(120);
    expect(h.watchdogs.get("shop")!.running).toBe(true);
    expect(h.deliveries.get("shop")).toBe(oldDelivery);
    expect(h.reloader.status().recent.map((r) => r.module)).toEqual(["watchdog"]);
  });

  it("refuses a save based on a version the file no longer is (a hand edit) and shows the change re-applied", async () => {
    const h = await setup();
    await h.owner();
    const hash = await hashOf();
    const handEdited = h.original.replace("  interval_seconds: 30\n", "  interval_seconds: 45\n");
    writeFileSync(h.file, handEdited);

    const changes = [{ path: ["watchdog", "interval_seconds"], value: 90 }];
    const conflict = await saveProjectSettings("shop", { baseHash: hash, changes });
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe("conflict");
    expect(conflict.check).toMatchObject({ ok: false, conflict: true });
    expect(conflict.check!.currentHash).not.toBe(hash);
    // The change on top of the current file: the hand edit stays
    expect(conflict.check!.yaml).toContain("interval_seconds: 45");
    expect(conflict.check!.yaml).toContain("interval_seconds: 90 # once a minute");
    expect(readFileSync(h.file, "utf-8")).toBe(handEdited);

    const again = await saveProjectSettings("shop", { baseHash: conflict.check!.currentHash!, changes });
    expect(again.status).toBe(200);
    expect(readFileSync(h.file, "utf-8")).toBe(conflict.check!.yaml);
    // The hand edit was kept as a version of its own before the save
    expect((await loadHistory("shop")).data!.versions.map((v) => v.action)).toEqual(["save", "file"]);
  });

  it("refuses a project file that is a symlink, and a symlinked projects/local", async () => {
    const h = await setup();
    await h.owner();
    const outside = join(h.root, "outside.yaml");
    writeFileSync(outside, shopYaml(h.root));
    symlinkSync(outside, join(h.projects, "local", "linked.yaml"));

    const listed = await h.app.inject({ url: "/api/settings/projects", headers: { ...BROWSER, [OWNER_SESSION_HEADER]: storedSession()! } });
    expect(listed.json().data.projects).toContainEqual(
      expect.objectContaining({ id: "linked", writable: false, problem: expect.stringContaining("symlink") }),
    );
    const read = await loadProjectSettings("linked");
    expect(read.status).toBe(400);
    expect(read.code).toBe("unsafe_file");
    const write = await saveProjectSettings("linked", { baseHash: "0".repeat(64), yaml: shopYaml(h.root).replace("Shop", "Changed") });
    expect(write.status).toBe(400);
    expect(write.error).toContain("symlink");
    expect(readFileSync(outside, "utf-8")).toBe(shopYaml(h.root));

    // projects/local itself a symlink
    const elsewhere = join(h.root, "elsewhere");
    mkdirSync(elsewhere);
    rmSync(join(h.projects, "local"), { recursive: true });
    writeFileSync(join(elsewhere, "shop.yaml"), h.original);
    symlinkSync(elsewhere, join(h.projects, "local"));
    const viaDir = await saveProjectSettings("shop", { baseHash: "0".repeat(64), yaml: h.original });
    expect(viaDir.status).toBe(400);
    expect(viaDir.error).toContain("symlink");
  });

  it("needs the owner's confirmation of exactly the commands a change adds, and none to remove one", async () => {
    const h = await setup();
    await h.owner();
    const argv = ["./bin/restart-agent", "{agent}", "{pid}"];
    const changes = [{ path: ["watchdog", "actions"], value: { restart_agent: argv } }];
    const unconfirmed = await saveProjectSettings("shop", { baseHash: await hashOf(), changes });
    expect(unconfirmed.status).toBe(428);
    expect(unconfirmed.code).toBe("confirm_commands");
    expect(unconfirmed.check!.commands).toEqual([{ path: "watchdog.actions.restart_agent", before: null, after: argv }]);
    const digest = unconfirmed.check!.commandsDigest;
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(h.file, "utf-8")).toBe(h.original);

    // A confirmation of other commands is not this one
    const wrong = await saveProjectSettings("shop", { baseHash: await hashOf(), changes, confirmCommands: "0".repeat(64) });
    expect(wrong.status).toBe(428);
    expect(readFileSync(h.file, "utf-8")).toBe(h.original);

    const confirmed = await saveProjectSettings("shop", { baseHash: await hashOf(), changes, confirmCommands: digest });
    expect(confirmed.status).toBe(200);
    expect((parseYaml(readFileSync(h.file, "utf-8")) as { watchdog: { actions: unknown } }).watchdog.actions).toEqual({
      restart_agent: argv,
    });

    // Changing it again needs a new confirmation; removing it doesn't
    const changed = await saveProjectSettings("shop", {
      baseHash: await hashOf(),
      changes: [{ path: ["watchdog", "actions", "restart_agent"], value: ["./bin/other", "{agent}"] }],
    });
    expect(changed.status).toBe(428);
    expect(changed.check!.commands).toEqual([
      { path: "watchdog.actions.restart_agent", before: argv, after: ["./bin/other", "{agent}"] },
    ]);
    const removed = await saveProjectSettings("shop", {
      baseHash: await hashOf(),
      changes: [{ path: ["watchdog", "actions"], remove: true }],
    });
    expect(removed.status).toBe(200);
    expect(readFileSync(h.file, "utf-8")).toBe(h.original);
  });

  it("refuses a value that looks like a secret, by its key or its shape, and never echoes it", async () => {
    const h = await setup();
    await h.owner();
    // Built at run time: no secret-shaped literal in the source
    const token = ["ghp", "_", "Q".repeat(36)].join("");
    const password = ["pw", "9".repeat(10)].join("");
    const url = ["https://deploy:", password, "@example.com/shop.git"].join("");

    const byKey = await saveProjectSettings("shop", {
      baseHash: await hashOf(),
      changes: [{ path: ["api_token"], value: "plain-looking-value" }],
    });
    expect(byKey.status).toBe(422);
    expect(byKey.check!.errors).toContainEqual({ path: "api_token", message: expect.stringContaining("data/") });

    const byShape = await saveProjectSettings("shop", {
      baseHash: await hashOf(),
      changes: [
        { path: ["delivery", "environments", "local", "deploy"], value: { fetch_cmd: ["git", "fetch", url] } },
        { path: ["notes"], value: `ci uses ${token}` },
      ],
    });
    expect(byShape.status).toBe(422);
    const paths = byShape.check!.errors.map((e) => e.path);
    expect(paths).toContain("delivery.environments.local.deploy.fetch_cmd.2");
    expect(paths).toContain("notes");
    for (const e of byShape.check!.errors) {
      expect(e.message).not.toContain(password);
      expect(e.message).not.toContain(token);
    }

    const pem = ["-----BEGIN ", "PRIVATE KEY-----\nAAAA\n-----END ", "PRIVATE KEY-----"].join("");
    const inYaml = await saveProjectSettings("shop", {
      baseHash: await hashOf(),
      yaml: `${h.original}signing_key: ${JSON.stringify(pem)}\n`,
    });
    expect(inYaml.status).toBe(422);
    expect(inYaml.check!.errors).toContainEqual({ path: "signing_key", message: expect.stringContaining("private key") });
    expect(readFileSync(h.file, "utf-8")).toBe(h.original);
    expect(h.versions()).toEqual([]);

    // Names of variables and files that hold secrets are fine, and their status is shown, never their value
    const view = (await loadProjectSettings("shop")).data!;
    expect(view.secrets).toContainEqual({ label: "Owner token", where: "data/owner.token", set: true });
    expect(view.secrets).toContainEqual({ label: "lair-node token", where: "env LAIR_NODE_TOKEN", set: false });
    expect(JSON.stringify(view.secrets)).not.toContain(readFileSync(join(h.data, "owner.token"), "utf-8").trim());
  });

  it("keeps unknown keys as they are and lists them read-only", async () => {
    const h = await setup({ extra: "custom_tool:\n  mode: fast # kept\nx_note: \"keep me\"\n" });
    await h.owner();
    const view = (await loadProjectSettings("shop")).data!;
    expect(view.unknownKeys).toEqual(["custom_tool", "x_note"]);
    const sections = (await loadSections()).data!.sections;
    const shown = sections.flatMap((s) => sectionFields(s, view.values, view.known)).map((f) => f.key);
    expect(shown).not.toContain("custom_tool");

    const saved = await saveProjectSettings("shop", {
      baseHash: view.hash,
      changes: [{ path: ["watchdog", "mode"], value: "act" }],
    });
    expect(saved.status).toBe(200);
    const after = readFileSync(h.file, "utf-8");
    expect(after).toContain('custom_tool:\n  mode: fast # kept\nx_note: "keep me"\n');
    expect(after).toBe(h.original.replace("  mode: observe\n", "  mode: act\n"));
  });

  it("caps a save at the file size limit, and a request body at the route's limit", async () => {
    const h = await setup();
    await h.owner();
    const big = `${h.original}# ${"a".repeat(MAX_CONFIG_BYTES)}\n`;
    const tooBig = await saveProjectSettings("shop", { baseHash: await hashOf(), yaml: big });
    expect(tooBig.status).toBe(413);
    expect(tooBig.code).toBe("too_large");

    const huge = await h.app.inject({
      method: "PUT",
      url: "/api/settings/projects/shop",
      headers: { ...BROWSER, [OWNER_SESSION_HEADER]: storedSession()!, "content-type": "application/json" },
      payload: JSON.stringify({ baseHash: "0".repeat(64), yaml: "x".repeat(SETTINGS_BODY_LIMIT + 1) }),
    });
    expect(huge.statusCode).toBe(413);
    expect(readFileSync(h.file, "utf-8")).toBe(h.original);
    expect(h.versions()).toEqual([]);
  });
});

describe("history", () => {
  it("keeps every accepted version with who and when, shows its diffs, and restores one like any save", async () => {
    const h = await setup();
    await h.owner();
    const first = await saveProjectSettings("shop", {
      baseHash: await hashOf(),
      changes: [{ path: ["watchdog", "interval_seconds"], value: 90 }],
    });
    expect(first.status).toBe(200);
    const second = await saveProjectSettings("shop", {
      baseHash: await hashOf(),
      changes: [{ path: ["watchdog", "interval_seconds"], value: 120 }],
    });
    expect(second.status).toBe(200);

    const versions = (await loadHistory("shop")).data!.versions;
    expect(versions.map((v) => v.action)).toEqual(["save", "save", "file"]);
    const session = h.auth.listSessions()[0];
    expect(versions[0]).toMatchObject({ version: second.data!.version, by: session.id });
    expect(versions[2].by).toBeNull();
    // The session's public id is kept, never its value
    for (const file of readdirSync(h.historyDir)) {
      expect(readFileSync(join(h.historyDir, file), "utf-8")).not.toContain(storedSession()!);
      expect(statSync(join(h.historyDir, file)).mode & 0o777).toBe(0o600);
    }

    const detail = (await loadVersion("shop", versions[0].version)).data!;
    expect(detail.fromPrevious?.hunks.flatMap((x) => x.lines).filter((l) => l.op !== " ")).toEqual([
      { op: "-", text: "  interval_seconds: 90 # once a minute" },
      { op: "+", text: "  interval_seconds: 120 # once a minute" },
    ]);
    expect(detail.restoreDiff.hunks).toEqual([]);

    // Restore the file as it was before Settings wrote it
    const original = versions[2].version;
    const restoreView = (await loadVersion("shop", original)).data!;
    expect(restoreView.yaml).toBe(h.original);
    const restored = await restoreVersion("shop", original, { baseHash: await hashOf() });
    expect(restored.status).toBe(200);
    expect(readFileSync(h.file, "utf-8")).toBe(h.original);
    const after = (await loadHistory("shop")).data!.versions;
    expect(after[0]).toMatchObject({ action: "restore", restoredFrom: original });

    // A restore is checked like a save: a stale hash is refused
    const stale = await restoreVersion("shop", versions[0].version, { baseHash: versions[0].hash });
    expect(stale.status).toBe(409);
    expect(readFileSync(h.file, "utf-8")).toBe(h.original);
  });
});

describe("creating a project", () => {
  it("checks the repository with git, proposes its GitHub repo and paths, writes projects/local/<id>.yaml and starts it", async () => {
    const h = await setup();
    await h.owner();
    const repo = join(h.root, "demo-app");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/example/demo-app.git"]);

    const checked = (await checkRepository(repo)).data!;
    expect(checked).toMatchObject({ exists: true, gitRepo: true, github: "example/demo-app" });
    expect(checked.suggested.queue_file).toBe(join(repo, "work", "queue.md"));
    const notGit = (await checkRepository(h.data)).data!;
    expect(notGit).toMatchObject({ gitRepo: false, problem: expect.stringContaining("not a git work tree") });
    expect((await checkRepository("-rf")).data!.problem).toBe("must not start with '-'");

    const request = { id: "demo-app", name: "Demo App", repo, modules: ["watchdog"] };
    const dry = await checkNewProject(request);
    expect(dry.data).toMatchObject({ ok: true, errors: [] });
    expect(existsSync(join(h.projects, "local", "demo-app.yaml"))).toBe(false);

    const created = await createProject(request);
    expect(created.status).toBe(201);
    const file = join(h.projects, "local", "demo-app.yaml");
    expect(created.data).toMatchObject({ id: "demo-app", file: "projects/local/demo-app.yaml" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const values = parseYaml(readFileSync(file, "utf-8")) as Record<string, unknown>;
    expect(values).toMatchObject({
      name: "Demo App",
      repo,
      github: "example/demo-app",
      queue_file: join(repo, "work", "queue.md"),
      agents_dir: join(repo, "work", "agents"),
      gates_dir: join(repo, "work", "gates"),
      read_only: true,
      watchdog: { enabled: true },
    });
    expect(loadProjectConfig("demo-app", h.projects).name).toBe("Demo App");
    // Live reload starts its modules
    await waitFor("the new project's watchdog", () => h.watchdogs.get("demo-app")?.running === true);
    expect((await loadHistory("demo-app")).data!.versions.map((v) => v.action)).toEqual(["create"]);

    const again = await createProject(request);
    expect(again.status).toBe(409);
    const bad = await checkNewProject({ id: "../escape", name: "", repo: h.data });
    expect(bad.status).toBe(422);
    expect(bad.check?.errors.map((e) => e.path)).toEqual(["id"]);
    const invalid = await checkNewProject({ id: "other", name: "", repo: h.data, modules: ["nope"] });
    expect(invalid.data!.ok).toBe(false);
    expect(invalid.data!.errors.map((e) => e.path)).toEqual(expect.arrayContaining(["name", "repo", "modules"]));
    expect(existsSync(join(h.projects, "local", "other.yaml"))).toBe(false);
  });
});

describe("forms", () => {
  const KINDS = ["text", "textarea", "number", "toggle", "select", "argv", "list", "globs", "path", "yaml", "object", "record", "objects"];

  function allFields(fields: FieldModel[], ctx: Parameters<typeof fieldsOf>[4], depth = 0): FieldModel[] {
    const out: FieldModel[] = [];
    for (const f of fields) {
      out.push(f);
      if (f.kind === "object" && depth < 6) {
        out.push(...allFields(fieldsOf(f.schema, f.value, f.path, f.pattern.split(".").filter(Boolean), ctx), ctx, depth + 1));
      }
    }
    return out;
  }

  it("has a section for every module block live reload knows, and draws a form for each from its schema", async () => {
    const h = await setup();
    await h.owner();
    const sections = (await loadSections()).data!.sections;
    expect(new Set(sections.map((s) => s.key)).size).toBe(sections.length);
    // Enumerating the modules only reads their blocks
    const all = serverModules({
      delivery: {} as DeliveryManager,
      watchdogs: {} as WatchdogManager,
      pipelines: {} as PipelineManager,
      reviews: {} as ReviewManager,
      agents: {} as AgentsManager,
      triage: {} as TriageManager,
    });
    const blocks = sections.flatMap((s) => s.blocks);
    for (const module of all) for (const block of module.blocks) expect(blocks, block).toContain(block);
    expect(sections.filter((s) => s.toggle).map((s) => s.key)).toEqual(
      expect.arrayContaining(["watchdog", "delivery", "review", "agents", "triage"]),
    );

    const view = (await loadProjectSettings("shop")).data!;
    for (const section of sections) {
      const fields = allFields(sectionFields(section, view.values, view.known), { section, known: view.known });
      expect(fields.length, section.key).toBeGreaterThan(0);
      for (const f of fields) expect(KINDS, `${section.key}: ${f.path.join(".")}`).toContain(f.kind);
    }

    const byPath = (key: string) => {
      const section = sections.find((s) => s.key === key)!;
      return new Map(
        allFields(sectionFields(section, null, view.known), { section, known: view.known }).map((f) => [f.path.join("."), f]),
      );
    };
    const watchdog = byPath("watchdog");
    expect(watchdog.get("watchdog.interval_seconds")).toMatchObject({
      kind: "number",
      defaultValue: 60,
      schema: { type: "integer", minimum: 5, maximum: 3600 },
    });
    expect(watchdog.get("watchdog.mode")).toMatchObject({ kind: "select", schema: { enum: ["observe", "act"] } });
    expect(watchdog.get("watchdog.actions.restart_agent")).toMatchObject({ kind: "argv", command: true });
    // Fill's new block (agents.fill) and triage's commands appear with no UI code for them
    const agents = byPath("agents");
    expect(agents.get("agents.fill.capacity_cmd")).toMatchObject({ kind: "argv", command: true });
    expect(agents.get("agents.fill.agents")).toMatchObject({ kind: "list", command: false });
    expect(agents.get("agents.fill.tasks_file")).toMatchObject({ kind: "path" });
    expect(agents.get("agents.branch_state_cmd")).toMatchObject({ kind: "argv", command: true });
    const triage = byPath("triage");
    expect(triage.get("triage.commands.recheck")).toMatchObject({ kind: "argv", command: true });
    expect(triage.get("triage.actions.infra")).toMatchObject({ kind: "select", command: false });
    expect(triage.get("triage.recheck.capacity_cmd")).toMatchObject({ kind: "argv", command: true });
    const dragons = byPath("dragons");
    expect(dragons.get("dragon_start_cmd")).toMatchObject({ kind: "argv", command: true });
    const adapters = byPath("adapters");
    expect(adapters.get("agent_adapters")).toMatchObject({ kind: "record" });
  });
});

describe("the dry run", () => {
  it("reports a conflict, errors and commands without writing", async () => {
    const h = await setup();
    await h.owner();
    const check: SettingsCheck = (
      await checkProjectSettings("shop", {
        baseHash: "f".repeat(64),
        changes: [{ path: ["dragon_start_cmd"], value: ["./bin/start", "{dragon}"] }],
      })
    ).data!;
    expect(check).toMatchObject({ ok: false, conflict: true, errors: [] });
    expect(check.commands).toEqual([{ path: "dragon_start_cmd", before: null, after: ["./bin/start", "{dragon}"] }]);
    expect(readFileSync(h.file, "utf-8")).toBe(h.original);
  });
});
