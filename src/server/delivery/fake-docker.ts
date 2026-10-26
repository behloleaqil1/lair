/**
 * Test-only (excluded from the server build): a fake `docker` and `git` at
 * the process boundary. FakeDocker is a CommandRunner that answers argv the
 * way the real CLIs do, from a small model of one compose project's
 * containers, images and tags, in the real output formats (`docker compose
 * ps --format json` lines, `docker inspect` arrays), so delivery's own
 * parsers read it. Tests assert the argv delivery sent and the state those
 * commands left behind.
 */
import { createHash } from "crypto";
import type { Clock, CommandOutput, CommandRunner, RunOptions } from "../watchdog/probes.js";
import type { HttpProbe } from "./probes.js";

export const NOW = Date.parse("2026-03-02T12:00:00.000Z");
export const MIN = 60_000;

export class FakeClock implements Clock {
  t = NOW;
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface FakeService {
  /** The image reference compose uses (by default <project>-<service>) */
  imageRef?: string;
  /** The image has a HEALTHCHECK */
  healthcheck?: boolean;
  /** An HTTP health URL that answers 200 while a working image runs */
  url?: string;
  /** A compose container_name instead of <project>-<service>-1 */
  containerName?: string;
}

export interface FakeContainer {
  id: string;
  name: string;
  service: string;
  state: "created" | "running" | "restarting" | "exited";
  exitCode: number;
  restartCount: number;
  imageId: string;
  imageRef: string;
  restartPolicy: string;
  logs: string[];
}

const ok = (stdout = ""): CommandOutput => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 1): CommandOutput => ({ code, stdout: "", stderr });

/** "shop-local-api" -> "shop-local-api:latest" (tags are compared normalised) */
function normalise(ref: string): string {
  const slash = ref.lastIndexOf("/");
  return ref.lastIndexOf(":") > slash ? ref : `${ref}:latest`;
}

