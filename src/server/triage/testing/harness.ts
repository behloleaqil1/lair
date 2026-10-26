/**
 * Test harness for triage: only the system boundary is fake (a command
 * runner that records argv, a clock, and git). The store is the real SQLite
 * store, files are real in a temp dir, signatures are real Ed25519 ones, and
 * everything else is production code: the manager, the services, the
 * parsers and the adapters. Not part of the server build (src/**\/testing).
 */
import { createHash } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectConfig } from "../../../shared/types.js";
import type { GateResult, GateStepResult, SignedGateResult } from "../../../shared/policy-types.js";
import { EventBus } from "../../core/event-bus.js";
import { generateNodeKeyPair, signGateResult } from "../../gates/signature.js";
import { NodeFileSystem, type Clock, type CommandOutput, type CommandRunner } from "../../watchdog/probes.js";
import type { CommitInfo, GitProbe } from "../git.js";
import { TriageManager } from "../manager.js";
import type { IngestInput, IngestOutcome, TriageService } from "../service.js";

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

interface Handler {
  match: (argv: string[]) => boolean;
  reply: (argv: string[]) => CommandOutput | Promise<CommandOutput>;
}

/** Records every argv; replies like the project's real command would (it may call back into the server). */
export class FakeRunner implements CommandRunner {
  calls: string[][] = [];
  private handlers: Handler[] = [];
  when(match: (argv: string[]) => boolean, reply: (argv: string[]) => CommandOutput | Promise<CommandOutput>): void {
    this.handlers.unshift({ match, reply });
  }
  async run(argv: string[]): Promise<CommandOutput> {
    this.calls.push([...argv]);
    const handler = this.handlers.find((h) => h.match(argv));
    return handler ? handler.reply(argv) : { code: 0, stdout: "", stderr: "" };
  }
  callsTo(program: string): string[][] {
    return this.calls.filter((c) => c[0] === program);
  }
}

/** A repository's history: the default branch's first-parent commits, each commit's parents, and branch bases. */
export class FakeGit implements GitProbe {
  /** Oldest first */
  main: string[] = [];
  commits = new Map<string, CommitInfo>();
  changed = new Map<string, string[]>();
  /** Where a change's commit left the default branch */
  bases = new Map<string, string>();
  calls: string[] = [];

  commitOnMain(sha: string, options: { subject?: string; body?: string; pr?: string } = {}): void {
    const parent = this.main[this.main.length - 1];
    this.main.push(sha);
    this.commits.set(sha, {
      sha,
      parents: [...(parent ? [parent] : []), ...(options.pr ? [options.pr] : [])],
      subject: options.subject ?? `commit ${sha.slice(0, 7)}`,
      body: options.body ?? "",
    });
  }

  async firstParentRange(from: string, to: string): Promise<string[]> {
    this.calls.push(`range ${from}..${to}`);
    const start = this.main.indexOf(from);
    const end = this.main.indexOf(to);
    if (start < 0 || end < 0) throw new Error(`fatal: bad revision '${from}..${to}'`);
    return this.main.slice(start + 1, end + 1);
  }

  async commit(sha: string): Promise<CommitInfo> {
    this.calls.push(`show ${sha}`);
    const info = this.commits.get(sha);
    if (!info) throw new Error(`fatal: bad object ${sha}`);
    return info;
  }

  async changedFiles(base: string, head: string): Promise<string[]> {
    this.calls.push(`diff ${base}...${head}`);
    return this.changed.get(`${base}...${head}`) ?? [];
  }

  async mergeBase(sha: string, branch: string): Promise<string | null> {
    this.calls.push(`merge-base ${sha} ${branch}`);
    if (this.main.includes(sha)) return sha;
    return this.bases.get(sha) ?? null;
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    this.calls.push(`is-ancestor ${ancestor} ${descendant}`);
    const at = this.main.indexOf(descendant);
    return at >= 0 && this.main.indexOf(ancestor) >= 0 && this.main.indexOf(ancestor) <= at;
  }
}

