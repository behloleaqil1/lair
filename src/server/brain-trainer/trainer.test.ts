/**
 * The brain trainer through its real entry points: the service on a real
 * Decision Inbox and a real event bus, real files for data/server.yaml and the
 * versioned models, the owner-only routes on Fastify. Only the boundary is
 * fake: the container that fits the trees (the test writes the model file the
 * real image would), and the clock.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseCases } from "../brain-bench/cases.js";
import { EventBus } from "../core/event-bus.js";
import { DecisionInbox } from "../decisions/service.js";
import { DecisionStore } from "../decisions/store.js";
import { MemorySecretStore } from "../decisions/secrets.js";
import type { RaiseDecisionInput } from "../decisions/types.js";
import { HumanAuth, OWNER_SESSION_HEADER } from "../human-auth/index.js";
import { parseBrainTrainerConfig } from "./config.js";
import { DockerTrainerContainer, trainerDockerArgs, trainerUser, validImage, type ContainerSpec, type ProcessRunner, type TrainerContainer } from "./container.js";
import { exampleFromDecision, examplesFromCases, isNotice, splitLabels } from "./examples.js";
import { mountBrainTrainer } from "./index.js";
import { parseModel, propose, probabilities } from "./model.js";
import { timeSplit } from "./split.js";
import { readOnlyDecisions, type DecisionReader } from "./shadow.js";
import { ModelStore } from "./store.js";
import { DEFAULT_PARAMS, runTraining, type TrainerSettings } from "./trainer.js";
import type { Example, RunReport, TreeModel } from "./types.js";

/** A locally built image, named by its content id */
const IMAGE = `sha256:${"a".repeat(64)}`;
const IMAGE_LINE = `  image: ${IMAGE}\n`;

const BROWSER = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
const stores: DecisionStore[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {}
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lair-brain-trainer-"));
  dirs.push(dir);
  return dir;
}

const DAY = 24 * 3600 * 1000;
const START = Date.parse("2026-03-02T08:00:00.000Z");

/** What the image would write: always favours "small" (probability about 0.88). */
const FAVOURS_SMALL = { format: "lair-gbt-1", classes: ["large", "small"], featureNames: ["options.len"], init: [2], learningRate: 0.1, stages: [], trainedOn: 1 };
const FAVOURS_LARGE = { ...FAVOURS_SMALL, init: [-2] };

class FakeContainer implements TrainerContainer {
  specs: ContainerSpec[] = [];
  inputs: { rows: { features: Record<string, number>; label: string }[]; params: unknown }[] = [];
  model: unknown = FAVOURS_SMALL;
  result: { exitCode: number; stderr: string; timedOut: boolean; cleanupFailed?: boolean } = { exitCode: 0, stderr: "", timedOut: false };
  async run(spec: ContainerSpec) {
    this.specs.push(spec);
    this.inputs.push(JSON.parse(readFileSync(join(spec.inputDir, "input.json"), "utf8")));
    if (this.result.exitCode === 0 && !this.result.timedOut) writeFileSync(join(spec.outputDir, "model.json"), JSON.stringify(this.model));
    return this.result;
  }
}

function settings(overrides: Partial<TrainerSettings> = {}): TrainerSettings {
  return { minLabels: 20, testFraction: 0.2, minTest: 3, confidenceFloor: 0.7, image: IMAGE, timeoutMs: 60_000, params: DEFAULT_PARAMS, ...overrides };
}

function caseLines(n: number, make: (i: number) => Record<string, unknown> = () => ({})): string {
  return Array.from({ length: n }, (_, i) =>
    JSON.stringify({
      id: `case-${i}`,
      kind: "other",
      module: "planner",
      evidence: { title_class: "planner_change", marker: i },
      options: [{ id: "small", label: "Small" }, { id: "large", label: "Large" }],
      label: "small",
      recommended: "small",
      at: new Date(START + i * DAY).toISOString(),
      ...make(i),
    }),
  ).join("\n");
}

function fromCases(text: string) {
  return examplesFromCases(parseCases(text));
}

describe("the time split", () => {
  const ex = (i: number, at = START + i * DAY): Example => ({
    id: `e${i}`, at: new Date(at).toISOString(), classKey: "c", kind: "other", module: "m", evidence: {}, options: [], label: "a", outcome: "unknown",
  });

  it("trains on the older decisions and tests on the newest window", () => {
    const split = timeSplit(Array.from({ length: 10 }, (_, i) => ex(i)), { testFraction: 0.3, minTest: 1 });
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.train.map((e) => e.id)).toEqual(["e0", "e1", "e2", "e3", "e4", "e5", "e6"]);
    expect(split.test.map((e) => e.id)).toEqual(["e7", "e8", "e9"]);
    expect(split.cutoffAt).toBe(new Date(START + 7 * DAY).toISOString());
  });

  it("puts decisions of the same instant on one side, so none of the test window can be trained on", () => {
    const same = START + 10 * DAY;
    const items = [ex(0), ex(1), ex(2), ex(3), ex(4, same), ex(5, same), ex(6, same), ex(7, same)];
    const split = timeSplit(items.reverse(), { testFraction: 0.25, minTest: 1 });
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.train.map((e) => e.id).sort()).toEqual(["e0", "e1", "e2", "e3"]);
    expect(split.test).toHaveLength(4);
    expect(Math.max(...split.train.map((e) => Date.parse(e.at)))).toBeLessThan(Date.parse(split.cutoffAt));
  });

  it("refuses a split with nothing older, or a test window under the minimum", () => {
    const allSame = Array.from({ length: 6 }, (_, i) => ex(i, START));
    expect(timeSplit(allSame, { testFraction: 0.2, minTest: 1 })).toMatchObject({ ok: false });
    const few = Array.from({ length: 6 }, (_, i) => ex(i));
    expect(timeSplit(few, { testFraction: 0.2, minTest: 5 })).toMatchObject({ ok: false, reason: expect.stringContaining("minimum of 5") });
    expect(timeSplit([], { testFraction: 0.2, minTest: 1 })).toMatchObject({ ok: false });
  });
});

