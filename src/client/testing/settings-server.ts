/**
 * A Lair server for the Settings DOM tests, through the production code:
 * the real Settings routes (SettingsService behind the real HumanAuth, with
 * the parsers startup and live reload use), the real AI tools routes
 * (AiToolsService: its command runner is the one fake, as in the AI module's
 * own tests) and the real notification routes, on real files in a temporary
 * projects/ and data/, and a real git repository. The page's fetch goes to
 * it as a same-origin browser request does; `requests` lists every request
 * the page made.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { execFileSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadProjectConfig } from "../../server/config.js";
import { EventBus } from "../../server/core/event-bus.js";
import { DecisionInbox } from "../../server/decisions/service.js";
import { MemorySecretStore } from "../../server/decisions/secrets.js";
import { DecisionStore } from "../../server/decisions/store.js";
import { HumanAuth, registerOwnerRoutes } from "../../server/human-auth/index.js";
import { mountNotifications } from "../../server/notifications/mount.js";
import { ConfigReloader, serverModules } from "../../server/reload/index.js";
import { SettingsService, registerSettingsUiRoutes } from "../../server/settings/index.js";
import { AiToolsService, registerAiRoutes, type ToolRunner, type ToolRunOptions, type ToolRunOutput } from "../../server/ai/index.js";
import { signIn } from "../owner-session";

const BROWSER = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };
const quiet = { log: () => undefined, warn: () => undefined };

/** The tools' own commands (and ssh): what the answer function says; unanswered, the program is not installed. */
export class FakeToolRunner implements ToolRunner {
  calls: string[] = [];
  constructor(public answer: (argv: string[]) => ToolRunOutput | undefined = () => undefined) {}
  async run(argv: string[], _options: ToolRunOptions): Promise<ToolRunOutput> {
    this.calls.push(argv.join(" "));
    return this.answer(argv) ?? { code: -1, stdout: "", stderr: "", failure: "not_found", message: `spawn ${argv[0]} ENOENT` };
  }
}

export const answer = (stdout: string, code = 0): ToolRunOutput => ({ code, stdout, stderr: "" });

export interface SettingsServerOptions {
  /** The project file shop.yaml, given the temporary directory (its repository is `<dir>/repo`) */
  yaml: (dir: string) => string;
  /** What the tools' commands answer */
  tools?: (argv: string[]) => ToolRunOutput | undefined;
  /** Programs installed on the tools' PATH */
  programs?: string[];
  /** data/server.yaml (Lair's own: notifications); none, no file */
  serverYaml?: string;
  /** The repository's origin (it is a git work tree either way) */
  origin?: string;
  /** The AI tools' clock (their checks' cache and its refresh limit); default the real one */
  clock?: { now(): number };
}

export interface SettingsServer {
  dir: string;
  /** projects/local/shop.yaml */
  file: string;
  app: FastifyInstance;
  runner: FakeToolRunner;
  /** "GET /api/settings/modules", ... in the order the page asked */
  requests: string[];
  /** What the page's fetch is */
  fetch: typeof fetch;
  /** Sign this browser in as the owner (through the real route) */
  signIn(): Promise<void>;
  read(): string;
  close(): Promise<void>;
}

export async function settingsServer(options: SettingsServerOptions): Promise<SettingsServer> {
  const dir = mkdtempSync(join(tmpdir(), "lair-settings-ui-"));
  const projects = join(dir, "projects");
  const data = join(dir, "data");
  const bin = join(dir, "bin");
  const repo = join(dir, "repo");
  for (const d of [join(projects, "local"), data, bin, repo]) mkdirSync(d, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  if (options.origin) execFileSync("git", ["-C", repo, "remote", "add", "origin", options.origin]);
  for (const program of options.programs ?? []) {
    writeFileSync(join(bin, program), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, program), 0o755);
  }
  const file = join(projects, "local", "shop.yaml");
  writeFileSync(file, options.yaml(dir));
  const configPath = join(data, "server.yaml");
  if (options.serverYaml !== undefined) {
    writeFileSync(configPath, options.serverYaml);
    chmodSync(configPath, 0o600);
  }

  const auth = HumanAuth.open({ tokenPath: join(data, "owner.token"), dbPath: ":memory:" });
  const token = readFileSync(join(data, "owner.token"), "utf-8").trim();
  // The modules' own parsers, as live reload runs them. Validation only: the service gets no reload, so no manager is called
  const unused = {} as never;
  const reloader = new ConfigReloader({
    modules: serverModules({ delivery: unused, watchdogs: unused, pipelines: unused, reviews: unused, agents: unused }),
    initial: [],
    projectsDir: projects,
    cwd: dir,
    log: quiet,
  });
  const settings = new SettingsService({
    projectsDir: projects,
    dataDir: data,
    cwd: dir,
    validate: (config) => reloader.validate(config),
    env: {},
  });
  const runner = new FakeToolRunner(options.tools);
  const tools = new AiToolsService({ runner, env: { PATH: bin, HOME: dir }, clock: options.clock });
  const store = new DecisionStore(":memory:");
  const bus = new EventBus();

  // Each route module refuses cross-site requests itself. Not the root guards: they check ?project= against Lair's own
  // projects/, and this server's projects are in a temporary directory (the AI routes check them there)
  const app = Fastify({ logger: false });
  await registerOwnerRoutes(app, auth);
  await registerSettingsUiRoutes(app, { service: settings, auth });
  await registerAiRoutes(app, {
    service: tools,
    auth,
    defaultProject: () => "shop",
    config: (project) => loadProjectConfig(project, projects),
    projectsDir: projects,
  });
  await mountNotifications(app, {
    configPath,
    statePath: join(data, "notifications-state.json"),
    events: bus,
    inbox: new DecisionInbox({ store, secrets: new MemorySecretStore(), events: bus }),
    humanAuth: auth,
    dashboardUrl: "http://127.0.0.1:4777",
    platform: "linux",
    env: { PATH: "" },
  });
  await app.ready();

  const requests: string[] = [];
  const pageFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? `${input.pathname}${input.search}` : input.url;
    const method = (init.method ?? "GET") as "GET" | "POST" | "PUT";
    requests.push(`${method} ${url}`);
    const res = await app.inject({
      method,
      url,
      headers: { ...(init.headers as Record<string, string> | undefined), ...BROWSER },
      payload: typeof init.body === "string" ? init.body : undefined,
    });
    return new Response(res.body, { status: res.statusCode, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  return {
    dir,
    file,
    app,
    runner,
    requests,
    fetch: pageFetch,
    signIn: async () => {
      await signIn(token);
    },
    read: () => readFileSync(file, "utf-8"),
    close: async () => {
      await app.close();
      auth.close();
      store.close();
      await reloader.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