/** A 40-character sha made from a short label, e.g. sha("a1") */
export function sha(label: string): string {
  const hex = Buffer.from(label).toString("hex");
  return (hex + "0".repeat(40)).slice(0, 40);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function fixture(name: string): string {
  return readFileSync(join(process.cwd(), "fixtures", "triage", name), "utf-8");
}

export function step(name: string, status: GateStepResult["status"], output = "", exitCode?: number): GateStepResult {
  return {
    name,
    status,
    exitCode: exitCode ?? (status === "passed" ? 0 : status === "failed" ? 1 : undefined),
    output,
  };
}

let gateRuns = 0;

/** A JUnit report in which these tests passed. */
export function junitPassing(tests: { suite: string; name: string }[]): string {
  return `<testsuites>${tests
    .map((t) => `<testsuite name="${t.suite}"><testcase classname="${t.suite}" name="${t.name}"/></testsuite>`)
    .join("")}</testsuites>`;
}

/** A gate result; every run gets its own id unless one is given (ids are unique per project). */
export function gate(options: {
  id?: string;
  sha: string;
  branch: string;
  status?: GateResult["status"];
  steps?: GateStepResult[];
  pipelineId?: string;
  nodeId?: string;
  reports?: GateResult["reports"];
}): GateResult {
  const steps = options.steps ?? [step("test", options.status === "passed" ? "passed" : "failed")];
  const status = options.status ?? (steps.some((s) => s.status === "failed" || s.status === "timed_out") ? "failed" : "passed");
  return {
    id: options.id ?? `gate-${options.sha.slice(0, 6)}-${++gateRuns}`,
    pipelineId: options.pipelineId ?? "example",
    commitSha: options.sha,
    branch: options.branch,
    projectId: "demo",
    nodeId: options.nodeId ?? "local",
    status,
    steps,
    selectedSteps: steps.map((s) => s.name),
    durationMs: 1000,
    startedAt: new Date(NOW).toISOString(),
    completedAt: new Date(NOW).toISOString(),
    pipelineVersion: "00000001",
    ...(options.reports ? { reports: options.reports } : {}),
  };
}

/** A node with a real Ed25519 key pair; its public key file is what triage.trusted_nodes names. */
export interface TestNode {
  id: string;
  publicKeyFile: string;
  sign(result: GateResult): SignedGateResult;
}

export function trustedNode(dir: string, id = "ci-1"): TestNode {
  const keys = generateNodeKeyPair(id);
  const publicKeyFile = join(dir, `${id}.pub.pem`);
  writeFileSync(publicKeyFile, keys.publicKey);
  return { id, publicKeyFile, sign: (result) => signGateResult(result, keys.privateKey, keys.publicKey) };
}

export interface Harness {
  manager: TriageManager;
  service: TriageService;
  runner: FakeRunner;
  clock: FakeClock;
  git: FakeGit;
  events: EventBus;
  dir: string;
  config: ProjectConfig;
  /** An in-process (trusted) result, as the gates module hands one over */
  ingest(input: Omit<IngestInput, "trust">): Promise<IngestOutcome>;
  inbox(): string;
  cleanup(): Promise<void>;
}

export function projectConfig(dir: string, triage: Record<string, unknown>, extra: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "Demo",
    repo: dir,
    github: "example/demo",
    queue_file: join(dir, "queue.md"),
    agents_dir: join(dir, "agents"),
    gates_dir: join(dir, "gates"),
    machines: {},
    inbox_file: join(dir, "inbox.md"),
    triage,
    ...extra,
  };
}

/** A manager with one project, "demo", whose triage block is `triage` (or built from the temp dir). */
export function harness(
  triage: Record<string, unknown> | ((dir: string) => Record<string, unknown>),
  extra: Partial<ProjectConfig> = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), "lair-triage-"));
  const runner = new FakeRunner();
  const clock = new FakeClock();
  const git = new FakeGit();
  const events = new EventBus();
  const config = projectConfig(dir, typeof triage === "function" ? triage(dir) : triage, extra);
  const manager = new TriageManager({
    dbPath: ":memory:",
    probes: { runner, clock, fs: new NodeFileSystem(), git: () => git },
    events,
  });
  manager.load([{ name: "demo", config }]);
  const service = manager.get("demo");
  if (!service) throw new Error(`triage did not start for the demo project: ${JSON.stringify(manager.status("demo").errors)}`);
  return {
    manager,
    service,
    runner,
    clock,
    git,
    events,
    dir,
    config,
    ingest: (input) => service.ingest({ ...input, trust: "trusted" }),
    inbox: () => (existsSync(join(dir, "inbox.md")) ? readFileSync(join(dir, "inbox.md"), "utf-8") : ""),
    cleanup: async () => {
      await manager.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The triage block most tests use: act mode with every command set. */
export function actingTriage(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    mode: "act",
    commands: {
      recheck: ["./bin/recheck", "--sha={sha}", "--request={request}", "--steps={steps}", "{classes}"],
      notify_agent: ["./bin/notify", "{agent}", "{message}"],
      create_task: ["./bin/task", "{kind}", "{title}"],
      open_revert: ["./bin/revert", "{sha}", "--incident={incident}"],
    },
    ...extra,
  };
}
