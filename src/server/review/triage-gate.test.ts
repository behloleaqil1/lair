/**
 * Gate results from an external gate queue reach the merge gate through
 * triage (review.merge.gate.from_triage): mountTriage() and the review
 * routes on one Fastify instance, with the triage manager handed the
 * ReviewManager as src/server/index.ts wires them. A signed result is
 * POSTed to triage only; the PR's "Gate at head" is read from review. Only
 * the git host's API, git, the clock and triage's command runner are
 * stand-ins; the signatures are real Ed25519 ones.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { GateResult } from "../../shared/policy-types.js";
import { HumanAuth } from "../human-auth/index.js";
import { NodeFileSystem } from "../watchdog/probes.js";
import { mountTriage, type TriageManager } from "../triage/index.js";
import {
  FakeClock as TriageClock,
  FakeGit as TriageGit,
  FakeRunner,
  gate,
  projectConfig,
  step,
  trustedNode,
  type TestNode,
} from "../triage/testing/harness.js";
import { ReviewManager } from "./service.js";
import { registerReviewRoutes } from "./routes.js";
import { FakeClock, FakeGit, FakeRemote, fakeGitHubApi, type FakeFile, type Person } from "./testing/fakes.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const AGENT: Person = { name: "Fleet Agent", email: "12345+fleet@users.noreply.github.com" };
const README: FakeFile = {
  filename: "docs/usage.md",
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1,2 +1,2 @@\n # Usage\n-Old text\n+New text",
};

let app: FastifyInstance | null = null;
let triage: TriageManager | null = null;
let reviews: ReviewManager | null = null;
let auth: HumanAuth | null = null;
let dir: string | null = null;

afterEach(async () => {
  await app?.close();
  await triage?.stop();
  reviews?.close();
  auth?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  app = null;
  triage = null;
  reviews = null;
  auth = null;
  dir = null;
});

async function boot(options: { fromTriage?: boolean } = {}) {
  dir = mkdtempSync(join(tmpdir(), "lair-triage-review-"));
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir);
  // gates-1: trusted by triage and by review; gates-2: by triage only; stranger: by neither
  const node = trustedNode(dir, "gates-1");
  const other = trustedNode(dir, "gates-2");
  const stranger = trustedNode(dir, "stranger");

  const remote = new FakeRemote("example/demo");
  const base = remote.commit([], AGENT, "initial");
  remote.branches.set("main", base);
  const head = remote.commit([base], AGENT, "change");
  remote.openPull({ number: 3, title: "A change", headRef: "agent/worker-a/change", headSha: head, files: [README] });

  const config = projectConfig(
    repoDir,
    {
      enabled: true,
      trusted_nodes: [
        { id: node.id, public_key_file: node.publicKeyFile },
        { id: other.id, public_key_file: other.publicKeyFile },
      ],
    },
    {
      review: {
        enabled: true,
        authors: { branch_pattern: "agent/{agent}/**" },
        reviewers: { green: [] },
        merge: {
          gate: {
            source: "signed",
            required: ["backend"],
            // The review module's own trust: the same node's key, in its own config
            node_keys: { [node.id]: readFileSync(node.publicKeyFile, "utf-8") },
            pipeline_versions: { backend: "00000001" },
            from_triage: options.fromTriage ?? true,
          },
          method: "local",
          work_dir: join(dir, "work"),
        },
      },
    },
  );

  reviews = new ReviewManager({
    dbPath: ":memory:",
    clock: new FakeClock(NOW),
    git: new FakeGit(remote),
    fetch: fakeGitHubApi(remote),
    env: {},
    cwd: dir,
    autoRequestMs: 0,
  });
  reviews.load([{ name: "demo", config }]);
  if (!reviews.get("demo")) throw new Error(`reviews are off: ${reviews.info("demo").errors.join("; ")}`);

  auth = HumanAuth.open({ tokenPath: join(dir, "owner.token"), dbPath: ":memory:" });
  app = Fastify();
  triage = await mountTriage(app, {
    dbPath: ":memory:",
    probes: { runner: new FakeRunner(), clock: new TriageClock(), fs: new NodeFileSystem(), git: () => new TriageGit() },
    projects: [{ name: "demo", config }],
    defaultProject: () => "demo",
    owner: auth,
    review: reviews,
  });
  await registerReviewRoutes(app, reviews, () => "demo", auth);
  await app.ready();
  if (!triage.get("demo")) throw new Error(`triage is off: ${triage.status("demo").errors.join("; ")}`);
  return { app, reviews, node, other, stranger, base, head };
}

/** A passed gate of pipeline `backend` at `sha`, as an external gate queue's runner reports it. */
function passedAt(sha: string, id: string, extra: Partial<GateResult> = {}): GateResult {
  return {
    ...gate({ id, sha, branch: "agent/worker-a/change", status: "passed", steps: [step("test", "passed")], pipelineId: "backend" }),
    ...extra,
  };
}

