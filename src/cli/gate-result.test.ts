/**
 * lair-node keygen and gate-result submit, end to end. Keys come from the
 * keygen command; results are built and signed by the submit command (with
 * the gates module's own signing code) and POSTed over real HTTP to a real
 * Fastify instance with triage mounted as the server mounts it, the
 * keygen'd public key in triage.trusted_nodes. Only triage's command runner,
 * clock and git are fake. The lair-node dispatch runs as a real process.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { verifySignedGateResult } from "../server/gates/signature.js";
import { mountTriage, type TriageManager } from "../server/triage/index.js";
import { parseJUnit } from "../server/triage/parsers/index.js";
import { FakeClock, FakeGit, FakeRunner, fixture, projectConfig, sha, sha256 } from "../server/triage/testing/harness.js";
import { NodeFileSystem } from "../server/watchdog/probes.js";
import { EXIT, gateResultCommand, keygenCommand, postSignedResult, type CliIo, type SubmitBody } from "./gate-result.js";

let dir: string | null = null;
let app: FastifyInstance | null = null;
let manager: TriageManager | null = null;

afterEach(async () => {
  await app?.close();
  await manager?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
  app = null;
  manager = null;
  dir = null;
});

function tempDir(): string {
  dir = mkdtempSync(join(tmpdir(), "lair-gate-result-"));
  return dir;
}

class Capture implements CliIo {
  stdout = "";
  stderr = "";
  out(text: string): void {
    this.stdout += text;
  }
  err(text: string): void {
    this.stderr += text;
  }
}

const SHA = sha("c1");
const STARTED = "2026-03-02T11:58:00.000Z";
const FINISHED = "2026-03-02T12:00:00.000Z";

function keygen(path: string): void {
  const io = new Capture();
  expect(keygenCommand(["--out", path], io), io.stderr).toBe(EXIT.ok);
}

/** What a gate runner passes for a failed run: lint passed, test failed. */
function runFlags(root: string, extra: string[] = []): string[] {
  return [
    "--key", join(root, "keys", "gates"),
    "--node", "gates-1",
    "--project", "demo",
    "--id", "run-1",
    "--pipeline", "backend",
    "--sha", SHA,
    "--branch", "feat/orders",
    "--status", "failed",
    "--step", "lint:0:12000",
    "--step", "test:1:95000",
    "--started", STARTED,
    "--finished", FINISHED,
    ...extra,
  ];
}

async function submit(argv: string[]): Promise<{ code: number; io: Capture }> {
  const io = new Capture();
  const code = await gateResultCommand(["submit", ...argv], io);
  return { code, io };
}

/** A Lair server with triage on for "demo", trusting node gates-1 (its key from keygen). */
async function boot(root: string) {
  const repo = join(root, "repo");
  mkdirSync(repo);
  keygen(join(root, "keys", "gates"));
  const fastify = Fastify();
  app = fastify;
  const triage = await mountTriage(fastify, {
    dbPath: ":memory:",
    probes: { runner: new FakeRunner(), clock: new FakeClock(), fs: new NodeFileSystem(), git: () => new FakeGit() },
    projects: [
      {
        name: "demo",
        config: projectConfig(repo, {
          enabled: true,
          trusted_nodes: [{ id: "gates-1", public_key_file: join(root, "keys", "gates.pub") }],
        }),
      },
    ],
    defaultProject: () => "demo",
  });
  manager = triage;
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  const address = fastify.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server: `http://127.0.0.1:${port}`, manager: triage };
}

function junit(suite: string, failing = false): string {
  const failure = failing ? `<failure type="java.lang.AssertionError" message="expected 2">java.lang.AssertionError: expected 2</failure>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="com.example.shop.${suite}" tests="1"><testcase classname="com.example.shop.${suite}" name="works()">${failure}</testcase></testsuite>\n`;
}