describe("a training run", () => {
  function setup() {
    const dir = tempDir();
    const store = new ModelStore(join(dir, "brain"));
    const container = new FakeContainer();
    let t = Date.parse("2026-03-20T03:00:00.000Z");
    const now = () => new Date(t);
    const work = join(dir, "work");
    return { dir, store, container, advance: (ms: number) => (t += ms), now, work };
  }

  it("sends the container only decisions older than the test window", async () => {
    const h = setup();
    const examples = fromCases(caseLines(30));
    const report = await runTraining({ settings: settings(), loadExamples: () => examples, store: h.store, container: h.container, workRoot: h.work, now: h.now });
    expect(report.status).toBe("trained");
    expect(report.trainCount).toBe(24);
    expect(report.testCount).toBe(6);
    const markers = h.container.inputs[0].rows.map((r) => r.features["ev.marker"]);
    expect(markers).toHaveLength(24);
    expect(Math.max(...markers)).toBe(23);
    expect(report.cutoffAt).toBe(new Date(START + 24 * DAY).toISOString());
    // The bench scored the newest six, and the report keeps the per-class numbers
    expect(report.classifier?.overall.n).toBe(6);
    expect(report.classifier?.byKind["planner/other/large+small"]).toBeUndefined();
    expect(Object.keys(report.classifier?.byKind ?? {})).toEqual(["planner_change"]);
    expect(report.baseline?.model).toBe("recommended-option");
  });

  it("maps answers to labels: bad outcomes are negatives, pending ones are not labels yet", async () => {
    const h = setup();
    const text = caseLines(30, (i) => (i === 3 ? { outcome: "bad" } : i === 4 ? { outcome: "pending" } : i === 5 ? { outcome: "good" } : {}));
    const examples = fromCases(text);
    const sets = splitLabels(examples.examples);
    expect(sets.negative.map((e) => e.id)).toEqual(["case-3"]);
    expect(sets.pending.map((e) => e.id)).toEqual(["case-4"]);
    expect(sets.positive).toHaveLength(28);
    const report = await runTraining({ settings: settings(), loadExamples: () => examples, store: h.store, container: h.container, workRoot: h.work, now: h.now });
    expect(report.labels).toMatchObject({ total: 30, used: 28, negative: 1, pending: 1 });
    const markers = h.container.inputs[0].rows.map((r) => r.features["ev.marker"]);
    expect(markers).not.toContain(3);
    expect(markers).not.toContain(4);
    expect(markers).toContain(5);
  });

  it("will not repeat an answer that turned out bad for the same evidence", async () => {
    const h = setup();
    const same = (i: number) => ({ evidence: { title_class: "planner_change" }, ...(i === 0 ? { outcome: "bad" } : {}) });
    const run = async (text: string) =>
      runTraining({ settings: settings(), loadExamples: () => fromCases(text), store: new ModelStore(join(tempDir(), "b")), container: h.container, workRoot: h.work, now: h.now });
    const control = await run(caseLines(30, (i) => ({ evidence: same(i).evidence })));
    expect(control.classifier?.overall.correct).toBe(6);
    const vetoed = await run(caseLines(30, same));
    expect(vetoed.classifier?.overall).toMatchObject({ correct: 0, abstain: 6, errors: 6 });
  });

  it("with too few labels only reports: no container, no model, a run on record", async () => {
    const h = setup();
    const report = await runTraining({
      settings: settings({ minLabels: 50 }), loadExamples: () => fromCases(caseLines(30)), store: h.store, container: h.container, workRoot: h.work, now: h.now,
    });
    expect(report).toMatchObject({ status: "too_few_labels", version: null, labels: { used: 30 } });
    expect(h.container.specs).toHaveLength(0);
    expect(h.store.best()).toBeNull();
    expect(existsSync(join(h.dir, "brain", "models")) ? readdirSync(join(h.dir, "brain", "models")) : []).toEqual([]);
    expect(h.store.runs()).toHaveLength(1);
  });

  it("keeps every run as its own version and moves the shadow pointer only to a better model", async () => {
    const h = setup();
    const load = () => fromCases(caseLines(30));
    const go = () => runTraining({ settings: settings(), loadExamples: load, store: h.store, container: h.container, workRoot: h.work, now: h.now });
    const first = await go();
    const second = await go(); // the same second: a new directory, not an overwrite
    h.container.model = FAVOURS_LARGE;
    h.advance(60_000);
    const third = await go();
    const versions = [first.version, second.version, third.version];
    expect(new Set(versions).size).toBe(3);
    expect(versions[1]).toBe(`${versions[0]}-2`);
    for (const v of versions) {
      expect(h.store.loadModel(v as string)?.classes).toEqual(["large", "small"]);
      expect(h.store.loadReport(v as string)?.status).toBe("trained");
    }
    expect(h.store.loadModel(third.version as string)?.init).toEqual([-2]);
    expect(h.store.loadModel(first.version as string)?.init).toEqual([2]);
    // The first model scores 6/6, the later favouring "large" scores 0: it never took the pointer
    expect(h.store.best()?.version).toBe(first.version);
    expect(h.store.runs().map((r) => r.version)).toEqual(versions);
  });

  it("reports a failed container, a timeout and a refused model without keeping a version", async () => {
    const h = setup();
    const go = () => runTraining({ settings: settings(), loadExamples: () => fromCases(caseLines(30)), store: h.store, container: h.container, workRoot: h.work, now: h.now });
    h.container.result = { exitCode: 2, stderr: `train.py: cannot read ${h.work}/run-x/in/input.json`, timedOut: false };
    const exited = await go();
    expect(exited).toMatchObject({ status: "failed", reasonCode: "container_exit", reason: "the trainer container exited with 2" });
    // The container's own words (they can name host paths) are not kept or returned
    expect(JSON.stringify(exited)).not.toContain(h.dir);
    expect(JSON.stringify(h.store.runs())).not.toContain(h.dir);
    h.container.result = { exitCode: 1, stderr: "", timedOut: true, cleanupFailed: true };
    expect(await go()).toMatchObject({ status: "failed", reasonCode: "container_not_stopped" });
    h.container.result = { exitCode: 137, stderr: "", timedOut: true };
    expect(await go()).toMatchObject({ status: "failed", reason: expect.stringContaining("timed out") });
    h.container.result = { exitCode: 0, stderr: "", timedOut: false };
    h.container.model = { ...FAVOURS_SMALL, stages: [[{ left: [1, -1], right: [0, -1], feature: [0, 0], threshold: [0, 0], value: [0, 0] }]] };
    expect(await go()).toMatchObject({ status: "failed", reason: expect.stringContaining("refused") });
    expect(h.store.best()).toBeNull();
    expect(readdirSync(join(h.dir, "work"))).toEqual([]);
  });
});