/** What `lair-node gate-result submit` sends: the result signed by `signer`, no reports. */
function submission(signer: TestNode, result: GateResult) {
  return { signed: signer.sign({ ...result, nodeId: signer.id, reports: [] }), reports: [] };
}

async function postToTriage(server: FastifyInstance, payload: unknown) {
  return server.inject({ method: "POST", url: "/api/triage/results", payload: payload as Record<string, unknown> });
}

async function gateAtHead(server: FastifyInstance) {
  const res = await server.inject({ url: "/api/review/prs/3" });
  expect(res.statusCode).toBe(200);
  const status = res.json().data as {
    canMerge: boolean;
    gate: { name: string; status: string; sha: string; detail: string }[];
    conditions: { id: string; ok: boolean; detail: string }[];
  };
  return { status, gate: status.gate[0], condition: status.conditions.find((c) => c.id === "gate")! };
}

describe("signed results through triage reach the merge gate (review.merge.gate.from_triage)", () => {
  it("a result triage accepts makes the PR's Gate at head pass; the same result again changes nothing", async () => {
    const { app, reviews, node, head } = await boot();
    const before = await gateAtHead(app);
    expect(before.gate).toMatchObject({ name: "backend", status: "missing" });
    expect(before.condition.ok).toBe(false);

    const sent = submission(node, passedAt(head, "run-1"));
    const accepted = await postToTriage(app, sent);
    expect(accepted.statusCode).toBe(200);

    const after = await gateAtHead(app);
    expect(after.gate).toMatchObject({ name: "backend", status: "passed", sha: head, detail: "signed result run-1" });
    expect(after.condition).toMatchObject({ ok: true, detail: `backend passed at ${head.slice(0, 7)}` });
    expect(after.status.canMerge).toBe(true);

    // A second delivery: triage takes a result id once, and review already has it
    expect((await postToTriage(app, sent)).statusCode).toBe(409);
    expect(reviews.acceptSignedResult("demo", sent.signed)).toEqual({ stored: false, detail: "already stored" });
    expect((await gateAtHead(app)).gate).toMatchObject({ status: "passed", detail: "signed result run-1" });
  });

  it("a result triage refuses never reaches review: a bad signature, or a node triage doesn't trust", async () => {
    const { app, node, stranger, head } = await boot();
    const forged = submission(node, passedAt(head, "run-2"));
    forged.signed.result.id = "run-3";
    const badSignature = await postToTriage(app, forged);
    expect(badSignature.statusCode).toBe(403);
    expect(badSignature.json().error).toContain("signature does not verify");

    const untrusted = await postToTriage(app, submission(stranger, passedAt(head, "run-4")));
    expect(untrusted.statusCode).toBe(403);
    expect(untrusted.json().error).toContain("not trusted");

    // Nothing was stored for review: a stored (and rejected) result would show as failed, not missing
    const { gate: result, status } = await gateAtHead(app);
    expect(result).toMatchObject({ status: "missing", detail: "no signed result at this commit" });
    expect(status.canMerge).toBe(false);
  });

  it("review keeps its own checks: its own node keys, the pipeline version, and the head commit", async () => {
    const { app, node, other, base, head } = await boot();
    // Triage trusts gates-2; review's node_keys don't list it
    expect((await postToTriage(app, submission(other, passedAt(head, "run-5")))).statusCode).toBe(200);
    // Signed by a node both trust, for a pipeline version review doesn't expect
    expect((await postToTriage(app, submission(node, passedAt(head, "run-6", { pipelineVersion: "00000002" })))).statusCode).toBe(200);
    // A pass at another commit
    expect((await postToTriage(app, submission(node, passedAt(base, "run-7")))).statusCode).toBe(200);

    const refused = await gateAtHead(app);
    expect(refused.gate.status).toBe("failed");
    expect(refused.gate.detail).toContain("Unknown node for gate run-5: gates-2");
    expect(refused.gate.detail).toContain("Gate run-6 ran pipeline version 00000002, expected 00000001");
    expect(refused.gate.detail).not.toContain("run-7");
    expect(refused.status.canMerge).toBe(false);

    // A result review can trust still counts after them
    expect((await postToTriage(app, submission(node, passedAt(head, "run-8")))).statusCode).toBe(200);
    expect((await gateAtHead(app)).gate).toMatchObject({ status: "passed", detail: "signed result run-8" });
  });

  it("with from_triage off (the default), triage still takes the result and the merge gate doesn't", async () => {
    const { app, node, head } = await boot({ fromTriage: false });
    expect((await postToTriage(app, submission(node, passedAt(head, "run-9")))).statusCode).toBe(200);
    expect((await gateAtHead(app)).gate).toMatchObject({ status: "missing" });
  });
});