function hex(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

export class FakeDocker implements CommandRunner {
  calls: string[][] = [];
  containers: FakeContainer[] = [];
  /** Image id -> broken: containers of a broken image run but are never healthy */
  images = new Map<string, { broken: boolean }>();
  tags = new Map<string, string>();
  /** What the next `compose build <service>` makes */
  nextBuild: Record<string, "good" | "broken" | "fail"> = {};
  /** Compose before 2.21 prints one JSON array instead of one object per line */
  arrayFormat = false;
  /** The repository: deploy.ref's commit, and `git diff --name-only a b` answers keyed "a..b" */
  git = { head: "1".repeat(40), diffs: new Map<string, string[]>() };
  /** Runs before each command answers (to change things mid-operation) */
  onRun?: (argv: string[]) => void;
  private counter = 0;
  readonly services: Record<string, { imageRef: string; healthcheck: boolean; url?: string; containerName?: string }>;
  /** Every docker command fails as when the CLI is missing or the daemon is down (e.g. "spawn docker ENOENT") */
  broken: string | null = null;
  /** `compose build` runs until the command is killed (its signal aborts) */
  hangBuilds = false;
  /** The options each command was run with */
  options: (RunOptions | undefined)[] = [];
  private delays: { match: (argv: string[]) => boolean; gate: Promise<void> }[] = [];

  constructor(
    readonly project: string,
    services: Record<string, FakeService>,
  ) {
    this.services = {};
    for (const [name, s] of Object.entries(services)) {
      this.services[name] = {
        imageRef: s.imageRef ?? `${project}-${name}`,
        healthcheck: s.healthcheck ?? false,
        url: s.url,
        containerName: s.containerName,
      };
      this.tags.set(normalise(this.services[name].imageRef), this.newImage(false));
    }
  }

  private newImage(broken: boolean): string {
    const id = `sha256:${hex(`image-${this.counter++}`)}`;
    this.images.set(id, { broken });
    return id;
  }

  /** The image id a service's image reference points at now */
  imageOf(service: string): string | undefined {
    return this.tags.get(normalise(this.services[service].imageRef));
  }

  container(service: string): FakeContainer | undefined {
    return this.containers.find((c) => c.service === service);
  }

  /** Create and start containers, as if `docker compose up -d` had run before the test */
  running(...services: string[]): void {
    for (const service of services) this.startService(service, false);
  }

  /** The restart policy restarted the service's container `times` times; it is restarting now */
  crash(service: string, times: number, logLine = "Error: connect ECONNREFUSED localhost:5432"): void {
    const c = this.container(service);
    if (!c) throw new Error(`no container for ${service}`);
    c.restartCount += times;
    c.state = c.restartPolicy === "no" ? "exited" : "restarting";
    c.exitCode = 1;
    for (let i = 0; i < times; i++) c.logs.push("starting", logLine);
  }

  healthy(service: string): boolean {
    const c = this.container(service);
    return !!c && c.state === "running" && this.images.get(c.imageId)?.broken !== true;
  }

  /** HTTP health: a service's URL answers 200 while a working image runs, else the connection is refused */
  readonly http: HttpProbe = {
    get: async (url) => {
      const entry = Object.entries(this.services).find(([, s]) => s.url === url);
      if (entry && this.healthy(entry[0])) return { status: 200 };
      return { error: "fetch failed: connect ECONNREFUSED" };
    },
  };

  /** Commands that change something (not ps, inspect, logs or git reads) */
  mutations(): string[][] {
    return this.calls.filter((argv) => {
      if (argv[0] === "git") return false;
      if (argv[1] === "inspect") return false;
      const sub = argv[1] === "compose" ? argv[argv.findIndex((a, i) => i > 1 && !a.startsWith("-") && !this.isFlagValue(argv, i))] : argv[1];
      return sub !== "ps" && sub !== "logs";
    });
  }

  private isFlagValue(argv: string[], i: number): boolean {
    return ["-p", "-f", "--project-directory"].includes(argv[i - 1]);
  }

  /**
   * The next command `match` accepts answers only after the returned release
   * is called. Its answer is worked out when it is called, as a real command
   * would have read the state then.
   */
  delay(match: (argv: string[]) => boolean): () => void {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.delays.push({ match, gate });
    return release;
  }

  async run(argv: string[], options?: RunOptions): Promise<CommandOutput> {
    this.calls.push([...argv]);
    this.options.push(options);
    this.onRun?.(argv);
    const answer = this.answer(argv, options);
    const delayed = this.delays.findIndex((d) => d.match(argv));
    if (delayed >= 0) {
      const [{ gate }] = this.delays.splice(delayed, 1);
      const result = await answer;
      await gate;
      return result;
    }
    return answer;
  }

  private answer(argv: string[], options?: RunOptions): CommandOutput | Promise<CommandOutput> {
    if (argv[0] === "git") return this.gitCommand(argv);
    if (argv[0] !== "docker") return ok(); // a project script (prepare_cmd, fetch_cmd)
    if (this.broken !== null) return { code: -1, stdout: "", stderr: this.broken };
    if (this.hangBuilds && argv[1] === "compose" && argv.includes("build")) {
      return new Promise((resolve) => {
        const killed = () => resolve({ code: -1, stdout: "", stderr: "The operation was aborted" });
        if (options?.signal?.aborted) killed();
        options?.signal?.addEventListener("abort", killed, { once: true });
      });
    }
    switch (argv[1]) {
      case "compose":
        return this.compose(argv.slice(2));
      case "inspect":
        return this.inspect(argv.slice(2));
      case "tag":
        return this.tag(argv[2], argv[3]);
      case "update":
        return this.update(argv.slice(2));
      default:
        return fail(`docker: '${argv[1]}' is not a docker command.`);
    }
  }

  private gitCommand(argv: string[]): CommandOutput {
    const sub = argv[3];
    if (sub === "rev-parse") return ok(`${this.git.head}\n`);
    if (sub === "diff") {
      const files = this.git.diffs.get(`${argv[5]}..${argv[6]}`);
      return files ? ok(files.map((f) => `${f}\n`).join("")) : fail(`fatal: bad revision '${argv[5]}'`, 128);
    }
    return ok();
  }

  private compose(args: string[]): CommandOutput {
    let i = 0;
    let project = "";
    while (i < args.length && args[i].startsWith("-")) {
      if (!["-p", "-f", "--project-directory"].includes(args[i])) return fail(`unknown flag: ${args[i]}`);
      if (args[i] === "-p") project = args[i + 1];
      i += 2;
    }
    if (project !== this.project) return fail(`no configuration file provided: not found`);
    const command = args[i];
    const flags = new Set<string>();
    const names: string[] = [];
    let format = "";
    let tailLines = Infinity;
    for (let j = i + 1; j < args.length; j++) {
      if (args[j] === "--format") format = args[++j];
      else if (args[j] === "--tail") tailLines = Number(args[++j]);
      else if (args[j].startsWith("-")) flags.add(args[j]);
      else names.push(args[j]);
    }
    for (const name of names) {
      if (!this.services[name]) return fail(`no such service: ${name}`);
    }
    switch (command) {
      case "ps":
        if (format !== "json" || !flags.has("--all")) return fail("this fake answers ps --all --format json only");
        return ok(this.psOutput());
      case "logs": {
        const c = names.length === 1 ? this.container(names[0]) : undefined;
        return ok(c ? `${c.logs.slice(-tailLines).join("\n")}\n` : "");
      }
      case "up":
        if (!flags.has("-d")) return fail("this fake answers up -d only");
        for (const name of names) {
          const error = this.startService(name, flags.has("--no-build"), flags.has("--force-recreate"));
          if (error) return fail(error);
        }
        return ok();
      case "stop":
        for (const c of this.containers.filter((c) => names.includes(c.service))) {
          c.state = "exited";
          c.exitCode = 0;
        }
        return ok();
      case "restart":
        for (const c of this.containers.filter((c) => names.includes(c.service))) this.start(c);
        return ok();
      case "down":
        this.containers = [];
        return ok();
      case "build":
        for (const name of names) {
          const kind = this.nextBuild[name] ?? "good";
          delete this.nextBuild[name];
          if (kind === "fail") {
            return fail('failed to solve: process "/bin/sh -c make build" did not complete successfully: exit code: 2');
          }
          this.tags.set(normalise(this.services[name].imageRef), this.newImage(kind === "broken"));
        }
        return ok();
      default:
        return fail(`unknown docker command: "compose ${command}"`);
    }
  }

  private startService(name: string, noBuild: boolean, force = false): string | null {
    const service = this.services[name];
    let image = this.imageOf(name);
    if (!image) {
      if (noBuild) return `pull access denied for ${service.imageRef}`;
      image = this.newImage(false);
      this.tags.set(normalise(service.imageRef), image);
    }
    let c = this.container(name);
    if (c && (force || c.imageId !== image)) {
      this.containers = this.containers.filter((x) => x !== c);
      c = undefined;
    }
    if (!c) {
      c = {
        id: hex(`container-${this.counter++}`),
        name: service.containerName ?? `${this.project}-${name}-1`,
        service: name,
        state: "created",
        exitCode: 0,
        restartCount: 0,
        imageId: image,
        imageRef: service.imageRef,
        restartPolicy: "unless-stopped",
        logs: [],
      };
      this.containers.push(c);
    }
    if (c.state !== "running") this.start(c);
    return null;
  }

  private start(c: FakeContainer): void {
    c.state = "running";
    c.exitCode = 0;
    c.logs.push(this.images.get(c.imageId)?.broken ? "FATAL: missing table \"orders\"" : "listening");
  }

  private health(c: FakeContainer): string {
    if (!this.services[c.service].healthcheck || c.state !== "running") return "";
    return this.images.get(c.imageId)?.broken ? "unhealthy" : "healthy";
  }

  private statusText(c: FakeContainer): string {
    const health = this.health(c);
    switch (c.state) {
      case "running":
        return `Up 2 minutes${health ? ` (${health})` : ""}`;
      case "restarting":
        return `Restarting (${c.exitCode}) 3 seconds ago`;
      case "exited":
        return `Exited (${c.exitCode}) 1 minute ago`;
      case "created":
        return "Created";
    }
  }

  /** `docker compose ps --all --format json`, with the fields real Compose prints */
  private psOutput(): string {
    const entries = this.containers.map((c) => ({
      Command: '"docker-entrypoint.…"',
      CreatedAt: "2026-03-02 11:50:00 +0000 UTC",
      ExitCode: c.exitCode,
      Health: this.health(c),
      ID: c.id.slice(0, 12),
      Image: c.imageRef,
      Labels: `com.docker.compose.project=${this.project},com.docker.compose.service=${c.service},com.docker.compose.oneoff=False`,
      LocalVolumes: "0",
      Mounts: "",
      Name: c.name,
      Names: c.name,
      Networks: `${this.project}_default`,
      Ports: "",
      Project: this.project,
      Publishers: [],
      RunningFor: "10 minutes ago",
      Service: c.service,
      Size: "0B",
      State: c.state,
      Status: this.statusText(c),
    }));
    if (this.arrayFormat) return `${JSON.stringify(entries)}\n`;
    return entries.map((e) => `${JSON.stringify(e)}\n`).join("");
  }

  /**
   * `docker inspect <id>...`: the containers found, and exit 1 naming any
   * that aren't. `docker inspect --format {{.RestartCount}} <name>` (the
   * watchdog's own sampler) prints the count.
   */
  private inspect(ids: string[]): CommandOutput {
    if (ids[0] === "--format") {
      const c = this.containers.find((x) => x.name === ids[2] || x.id.startsWith(ids[2]));
      if (!c) return fail(`Error: No such object: ${ids[2]}`);
      if (ids[1] !== "{{.RestartCount}}") return fail(`this fake answers --format {{.RestartCount}} only`);
      return ok(`${c.restartCount}\n`);
    }
    const found: unknown[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const c = this.containers.find((x) => x.id.startsWith(id));
      if (!c) {
        missing.push(id);
        continue;
      }
      const health = this.health(c);
      found.push({
        Id: c.id,
        Created: "2026-03-02T11:50:00.000000000Z",
        Name: `/${c.name}`,
        RestartCount: c.restartCount,
        State: {
          Status: c.state,
          Running: c.state === "running",
          Paused: false,
          Restarting: c.state === "restarting",
          OOMKilled: false,
          Dead: false,
          Pid: c.state === "running" ? 4242 : 0,
          ExitCode: c.exitCode,
          Error: "",
          StartedAt: "2026-03-02T11:58:00.000000000Z",
          FinishedAt: "0001-01-01T00:00:00Z",
          ...(this.services[c.service].healthcheck
            ? {
                Health: {
                  Status: health || "unhealthy",
                  FailingStreak: health === "healthy" ? 0 : 3,
                  Log: [
                    {
                      Start: "2026-03-02T11:59:00.000000000Z",
                      End: "2026-03-02T11:59:01.000000000Z",
                      ExitCode: health === "healthy" ? 0 : 1,
                      Output: health === "healthy" ? "" : "curl: (7) Failed to connect to localhost port 8080",
                    },
                  ],
                },
              }
            : {}),
        },
        Image: c.imageId,
        Config: { Image: c.imageRef, Labels: { "com.docker.compose.service": c.service } },
        HostConfig: { RestartPolicy: { Name: c.restartPolicy, MaximumRetryCount: 0 } },
      });
    }
    return {
      code: missing.length > 0 ? 1 : 0,
      stdout: `${JSON.stringify(found, null, 4)}\n`,
      stderr: missing.map((id) => `Error: No such object: ${id}\n`).join(""),
    };
  }

  private tag(source: string, target: string): CommandOutput {
    const id = source.startsWith("sha256:") ? (this.images.has(source) ? source : undefined) : this.tags.get(normalise(source));
    if (!id) return fail(`Error response from daemon: No such image: ${source}`);
    this.tags.set(normalise(target), id);
    return ok();
  }

  private update(args: string[]): CommandOutput {
    const name = args[args.length - 1];
    const c = this.containers.find((x) => x.name === name);
    if (!c) return fail(`Error response from daemon: No such container: ${name}`);
    if (args.includes("--restart=no")) {
      c.restartPolicy = "no";
      if (c.state === "restarting") c.state = "exited";
    }
    return ok(`${name}\n`);
  }
}