describe("the model file is untrusted input", () => {
  const good = JSON.stringify(FAVOURS_SMALL);

  it("accepts a valid model and refuses malformed ones", () => {
    expect(parseModel(good).classes).toEqual(["large", "small"]);
    expect(() => parseModel("{")).toThrow(/valid JSON/);
    expect(() => parseModel(JSON.stringify({ ...FAVOURS_SMALL, format: "other" }))).toThrow(/lair-gbt-1/);
    expect(() => parseModel(JSON.stringify({ ...FAVOURS_SMALL, classes: ["a", "a"] }))).toThrow(/unique/);
    expect(() => parseModel(JSON.stringify({ ...FAVOURS_SMALL, init: [1, 2] }))).toThrow(/init/);
    expect(() => parseModel(JSON.stringify({ ...FAVOURS_SMALL, learningRate: 0 }))).toThrow(/learningRate/);
    const loop = { left: [0], right: [0], feature: [0], threshold: [0], value: [0] };
    expect(() => parseModel(JSON.stringify({ ...FAVOURS_SMALL, stages: [[loop]] }))).toThrow(/child index/);
    expect(() => parseModel("x".repeat(9 * 1024 * 1024))).toThrow(/over/);
  });

  const tree: TreeModel = {
    format: "lair-gbt-1",
    classes: ["restart", "wait"],
    featureNames: ["ev.attempts"],
    init: [0],
    learningRate: 1,
    // attempts <= 2: log odds -3 (restart); above: +3 (wait)
    stages: [[{ left: [1, -1, -1], right: [2, -1, -1], feature: [0, 0, 0], threshold: [2, 0, 0], value: [0, -3, 3] }]],
    trainedOn: 10,
  };
  const options = [{ id: "wait", label: "Wait" }, { id: "restart", label: "Restart" }];
  const query = (attempts: number, opts = options) => ({ id: "q", kind: "c", module: "agents", evidence: { attempts }, options: opts });

  it("evaluates the trees and answers only with an offered option", () => {
    expect(probabilities(tree, { "ev.attempts": 1 }).restart).toBeCloseTo(0.9526, 3);
    expect(propose(tree, query(1))).toMatchObject({ option: "restart", reasonCode: "classifier_gbt" });
    expect(propose(tree, query(1)).confidence).toBeCloseTo(0.9526, 3);
    expect(propose(tree, query(5)).option).toBe("wait");
    // "restart" is not offered: the choice is among what is offered, renormalised
    const only = propose(tree, query(1, [{ id: "wait", label: "Wait" }, { id: "stop", label: "Stop" }]));
    expect(only).toMatchObject({ option: "wait", confidence: 1 });
    expect(() => propose(tree, query(1, [{ id: "stop", label: "Stop" }, { id: "go", label: "Go" }]))).toThrow(/offered/);
  });
});

describe("the bench file format", () => {
  it("reads the time, the recommended option and the outcome", () => {
    const [c] = parseCases(caseLines(1, () => ({ outcome: "bad" })));
    expect(c).toMatchObject({ at: new Date(START).toISOString(), recommended: "small", outcome: "bad" });
  });

  it("does not tighten the bench: an invalid at, recommended or outcome is left out, the case still reads", () => {
    const [c] = parseCases(caseLines(1, () => ({ at: "yesterday", outcome: "great", recommended: "huge" })));
    expect(c).toMatchObject({ id: "case-0", label: "small" });
    expect(c).not.toHaveProperty("at");
    expect(c).not.toHaveProperty("outcome");
    expect(c).not.toHaveProperty("recommended");
    // ...and the trainer then counts it as unusable rather than guessing a time
    expect(examplesFromCases([c])).toEqual({ examples: [], unusable: 1 });
    // The strict parts stay strict
    expect(() => parseCases(caseLines(1, () => ({ label: "huge" })))).toThrow(/label/);
  });

  it("counts cases without a time as unusable for training", () => {
    const { examples, unusable } = fromCases(caseLines(3, (i) => (i === 1 ? { at: undefined } : {})));
    expect(examples).toHaveLength(2);
    expect(unusable).toBe(1);
  });
});