describe("lair-node keygen", () => {
  it("writes an Ed25519 pair, the private key 0600, and never overwrites one", () => {
    const root = tempDir();
    const key = join(root, "keys", "gates");
    const io = new Capture();
    expect(keygenCommand(["--out", key], io)).toBe(EXIT.ok);
    expect(io.stdout).toContain(`public_key_file: ${key}.pub`);
    expect(readFileSync(key, "utf-8")).toContain("BEGIN PRIVATE KEY");
    expect(readFileSync(`${key}.pub`, "utf-8")).toContain("BEGIN PUBLIC KEY");
    if (process.platform !== "win32") expect(statSync(key).mode & 0o777).toBe(0o600);

    const before = readFileSync(key, "utf-8");
    const again = new Capture();
    expect(keygenCommand(["--out", key], again)).toBe(EXIT.refused);
    expect(again.stderr).toContain("is never overwritten");
    expect(readFileSync(key, "utf-8")).toBe(before);

    expect(keygenCommand([], new Capture())).toBe(EXIT.usage);
    expect(keygenCommand(["--out", key, "--bits", "4096"], new Capture())).toBe(EXIT.usage);
  });
});

describe("lair-node gate-result submit", () => {
  it("builds the GateResult from flags, digests its reports and signs it: verifySignedGateResult accepts it", async () => {
    const root = tempDir();
    keygen(join(root, "keys", "gates"));
    const xml = fixture("junit-context-failure.xml");
    writeFileSync(join(root, "TEST-OrderApiIT.xml"), xml);
    writeFileSync(join(root, "test.log"), "> Task :test FAILED\n");
    const { code, io } = await submit(
      runFlags(root, [
        "--report", join(root, "TEST-OrderApiIT.xml"),
        "--report-step", "test",
        "--output", `test=${join(root, "test.log")}`,
        "--pipeline-version", "v7",
        "--dry-run",
      ]),
    );
    expect(io.stderr).toBe("");
    expect(code).toBe(EXIT.ok);
    const body = JSON.parse(io.stdout) as SubmitBody;
    const publicKey = readFileSync(join(root, "keys", "gates.pub"), "utf-8");
    expect(verifySignedGateResult(body.signed, publicKey)).toEqual({ valid: true, errors: [] });
    expect(body.signed.result).toMatchObject({
      id: "run-1",
      pipelineId: "backend",
      commitSha: SHA,
      branch: "feat/orders",
      projectId: "demo",
      nodeId: "gates-1",
      status: "failed",
      selectedSteps: ["lint", "test"],
      durationMs: 120_000,
      startedAt: STARTED,
      completedAt: FINISHED,
      pipelineVersion: "v7",
      reports: [{ name: "TEST-OrderApiIT.xml", step: "test", sha256: sha256(xml) }],
    });
    expect(body.signed.result.steps).toEqual([
      { name: "lint", status: "passed", exitCode: 0, durationMs: 12_000 },
      { name: "test", status: "failed", exitCode: 1, durationMs: 95_000, output: "> Task :test FAILED\n" },
    ]);
    expect(body.reports).toEqual([{ name: "TEST-OrderApiIT.xml", content: xml }]);
    expect(body.recheckId).toBeUndefined();

    // Anything changed after signing fails the check
    const forged = { ...body.signed, result: { ...body.signed.result, status: "passed" as const } };
    expect(verifySignedGateResult(forged, publicKey).valid).toBe(false);
  });

  it("reads the result from a JSON file, flags overriding it, and takes skipped and timed-out steps", async () => {
    const root = tempDir();
    keygen(join(root, "keys", "gates"));
    mkdirSync(join(root, "out"));
    writeFileSync(join(root, "out", "TEST-A.xml"), junit("ATest"));
    writeFileSync(
      join(root, "out", "result.json"),
      JSON.stringify({
        id: "from-file",
        pipelineId: "frontend",
        commitSha: SHA.toUpperCase(),
        branch: "main",
        status: "failed",
        steps: [
          { name: "lint", exitCode: 0, durationMs: 1000 },
          { name: "unit", status: "timed_out", durationMs: 60_000 },
          { name: "e2e", status: "skipped" },
        ],
        startedAt: 1772452680,
        completedAt: "2026-03-02T12:00:00Z",
        reports: [{ path: "TEST-A.xml", step: "unit" }],
      }),
    );
    const { code, io } = await submit([
      "--key", join(root, "keys", "gates"),
      "--node", "gates-1",
      "--project", "demo",
      "--result", join(root, "out", "result.json"),
      "--id", "overridden",
      "--recheck", "0b6f3a52-6d8e-4b8f-9b0e-2b8f7c0d1e2f",
      "--dry-run",
    ]);
    expect(io.stderr).toBe("");
    expect(code).toBe(EXIT.ok);
    const body = JSON.parse(io.stdout) as SubmitBody;
    expect(body.signed.result).toMatchObject({
      id: "overridden",
      pipelineId: "frontend",
      commitSha: SHA,
      startedAt: "2026-03-02T11:58:00.000Z",
      durationMs: 120_000,
      steps: [
        { name: "lint", status: "passed", exitCode: 0 },
        { name: "unit", status: "timed_out" },
        { name: "e2e", status: "skipped" },
      ],
      reports: [{ name: "TEST-A.xml", step: "unit", sha256: sha256(junit("ATest")) }],
    });
    expect(body.recheckId).toBe("0b6f3a52-6d8e-4b8f-9b0e-2b8f7c0d1e2f");
    expect(verifySignedGateResult(body.signed, readFileSync(join(root, "keys", "gates.pub"), "utf-8")).valid).toBe(true);
  });

  it("is accepted by triage from the trusted node, which reads the JUnit report and the step's output; a repeat is refused", async () => {
    const root = tempDir();
    const { server, manager } = await boot(root);
    writeFileSync(join(root, "TEST-OrderApiIT.xml"), fixture("junit-context-failure.xml"));
    writeFileSync(join(root, "test.log"), fixture("gradle-test.txt"));
    const flags = runFlags(root, [
      "--server", server,
      "--report", join(root, "TEST-OrderApiIT.xml"),
      "--report-step", "test",
      "--output", `test=${join(root, "test.log")}`,
    ]);
    const { code, io } = await submit(flags);
    expect(io.stderr).toBe("");
    expect(code).toBe(EXIT.ok);
    expect(io.stdout).toMatch(/^Accepted run-1: triage record [0-9a-f-]{36} \(failed/);

    const [record] = manager.getStore()!.listRecords("demo");
    expect(record).toMatchObject({ gateId: "run-1", pipelineId: "backend", trust: "signed", sha: SHA, status: "failed", failedSteps: ["test"] });
    const kinds = record.causes.map((c) => `${c.cause.step}:${c.cause.kind}:${c.cause.parser}`);
    // The report's context failure (one cause for its four tests), and the assertion only the console has
    expect(kinds).toContain("test:context:junit");
    expect(kinds).toContain("test:test:gradle");
    const context = record.causes.find((c) => c.cause.parser === "junit")!;
    expect(context.cause.testCount).toBe(4);
    expect(context.verdict.class).toBe("infra");

    const repeat = await submit(flags);
    expect(repeat.code).toBe(EXIT.refused);
    expect(repeat.io.stderr).toContain("was already received");
  });

  it("bundles more JUnit files than a result takes, and every test in them reaches triage", async () => {
    const root = tempDir();
    const { server, manager } = await boot(root);
    const reports = join(root, "test-results", "test");
    mkdirSync(reports, { recursive: true });
    mkdirSync(join(root, "test-results", "test", "binary"));
    writeFileSync(join(root, "test-results", "test", "binary", "output.bin"), "not a report");
    const suites = Array.from({ length: 60 }, (_, i) => `T${i}Test`);
    suites.forEach((suite, i) => writeFileSync(join(reports, `TEST-com.example.shop.${suite}.xml`), junit(suite, i === 7)));

    const flags = runFlags(root, ["--server", server, "--report-dir", join(root, "test-results"), "--report-step", "test"]);
    const dry = await submit([...flags, "--dry-run"]);
    expect(dry.code).toBe(EXIT.ok);
    const body = JSON.parse(dry.io.stdout) as SubmitBody;
    expect(body.reports.length).toBeLessThanOrEqual(50);
    expect(body.signed.result.reports).toEqual(body.reports.map((r) => ({ name: r.name, step: "test", sha256: sha256(r.content) })));
    const parsed = body.reports.map((r) => parseJUnit(r.content, { contextPatterns: [] }));
    expect(parsed.reduce((n, p) => n + p.passed.length, 0)).toBe(59);
    expect(parsed.flatMap((p) => p.causes.flatMap((c) => c.tests.map((t) => t.key)))).toEqual(["T7Test#works()"]);

    const { code, io } = await submit(flags);
    expect(io.stderr).toBe("");
    expect(code).toBe(EXIT.ok);
    const [record] = manager.getStore()!.listRecords("demo");
    expect(record.causes.flatMap((c) => c.cause.tests.map((t) => t.key))).toEqual(["T7Test#works()"]);
    const passedKeys = suites.filter((_, i) => i !== 7).map((s) => `${s}#works()`);
    expect(manager.getStore()!.passesAt("demo", SHA, passedKeys, 0, Number.MAX_SAFE_INTEGER, "").size).toBe(59);
  });

  it("is refused with the server's reason when signed with another key or by an untrusted node", async () => {
    const root = tempDir();
    const { server } = await boot(root);
    keygen(join(root, "keys", "rogue"));

    const wrongKey = await submit(runFlags(root, ["--server", server, "--key", join(root, "keys", "rogue")]));
    expect(wrongKey.code).toBe(EXIT.refused);
    expect(wrongKey.io.stderr).toContain("Refused (HTTP 403): The signature does not verify");

    const untrusted = await submit(runFlags(root, ["--server", server, "--node", "rogue"]));
    expect(untrusted.code).toBe(EXIT.refused);
    expect(untrusted.io.stderr).toContain("Refused (HTTP 403): Node rogue is not trusted");

    const otherProject = await submit(runFlags(root, ["--server", server, "--project", "elsewhere"]));
    expect(otherProject.code).toBe(EXIT.refused);
    expect(otherProject.io.stderr).toContain("Refused (HTTP 409)");
  });

  it("a request tampered with after signing is refused: a changed report, a changed result", async () => {
    const root = tempDir();
    const { server, manager } = await boot(root);
    writeFileSync(join(root, "TEST-OrderApiIT.xml"), fixture("junit-context-failure.xml"));
    const dry = await submit(runFlags(root, ["--server", server, "--report", join(root, "TEST-OrderApiIT.xml"), "--dry-run"]));
    expect(dry.code).toBe(EXIT.ok);
    const body = JSON.parse(dry.io.stdout) as SubmitBody;

    const editedReport: SubmitBody = { ...body, reports: [{ ...body.reports[0], content: junit("OrderApiIT") }] };
    const report = await postSignedResult(server, "demo", editedReport, 5000);
    expect(report.code).toBe(EXIT.refused);
    expect(report.message).toContain("HTTP 400");
    expect(report.message).toContain("not covered by the signed result");

    const passed = { ...body.signed.result, status: "passed" as const, steps: body.signed.result.steps.map((s) => ({ ...s, status: "passed" as const, exitCode: 0 })) };
    const editedResult: SubmitBody = { ...body, signed: { ...body.signed, result: passed } };
    const result = await postSignedResult(server, "demo", editedResult, 5000);
    expect(result.code).toBe(EXIT.refused);
    expect(result.message).toContain("HTTP 403");

    expect(manager.getStore()!.listRecords("demo")).toEqual([]);
    // The untouched request is still good
    expect((await postSignedResult(server, "demo", body, 5000)).code).toBe(EXIT.ok);
  });

  it("exits 3 when the server is unreachable", async () => {
    const root = tempDir();
    keygen(join(root, "keys", "gates"));
    const closed = Fastify();
    await closed.listen({ port: 0, host: "127.0.0.1" });
    const address = closed.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await closed.close();
    const { code, io } = await submit(runFlags(root, ["--server", `http://127.0.0.1:${port}`, "--timeout", "5"]));
    expect(code).toBe(EXIT.unreachable);
    expect(io.stderr).toContain(`Cannot reach Lair at http://127.0.0.1:${port}`);
  });

  it("exits 2 on usage errors, before anything is signed or sent", async () => {
    const root = tempDir();
    keygen(join(root, "keys", "gates"));
    writeFileSync(join(root, "a.log"), "x\n");
    writeFileSync(join(root, "not-a-key"), "x\n", { mode: 0o600 });
    const without = (flag: string) => {
      const flags = runFlags(root);
      const at = flags.indexOf(flag);
      return [...flags.slice(0, at), ...flags.slice(at + 2)];
    };
    const cases: [string[], string][] = [
      [without("--key"), "--key is required"],
      [without("--node"), "--node is required"],
      [without("--sha"), "--sha is required"],
      [runFlags(root, ["--sha", "abc1234"]), "not a full commit sha"],
      [runFlags(root, ["--status", "green"]), "--status green: one of passed, failed, error"],
      [runFlags(root, ["--step", "build"]), "--step build: expected"],
      [runFlags(root, ["--step", "lint:0"]), "step lint is given twice"],
      [runFlags(root, ["--status", "passed"]), "--status passed, but step(s) test failed"],
      [runFlags(root, ["--colour", "red"]), "--colour"],
      [runFlags(root, ["--output", `deploy=${join(root, "a.log")}`]), "--output deploy="],
      [runFlags(root, ["--output", `test=${join(root, "missing.log")}`]), "cannot read it"],
      [runFlags(root, ["--report", join(root, "missing.xml")]), "cannot read it"],
      [runFlags(root, ["--report-dir", join(root, "missing")]), "--report-dir"],
      [runFlags(root, ["--report-step", "deploy"]), "--report-step deploy: not one of the steps"],
      [runFlags(root, ["--started", "2026-03-02T12:30:00Z"]), "--finished is before --started"],
      [runFlags(root, ["--finished", "yesterday"]), "--finished yesterday: not a time"],
      [runFlags(root, ["--server", "ftp://example.test"]), "not an http(s) URL"],
      [runFlags(root, ["--timeout", "0"]), "--timeout 0"],
      [runFlags(root, ["--key", join(root, "not-a-key")]), "not a PEM private key"],
      [runFlags(root, ["--result", join(root, "a.log")]), "not JSON"],
    ];
    for (const [argv, message] of cases) {
      const { code, io } = await submit(argv);
      expect(code, message).toBe(EXIT.usage);
      expect(io.stderr, message).toContain(message);
      expect(io.stdout, message).toBe("");
    }

    if (process.platform !== "win32") {
      chmodSync(join(root, "keys", "gates"), 0o644);
      const readable = await submit(runFlags(root, ["--dry-run"]));
      expect(readable.code).toBe(EXIT.usage);
      expect(readable.io.stderr).toContain("other users can read it (mode 644)");
    }

    const none = new Capture();
    expect(await gateResultCommand([], none)).toBe(EXIT.usage);
    expect(await gateResultCommand(["send"], new Capture())).toBe(EXIT.usage);
    const help = new Capture();
    expect(await gateResultCommand(["submit", "--help"], help)).toBe(EXIT.ok);
    expect(help.stdout).toContain("Exit codes: 0 accepted, 1 refused");
  });
});

describe("the lair-node command", () => {
  it("runs keygen and gate-result submit with their exit codes", () => {
    const root = tempDir();
    const cli = (args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "cli", "node.ts"), ...args], {
        cwd: process.cwd(),
        encoding: "utf-8",
        timeout: 60_000,
        env: { ...process.env, LAIR_NODE_DAEMON: "" },
      });
    const key = join(root, "keys", "gates");
    const made = cli(["keygen", "--out", key]);
    expect(made.status, made.stderr).toBe(EXIT.ok);
    expect(existsSync(`${key}.pub`)).toBe(true);
    expect(cli(["keygen", "--out", key]).status).toBe(EXIT.refused);

    const dry = cli(["gate-result", "submit", ...runFlags(root, ["--dry-run"])]);
    expect(dry.status, dry.stderr).toBe(EXIT.ok);
    const body = JSON.parse(dry.stdout) as SubmitBody;
    expect(verifySignedGateResult(body.signed, readFileSync(`${key}.pub`, "utf-8")).valid).toBe(true);

    expect(cli(["gate-result", "submit", "--node", "gates-1"]).status).toBe(EXIT.usage);
  }, 120_000);
});