describe("the container", () => {
  const spec: ContainerSpec = { image: IMAGE, inputDir: "/data/brain/work/run-1/in", outputDir: "/data/brain/work/run-1/out", timeoutMs: 600_000 };
  const flag = (args: string[], name: string) => args.slice(args.indexOf(name), args.indexOf(name) + 2);

  it("runs without network, without pulling, read-only, with nothing from the host's environment", () => {
    const args = trainerDockerArgs(spec, "lair-brain-trainer-x", "501:20");
    expect(flag(args, "--network")).toEqual(["--network", "none"]);
    expect(flag(args, "--pull")).toEqual(["--pull", "never"]);
    expect(args).toContain("--read-only");
    expect(flag(args, "--cap-drop")).toEqual(["--cap-drop", "ALL"]);
    expect(flag(args, "--user")).toEqual(["--user", "501:20"]);
    expect(args).not.toContain("-e");
    expect(args.slice(-5)).toEqual([spec.image, "/in/input.json", "/out/model.json", "/out/fit.json", "590"]);
  });

  it("mounts the input read-only and the output separately, and limits memory with no swap, cpus and an in-container deadline", () => {
    const args = trainerDockerArgs(spec, "lair-brain-trainer-x", "501:20");
    const mounts = args.flatMap((a, i) => (args[i - 1] === "--mount" ? [a] : []));
    expect(mounts).toEqual([
      `type=bind,source=${spec.inputDir},target=/in,readonly`,
      `type=bind,source=${spec.outputDir},target=/out`,
    ]);
    expect(args).not.toContain("-v");
    expect(flag(args, "--memory")).toEqual(["--memory", "2g"]);
    expect(flag(args, "--memory-swap")).toEqual(["--memory-swap", "2g"]);
    expect(flag(args, "--cpus")).toEqual(["--cpus", "2"]);
    // The deadline inside is under the host's, so the container ends itself first
    expect(Number(args[args.length - 1])).toBeLessThan(spec.timeoutMs / 1000);
  });

  it("refuses a work directory a mount option could be hidden in", () => {
    expect(() => trainerDockerArgs({ ...spec, inputDir: "/data/a,target=/etc" }, "n", "501:20")).toThrow(/mount/);
    expect(() => trainerDockerArgs({ ...spec, outputDir: "/data/../etc" }, "n", "501:20")).toThrow(/mount/);
  });

  it("never runs as root: uid 0, gid 0 or an unknown id is refused", async () => {
    expect(trainerUser(501, 20)).toBe("501:20");
    for (const [uid, gid] of [[0, 0], [0, 20], [501, 0], [undefined, 20], [501, undefined]] as const) {
      expect(() => trainerUser(uid, gid)).toThrow(/root/);
    }
    expect(() => trainerDockerArgs(spec, "n", "0:0")).toThrow(/root/);
    expect(() => trainerDockerArgs(spec, "n", "root")).toThrow(/root/);
    const calls: string[][] = [];
    const container = new DockerTrainerContainer({
      ids: () => ({ uid: 0, gid: 0 }),
      runner: async (_f, args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    await expect(container.run(spec)).rejects.toThrow(/root/);
    expect(calls).toEqual([]);
  });

  it("accepts an image named by content and refuses tags and anything that could be read as an option", () => {
    expect(validImage(`sha256:${"b".repeat(64)}`)).toBe(true);
    expect(validImage("registry.example/lair/trainer@sha256:" + "a".repeat(64))).toBe(true);
    expect(validImage("registry.example/lair/trainer:1@sha256:" + "a".repeat(64))).toBe(true);
    expect(validImage("lair-brain-trainer:1")).toBe(false);
    expect(validImage("python:latest")).toBe(false);
    expect(validImage("sha256:abc")).toBe(false);
    expect(validImage("--privileged")).toBe(false);
    expect(validImage("trainer image")).toBe(false);
  });

  describe("stopping it", () => {
    type Call = { file: string; args: string[] };
    function fake(results: (call: Call) => { exitCode?: number; stderr?: string; timedOut?: boolean; outputOverflow?: boolean }) {
      const calls: Call[] = [];
      const runner: ProcessRunner = async (file, args) => {
        const call = { file, args };
        calls.push(call);
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...results(call) };
      };
      return { calls, container: new DockerTrainerContainer({ docker: "fake-docker", runner, ids: () => ({ uid: 501, gid: 20 }) }) };
    }
    const isRun = (c: Call) => c.args[0] === "run";
    const nameOf = (c: Call) => c.args[c.args.indexOf("--name") + 1];

    it("a clean run is not killed", async () => {
      const f = fake(() => ({}));
      expect(await f.container.run(spec)).toEqual({ exitCode: 0, stderr: "", timedOut: false });
      expect(f.calls).toHaveLength(1);
    });

    it("kills the exact container by name after a timeout, and reports it stopped when the kill worked", async () => {
      const f = fake((c) => (isRun(c) ? { exitCode: 1, timedOut: true } : {}));
      const result = await f.container.run(spec);
      expect(result).toEqual({ exitCode: 1, stderr: "", timedOut: true });
      expect(f.calls.map((c) => c.args[0])).toEqual(["run", "kill"]);
      expect(f.calls[1].args).toEqual(["kill", nameOf(f.calls[0])]);
      expect(nameOf(f.calls[0])).toMatch(/^lair-brain-trainer-[0-9a-f]{12}$/);
    });

    it("kills it after an output overflow too", async () => {
      const f = fake((c) => (isRun(c) ? { exitCode: 1, outputOverflow: true } : {}));
      await f.container.run(spec);
      expect(f.calls.map((c) => c.args[0])).toEqual(["run", "kill"]);
    });

    it("falls back to docker rm -f when the kill fails, and is satisfied when the container is already gone", async () => {
      const f = fake((c) => (isRun(c) ? { exitCode: 1, timedOut: true } : c.args[0] === "kill" ? { exitCode: 1, stderr: "cannot kill" } : {}));
      expect((await f.container.run(spec)).cleanupFailed).toBeUndefined();
      expect(f.calls.map((c) => c.args[0])).toEqual(["run", "kill", "rm"]);
      expect(f.calls[2].args).toEqual(["rm", "-f", nameOf(f.calls[0])]);

      const gone = fake((c) => (isRun(c) ? { timedOut: true, exitCode: 1 } : { exitCode: 1, stderr: "Error: No such container: x" }));
      expect((await gone.container.run(spec)).cleanupFailed).toBeUndefined();
    });

    it("reports a container that could not be stopped", async () => {
      const f = fake((c) => (isRun(c) ? { exitCode: 1, timedOut: true } : { exitCode: 1, stderr: "daemon error" }));
      expect(await f.container.run(spec)).toMatchObject({ timedOut: true, cleanupFailed: true });
    });

    it("keeps only the end of stderr, and a stop that itself times out is a failed stop", async () => {
      const f = fake((c) => (isRun(c) ? { exitCode: 1, stderr: "x".repeat(5000), timedOut: true } : { exitCode: 1, timedOut: true }));
      const result = await f.container.run(spec);
      expect(result.stderr).toHaveLength(2000);
      expect(result.cleanupFailed).toBe(true);
    });

    it("refuses an image that is not named by content before it calls docker", async () => {
      const f = fake(() => ({}));
      await expect(f.container.run({ ...spec, image: "lair-brain-trainer:1" })).rejects.toThrow(/content/);
      expect(f.calls).toEqual([]);
    });
  });
});

describe("the config", () => {
  it("is off without the section, and refuses unknown or out-of-range keys", () => {
    expect(parseBrainTrainerConfig({})).toMatchObject({ ok: true, settings: { enabled: false } });
    expect(parseBrainTrainerConfig({ brain_trainer: { enabled: true, image: IMAGE } })).toMatchObject({ ok: true, settings: { enabled: true, image: IMAGE, minLabels: 100, shadow: true } });
    // No mutable default image: enabled needs one named by content, and a tag is refused
    expect(parseBrainTrainerConfig({ brain_trainer: { enabled: true } })).toMatchObject({ ok: false, errors: [expect.stringContaining("brain_trainer.image")] });
    expect(parseBrainTrainerConfig({ brain_trainer: { enabled: true, image: "lair-brain-trainer:1" } })).toMatchObject({ ok: false });
    expect(parseBrainTrainerConfig({ brain_trainer: { image: "python:3.12" } })).toMatchObject({ ok: false });
    expect(parseBrainTrainerConfig({ brain_trainer: { enabled: false } })).toMatchObject({ ok: true, settings: { enabled: false, image: "" } });
    expect(parseBrainTrainerConfig({ brain_trainer: { enabled: true, surprise: 1 } })).toMatchObject({ ok: false });
    expect(parseBrainTrainerConfig({ brain_trainer: { min_labels: 2 } })).toMatchObject({ ok: false });
    expect(parseBrainTrainerConfig({ brain_trainer: { image: "--privileged" } })).toMatchObject({ ok: false });
    expect(parseBrainTrainerConfig({ brain_trainer: { cases_file: "relative/cases.jsonl" } })).toMatchObject({ ok: false });
  });
});

// ---- The server: real inbox, real bus, real files, real routes ----

class FakeClock {
  t = Date.parse("2026-03-02T08:00:00.000Z");
  now(): number {
    return this.t;
  }
}

function pick(i: number, small: boolean): RaiseDecisionInput {
  return {
    project: "demo",
    kind: "other",
    title: `Pick the page size ${i}`,
    context: "The list view needs a page size.",
    options: [
      { id: "small", label: "20 rows", consequences: "Faster pages." },
      { id: "large", label: "100 rows", consequences: "Less paging." },
    ],
    recommended: { optionId: small ? "small" : "large", reasoning: "Most lists are short." },
    source: { module: "planner", ref: `card-${i}` },
    key: `size-${i}`,
    blocks: [`card:${i}`],
  };
}

async function server(yaml: string | null = "brain_trainer:\n  enabled: true\n" + IMAGE_LINE + "  min_labels: 20\n  min_test: 3\n", wrap?: (inbox: DecisionInbox) => DecisionReader) {
  const dir = tempDir();
  const configPath = join(dir, "server.yaml");
  if (yaml !== null) {
    writeFileSync(configPath, yaml);
    chmodSync(configPath, 0o600);
  }
  const clock = new FakeClock();
  const bus = new EventBus();
  const store = new DecisionStore(":memory:");
  stores.push(store);
  const inbox = new DecisionInbox({ store, secrets: new MemorySecretStore(), events: bus, clock });
  const container = new FakeContainer();
  let runAt = Date.parse("2026-03-20T03:10:00.000Z");
  const app = Fastify({ logger: false });
  apps.push(app);
  const tokenPath = join(dir, "owner.token");
  const auth = HumanAuth.open({ tokenPath, dbPath: ":memory:" });
  const trainer = await mountBrainTrainer(app, {
    configPath,
    dataDir: join(dir, "brain"),
    decisions: wrap ? wrap(inbox) : inbox,
    events: bus,
    humanAuth: auth,
    container,
    clock: () => new Date(runAt),
    timers: { set: () => () => undefined },
  });
  await app.ready();
  const owner = { ...BROWSER, [OWNER_SESSION_HEADER]: auth.createSession(readFileSync(tokenPath, "utf-8").trim())!.session };
  /** Raise and answer n decisions, an hour apart; the last `large` ones are the few that were not "small" */
  async function answered(n: number, from = 0) {
    for (let i = from; i < from + n; i++) {
      clock.t += 3600_000;
      const { decision } = await inbox.raise(pick(i, true));
      await inbox.answer(decision.id, { optionId: i % 10 === 9 ? "large" : "small" });
    }
  }
  return { dir, configPath, clock, bus, inbox, container, app, trainer, owner, answered, setRunTime: (t: number) => (runAt = t) };
}

describe("the server wiring", () => {
  it("reads only answered, human-chosen decisions as labels", async () => {
    const h = await server();
    await h.answered(2);
    clockAdvance(h);
    const open = (await h.inbox.raise(pick(50, true))).decision;
    const withdrawn = (await h.inbox.raise(pick(51, true))).decision;
    await h.inbox.withdraw(withdrawn.id, { module: "planner", reason: "moot" });
    const expiring = (await h.inbox.raise({ ...pick(52, true), expiresAt: new Date(h.clock.t + 1000).toISOString(), defaultOptionId: "small" })).decision;
    h.clock.t += 5000;
    await h.inbox.expireDue();
    const labelled = h.inbox.list({ status: "answered" }).map((d) => exampleFromDecision(d));
    expect(labelled.filter(Boolean)).toHaveLength(2);
    expect(exampleFromDecision(h.inbox.get(open.id)!)).toBeNull();
    expect(exampleFromDecision(h.inbox.get(withdrawn.id)!)).toBeNull();
    const expired = h.inbox.get(expiring.id)!;
    expect(expired.status).toBe("expired");
    expect(exampleFromDecision(expired)).toBeNull();
    const [first] = labelled;
    expect(first).toMatchObject({ label: "small", classKey: "planner/other/large+small", outcome: "unknown" });
    // Only structured fields: no title, context or note reaches an example
    expect(JSON.stringify(first)).not.toContain("page size");
    expect(JSON.stringify(first)).not.toContain("list view");
  });

  it("is off by default: nothing runs, nothing is written, and the routes say so", async () => {
    const h = await server(null);
    await h.answered(25);
    expect(await h.trainer.runNow()).toEqual({ refused: "the brain trainer is off" });
    const run = await h.app.inject({ method: "POST", url: "/api/owner/brain-trainer/run", headers: h.owner, payload: {} });
    expect(run.statusCode).toBe(409);
    expect(h.container.specs).toHaveLength(0);
    expect(existsSync(join(h.dir, "brain"))).toBe(false);
  });

  it("with too few labels a nightly run writes a report and nothing else", async () => {
    const h = await server();
    await h.answered(8);
    const report = await h.trainer.runNow();
    expect(report).toMatchObject({ status: "too_few_labels", version: null });
    expect(h.container.specs).toHaveLength(0);
    expect(h.trainer.status().best).toBeNull();
    expect(h.trainer.status().runs).toHaveLength(1);
  });

  it("trains on the answered decisions, scores the newest window and exposes the curve to the owner", async () => {
    const h = await server();
    await h.answered(40);
    const report = await trained(h);
    expect(report.status).toBe("trained");
    expect(report.testCount).toBe(8);
    expect(h.container.inputs[0].rows).toHaveLength(32);
    const view = await h.app.inject({ url: "/api/owner/brain-trainer", headers: h.owner });
    const data = view.json().data;
    expect(data.best.version).toBe(report.version);
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].classifier.byKind["planner/other/large+small"]).toMatchObject({ n: 8, abstain: 0 });
    expect(data.runs[0].classifier.byKind["planner/other/large+small"].wrongConfidentRate).toBeGreaterThanOrEqual(0);
  });

  it("the routes are the owner's", async () => {
    const h = await server();
    const stranger = BROWSER;
    expect((await h.app.inject({ url: "/api/owner/brain-trainer", headers: stranger })).statusCode).toBe(403);
    expect((await h.app.inject({ method: "POST", url: "/api/owner/brain-trainer/run", headers: stranger, payload: {} })).statusCode).toBe(403);
    await h.answered(25);
    const started = await h.app.inject({ method: "POST", url: "/api/owner/brain-trainer/run", headers: h.owner, payload: {} });
    expect(started.statusCode).toBe(202);
    // Let the background run finish before the directories are removed
    for (let i = 0; i < 100 && h.trainer.status().runs.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(h.trainer.status().runs).toHaveLength(1);
  });

  it("runs once a day at the configured hour", async () => {
    const h = await server("brain_trainer:\n  enabled: true\n" + IMAGE_LINE + "  min_labels: 20\n  min_test: 3\n  run_hour: 3\n");
    await h.answered(25);
    const localAt = (day: number, hour: number) => new Date(2026, 2, day, hour, 5).getTime();
    h.setRunTime(localAt(20, 2));
    await h.trainer.tick();
    expect(h.trainer.status().runs).toHaveLength(0);
    h.setRunTime(localAt(20, 3));
    await h.trainer.tick();
    await h.trainer.tick();
    expect(h.trainer.status().runs).toHaveLength(1);
    h.setRunTime(localAt(21, 3));
    await h.trainer.tick();
    expect(h.trainer.status().runs).toHaveLength(2);
  });
});

async function trained(h: { trainer: { runNow(): Promise<RunReport | { refused: string }> } }): Promise<RunReport> {
  const r = await h.trainer.runNow();
  if ("refused" in r) throw new Error(r.refused);
  return r;
}

function clockAdvance(h: { clock: FakeClock }): void {
  h.clock.t += 3600_000;
}

describe("shadow mode never answers", () => {
  it("writes a proposal into the trace when a decision is raised, leaves the decision open, and compares after the answer", async () => {
    const h = await server();
    await h.answered(40);
    const model = await trained(h);
    clockAdvance(h);
    const { decision } = await h.inbox.raise(pick(100, true));
    const proposals = h.trainer["shadow"].proposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      decisionId: decision.id, class: "planner/other/large+small", proposer: "classifier", version: model.version, option: "small", reasonCode: "classifier_gbt",
    });
    expect(proposals[0].confidence).toBeGreaterThanOrEqual(0.7);
    // Nobody answered: still open, no answer, no audit entry of an answer
    const after = h.inbox.get(decision.id)!;
    expect(after.status).toBe("open");
    expect(after.answer).toBeUndefined();
    expect(after.answeredBy).toBeUndefined();
    expect(after.audit?.map((a) => a.action)).toEqual(["raised"]);
    // An open decision is not compared; an answered one is
    expect(h.trainer.status().agreement).toEqual([]);
    await h.inbox.answer(decision.id, { optionId: "small" });
    expect(h.trainer.status().agreement).toEqual([
      { class: "planner/other/large+small", version: model.version, compared: 1, agreed: 1, abstained: 0, wrongConfident: 0 },
    ]);
  });

  it("records an abstain when the confidence is under the floor, and writes nothing without a model or with shadow off", async () => {
    const off = await server("brain_trainer:\n  enabled: true\n" + IMAGE_LINE + "  min_labels: 20\n  min_test: 3\n  shadow: false\n");
    await off.answered(40);
    await off.trainer.runNow();
    await off.inbox.raise(pick(100, true));
    expect(off.trainer["shadow"].proposals()).toEqual([]);

    const none = await server();
    await none.inbox.raise(pick(1, true));
    expect(none.trainer["shadow"].proposals()).toEqual([]);

    const high = await server("brain_trainer:\n  enabled: true\n" + IMAGE_LINE + "  min_labels: 20\n  min_test: 3\n  confidence_floor: 0.95\n");
    await high.answered(40);
    await high.trainer.runNow();
    await high.inbox.raise(pick(100, true));
    expect(high.trainer["shadow"].proposals()[0]).toMatchObject({ option: null, reasonCode: "below_floor" });
  });

  it("holds a get/list-only object, not the inbox: no answer, withdraw or raise exists on it, and the whole flow runs through a source that throws on anything else", async () => {
    const touched: string[] = [];
    const guarded = (inbox: DecisionInbox): DecisionReader =>
      new Proxy(inbox, {
        get(target, prop) {
          if (prop === "get" || prop === "list") return (target[prop] as (...a: unknown[]) => unknown).bind(target);
          touched.push(String(prop));
          throw new Error(`the trainer touched ${String(prop)}`);
        },
      }) as unknown as DecisionReader;
    const h = await server(undefined, guarded);
    const view = h.trainer["decisions"] as unknown as Record<string, unknown>;
    expect(Object.keys(view).sort()).toEqual(["get", "list"]);
    expect(Object.isFrozen(view)).toBe(true);
    for (const method of ["answer", "withdraw", "raise", "raiseFromHttp", "expireDue", "store"]) expect(view[method], method).toBeUndefined();
    // A cast does not help: there is nothing behind the type
    expect(() => (view as unknown as { answer(id: string): void }).answer("x")).toThrow(TypeError);

    await h.answered(40);
    const model = await trained(h);
    expect(model.status).toBe("trained");
    clockAdvance(h);
    await h.inbox.raise(pick(100, true));
    expect(h.trainer["shadow"].proposals()).toHaveLength(1);
    expect(h.trainer.status().agreement).toEqual([]);
    expect(touched).toEqual([]);

    // The helper on its own wraps any reader the same way
    const direct = readOnlyDecisions(h.inbox);
    expect(Object.keys(direct).sort()).toEqual(["get", "list"]);
  });

  it("has no code path to answer: the trainer's sources never touch the means of answering (a guard on top of the structural one)", () => {
    const here = new URL(".", import.meta.url).pathname;
    const files = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(8);
    for (const f of files) {
      const text = readFileSync(join(here, f), "utf8");
      expect(text, f).not.toMatch(/decisions\/(service|store|routes|mount|request-bridge|validate)/);
      expect(text, f).not.toMatch(/\.answer\(|\.raise\(|\.raiseFromHttp\(|\.withdraw\(|expireDue|AnswerInput/);
    }
    const mount = readFileSync(join(here, "index.ts"), "utf8");
    expect(mount).toContain("decisions: DecisionReader");
  });
});

function notice(i: number): RaiseDecisionInput {
  return {
    project: "demo",
    kind: "other",
    title: `Self-check alert ${i}`,
    context: "Nothing to choose: acknowledge it.",
    options: [{ id: "noted", label: "Noted", consequences: "Dismisses the alert." }],
    recommended: { optionId: "noted", reasoning: "Only one option." },
    source: { module: "supervisor", ref: `selfcheck-${i}` },
    key: `notice-${i}`,
  };
}

describe("what becomes a training row, through the store path", () => {
  it("drops one-option notices from the labels and counts them", async () => {
    const h = await server();
    await h.answered(25);
    clockAdvance(h);
    const raised = await h.inbox.raise(notice(1));
    expect(raised.decision.options).toHaveLength(1);
    await h.inbox.answer(raised.decision.id, { optionId: "noted" });
    const answered = h.inbox.get(raised.decision.id)!;
    expect(answered.status).toBe("answered");
    expect(isNotice(answered)).toBe(true);
    expect(exampleFromDecision(answered)).toBeNull();

    const report = await trained(h);
    // 25 real choices are used; the acknowledgement is neither a label nor "unusable", it is a notice
    expect(report.labels).toMatchObject({ total: 26, used: 25, notices: 1, unusable: 0 });
    expect(h.container.inputs[0].rows).toHaveLength(report.trainCount as number);
    expect(h.container.inputs[0].rows.every((r) => r.label === "small" || r.label === "large")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("noted");
    // ...and no class is ever formed from it, so it cannot be proposed for either
    await h.inbox.raise(notice(2));
    expect(h.trainer["shadow"].proposals().filter((p) => p.class.includes("supervisor"))).toEqual([]);
  });

  it("trains only on decisions older than the cutoff, and none of the test window is a training row", async () => {
    const h = await server();
    await h.answered(40);
    const report = await trained(h);
    const cutoff = Date.parse(report.cutoffAt as string);
    const all = h.inbox.list({ status: "answered" });
    const before = all.filter((d) => Date.parse(d.createdAt) < cutoff);
    const atOrAfter = all.filter((d) => Date.parse(d.createdAt) >= cutoff);
    expect(h.container.inputs[0].rows).toHaveLength(before.length);
    expect(report.trainCount).toBe(before.length);
    expect(report.testCount).toBe(atOrAfter.length);
    expect(before.length + atOrAfter.length).toBe(40);
    expect(Math.max(...before.map((d) => Date.parse(d.createdAt)))).toBeLessThan(cutoff);
  });

  it("a decision answered after the cutoff is not a training row, though it was raised before it", async () => {
    const h = await server();
    // 30 raised an hour apart; the first 10 answered at once, the rest only after the newest was raised
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      h.clock.t += 3600_000;
      const { decision } = await h.inbox.raise(pick(i, true));
      ids.push(decision.id);
      if (i < 10) await h.inbox.answer(decision.id, { optionId: "small" });
    }
    h.clock.t += 3600_000;
    for (const id of ids.slice(10)) await h.inbox.answer(id, { optionId: "small" });

    const report = await trained(h);
    expect(report.status).toBe("trained");
    expect(report.testCount).toBe(6);
    // 24 were raised before the cutoff, but only the 10 answered before it are rows
    expect(report.labels.lateAnswers).toBe(14);
    expect(report.trainCount).toBe(10);
    expect(h.container.inputs[0].rows).toHaveLength(10);
  });

  it("fixes the reason of a failed run: no host path reaches the route or runs.jsonl", async () => {
    const dir = tempDir();
    const casesPath = join(dir, "cases.jsonl");
    // Refused by the file check or by the parser: either way the run fails, and what it says must not name the path
    writeFileSync(casesPath, "{not a case");
    chmodSync(casesPath, 0o644);
    const h = await server(`brain_trainer:\n  enabled: true\n${IMAGE_LINE}  min_labels: 20\n  min_test: 3\n  cases_file: ${casesPath}\n`);
    const report = await trained(h);
    expect(report).toMatchObject({ status: "failed", reasonCode: "run_error", reason: "the run failed before it finished: see Lair's log" });
    const view = await h.app.inject({ url: "/api/owner/brain-trainer", headers: h.owner });
    for (const text of [view.body, readFileSync(join(h.dir, "brain", "runs.jsonl"), "utf8")]) {
      expect(text).not.toContain(dir);
      expect(text).not.toContain(h.dir);
    }
  });
});

describe("a damaged run history or trace", () => {
  it("skips and counts a corrupt line instead of failing the status route", async () => {
    const h = await server();
    await h.answered(40);
    await trained(h);
    clockAdvance(h);
    await h.inbox.raise(pick(100, true));
    expect(h.trainer.status().skipped).toEqual({ runs: 0, trace: 0 });

    appendFileSync(join(h.dir, "brain", "runs.jsonl"), "{this is not json\n[1,2]\n");
    appendFileSync(join(h.dir, "brain", "shadow-trace.jsonl"), 'garbage\n{"decisionId":7}\n');
    const view = await h.app.inject({ url: "/api/owner/brain-trainer", headers: h.owner });
    expect(view.statusCode).toBe(200);
    const data = view.json().data;
    expect(data.skipped).toEqual({ runs: 2, trace: 2 });
    expect(data.runs).toHaveLength(1);
    expect(data.best.version).toBeTruthy();

    // A damaged best pointer or report is "none", not a 500
    writeFileSync(join(h.dir, "brain", "best.json"), "{");
    const after = await h.app.inject({ url: "/api/owner/brain-trainer", headers: h.owner });
    expect(after.statusCode).toBe(200);
    expect(after.json().data.best).toBeNull();
    // ...and a run that follows still works
    expect((await h.trainer.runNow()) as RunReport).toMatchObject({ status: "trained" });
  });
});

describe("the output the container wrote is untrusted", () => {
  it("refuses a model that is a link to another file", async () => {
    const dir = tempDir();
    const secret = join(dir, "secret.json");
    writeFileSync(secret, JSON.stringify(FAVOURS_SMALL));
    const store = new ModelStore(join(dir, "brain"));
    const linking: TrainerContainer = {
      async run(spec) {
        symlinkSync(secret, join(spec.outputDir, "model.json"));
        return { exitCode: 0, stderr: "", timedOut: false };
      },
    };
    const report = await runTraining({
      settings: settings(), loadExamples: () => fromCases(caseLines(30)), store, container: linking, workRoot: join(dir, "work"), now: () => new Date("2026-03-20T03:00:00Z"),
    });
    expect(report).toMatchObject({ status: "failed", reasonCode: "model_refused" });
    expect(store.best()).toBeNull();
  });

  it("gives the container the input and the output in separate directories", async () => {
    const dir = tempDir();
    const seen: ContainerSpec[] = [];
    const container: TrainerContainer = {
      async run(spec) {
        seen.push(spec);
        expect(existsSync(join(spec.inputDir, "input.json"))).toBe(true);
        expect(readdirSync(spec.outputDir)).toEqual([]);
        writeFileSync(join(spec.outputDir, "model.json"), JSON.stringify(FAVOURS_SMALL));
        return { exitCode: 0, stderr: "", timedOut: false };
      },
    };
    await runTraining({
      settings: settings(), loadExamples: () => fromCases(caseLines(30)), store: new ModelStore(join(dir, "brain")), container, workRoot: join(dir, "work"), now: () => new Date("2026-03-20T03:00:00Z"),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].inputDir).not.toBe(seen[0].outputDir);
    expect(seen[0].inputDir.startsWith(join(dir, "work"))).toBe(true);
  });
});
