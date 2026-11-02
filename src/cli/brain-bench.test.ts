/**
 * Tests for `lair brain-bench`: the real CLI entry point, over a case file and
 * rules on disk, with the model endpoint faked at the fetch boundary and the
 * clock injected.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { brainBench, readBoundedFile, EXIT_OK, EXIT_USAGE, type BenchCliDeps } from "./brain-bench.js";
import type { FetchLike } from "../server/brain-bench/models.js";
import type { BenchReport } from "../server/brain-bench/types.js";

interface CallBody {
  messages: { content: string }[];
  format: { properties: { option: { enum: string[] } } };
  response_format?: unknown;
}

const WAIT = [
  { id: "wait", label: "Wait for the cooldown" },
  { id: "switch", label: "Switch profile" },
];
const RETRY = [
  { id: "again", label: "Start again" },
  { id: "release", label: "Release the task" },
];

function line(id: string, kind: string, mod: string, evidence: Record<string, unknown>, options: unknown[], label: string): string {
  return JSON.stringify({ id, kind, module: mod, evidence, options, label, reason: "because" });
}

const CASES = [
  line("c1", "escalation", "agents", { class: "rate_limited" }, WAIT, "wait"),
  line("c2", "escalation", "agents", { class: "rate_limited" }, WAIT, "wait"),
  line("c3", "escalation", "agents", { class: "crash" }, RETRY, "again"),
  line("c4", "other", "planner", { class: "tasks_change" }, RETRY, "release"),
].join("\n");

describe("lair brain-bench", () => {
  let dir: string;
  let out: string[];
  let err: string[];
  let calls: { url: string; body: CallBody; headers: Record<string, string> }[];
  let clock: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "brain-bench-"));
    out = [];
    err = [];
    calls = [];
    clock = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function deps(fetchImpl: FetchLike, env: Record<string, string> = {}): BenchCliDeps {
    return {
      env,
      fetch: fetchImpl,
      readFile: readBoundedFile,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      // each model call takes 40 ms on this fake clock
      now: () => {
        clock += 20;
        return clock;
      },
    };
  }

  /** An Ollama server that answers per case id found in the prompt's case data. */
  function ollama(script: Record<string, { option: string; confidence: number } | "garbage" | 500>): FetchLike {
    return async (url, init) => {
      const body = JSON.parse(init.body) as { messages: { content: string }[]; format: { properties: { option: { enum: string[] } } } };
      calls.push({ url, body, headers: init.headers });
      const data = body.messages[1].content;
      const key = data.includes("tasks_change") ? "c4" : data.includes("crash") ? "c3" : "c1";
      const r = script[key];
      if (r === 500) return { status: 500, text: async () => "boom" };
      const content = r === "garbage" ? "I think wait" : JSON.stringify({ option: r.option, reason_code: "r", confidence: r.confidence });
      return { status: 200, text: async () => JSON.stringify({ message: { content } }) };
    };
  }

  const write = (name: string, text: string) => {
    const p = join(dir, name);
    writeFileSync(p, text);
    return p;
  };

  it("scores accuracy, abstain, wrong-but-confident and latency per model and per kind", async () => {
    const cases = write("cases.jsonl", CASES);
    const fetchImpl = ollama({
      c1: { option: "wait", confidence: 0.9 }, // c1 and c2 share the same evidence: right
      c3: { option: "release", confidence: 0.95 }, // wrong and confident
      c4: { option: "again", confidence: 0.2 }, // wrong but below the threshold: an abstain
    });
    const code = await brainBench(["--cases", cases, "--model", "ollama:qwen3:4b", "--json"], deps(fetchImpl));
    expect(code).toBe(EXIT_OK);
    const report = JSON.parse(out.join("\n")) as BenchReport;
    expect(report.cases).toBe(4);
    const m = report.models[0];
    expect(m.model).toBe("ollama:qwen3:4b");
    expect(m.overall).toMatchObject({ n: 4, correct: 2, wrong: 1, abstain: 1, wrongConfident: 1, errors: 0 });
    expect(m.overall.accuracy).toBe(0.5);
    expect(m.overall.answeredAccuracy).toBeCloseTo(2 / 3, 3);
    expect(m.overall.abstainRate).toBe(0.25);
    expect(m.overall.wrongConfidentRate).toBe(0.25);
    expect(m.overall.latencyP50Ms).toBe(20);
    expect(m.byKind.escalation).toMatchObject({ n: 3, correct: 2, wrong: 1, wrongConfident: 1 });
    expect(m.byKind.other).toMatchObject({ n: 1, abstain: 1 });
  });

  it("constrains the model to the case's option ids and never sends the answer", async () => {
    const cases = write("cases.jsonl", CASES);
    await brainBench(["--cases", cases, "--model", "ollama:m", "--limit", "3"], deps(ollama({ c1: { option: "wait", confidence: 1 }, c3: { option: "again", confidence: 1 } })));
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe("http://127.0.0.1:11434/api/chat");
    expect(calls[0].body.format.properties.option.enum).toEqual(["wait", "switch"]);
    expect(calls[2].body.format.properties.option.enum).toEqual(["again", "release"]);
    const sent = JSON.stringify(calls.map((c) => c.body.messages));
    expect(sent).not.toContain("because");
    expect(sent).not.toContain('"label":"wait"');
  });

  it("counts an option outside the allowed ids, bad JSON and a failing endpoint as errors (abstains)", async () => {
    const cases = write("cases.jsonl", CASES);
    const fetchImpl = ollama({ c1: { option: "invented", confidence: 1 }, c3: "garbage", c4: 500 });
    await brainBench(["--cases", cases, "--model", "ollama:m", "--json"], deps(fetchImpl));
    const m = (JSON.parse(out.join("\n")) as BenchReport).models[0];
    expect(m.overall).toMatchObject({ n: 4, correct: 0, wrong: 0, abstain: 4, errors: 4, wrongConfident: 0 });
    expect(m.overall.answeredAccuracy).toBeNull();
  });

  it("scores deterministic rules like a model and shows several models side by side", async () => {
    const cases = write("cases.jsonl", CASES);
    const rules = write(
      "rules.json",
      JSON.stringify({ rules: [{ when: { module: "agents", class: "rate_limited" }, option: "wait", reasonCode: "cooldown" }, { when: { class: "crash" }, option: "again" }] }),
    );
    await brainBench(["--cases", cases, "--model", `rules:${rules}`, "--model", "ollama:m", "--json"], deps(ollama({ c1: { option: "switch", confidence: 0.9 }, c3: { option: "again", confidence: 0.9 }, c4: { option: "release", confidence: 0.9 } })));
    const report = JSON.parse(out.join("\n")) as BenchReport;
    expect(report.models.map((r) => r.model)).toEqual(["rules:rules.json", "ollama:m"]);
    // rules: c1, c2, c3 right; c4 has no rule -> abstain
    expect(report.models[0].overall).toMatchObject({ correct: 3, abstain: 1, errors: 1, wrong: 0, wrongConfident: 0 });
    expect(report.models[0].overall.latencyP95Ms).toBeGreaterThan(0);
    // model: c1,c2 wrong+confident, c3 right, c4 right
    expect(report.models[1].overall).toMatchObject({ correct: 2, wrong: 2, wrongConfident: 2 });
  });

  it("calls an OpenAI-compatible endpoint with a json_schema and the key from the named variable", async () => {
    const cases = write("cases.jsonl", CASES);
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      const content = JSON.stringify({ option: "wait", reason_code: "x", confidence: 0.8 });
      return { status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) };
    };
    const code = await brainBench(
      ["--cases", cases, "--model", "openai:small", "--endpoint", "http://127.0.0.1:9000/v1/", "--api-key-env", "BENCH_KEY", "--limit", "1"],
      deps(fetchImpl, { BENCH_KEY: "sekret-value" }),
    );
    expect(code).toBe(EXIT_OK);
    expect(calls[0].url).toBe("http://127.0.0.1:9000/v1/chat/completions");
    expect(calls[0].headers.authorization).toBe("Bearer sekret-value");
    const rf = calls[0].body.response_format as { type: string; json_schema: { strict: boolean } };
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.strict).toBe(true);
    expect(out.join("\n")).toContain("openai:small");
    expect(out.join("\n")).not.toContain("sekret-value");
  });

  it("refuses bad input and runs nothing: a bad case line, a missing key variable, an endpoint with credentials", async () => {
    const never: FetchLike = async () => {
      throw new Error("must not be called");
    };
    const bad = write("bad.jsonl", CASES + '\n{"id":"x","kind":"k","module":"m","evidence":{},"options":[{"id":"a","label":"A"},{"id":"b","label":"B"}],"label":"zzz"}\n');
    expect(await brainBench(["--cases", bad, "--model", "ollama:m"], deps(never))).toBe(EXIT_USAGE);
    expect(err.join("\n")).toContain("line 5: label zzz is not one of the option ids");

    const good = write("good.jsonl", CASES);
    err.length = 0;
    expect(await brainBench(["--cases", good, "--model", "openai:m", "--api-key-env", "NOPE"], deps(never))).toBe(EXIT_USAGE);
    expect(err.join("\n")).toContain("NOPE is not set");

    err.length = 0;
    expect(await brainBench(["--cases", good, "--model", "ollama:m", "--endpoint", "http://user:pw@host:1"], deps(never))).toBe(EXIT_USAGE);
    expect(err.join("\n")).toContain("must not hold credentials");

    err.length = 0;
    expect(await brainBench(["--cases", good], deps(never))).toBe(EXIT_USAGE);
    expect(await brainBench(["--cases", good, "--model", "ollama:m", "--threshold", "2"], deps(never))).toBe(EXIT_USAGE);
    expect(await brainBench(["--cases", good, "--model", "mystery:m"], deps(never))).toBe(EXIT_USAGE);
    expect(await brainBench(["--cases", join(dir, "missing.jsonl"), "--model", "ollama:m"], deps(never))).toBe(EXIT_USAGE);
  });

  it("prints a readable table by default", async () => {
    const cases = write("cases.jsonl", CASES);
    await brainBench(["--cases", cases, "--model", "ollama:m"], deps(ollama({ c1: { option: "wait", confidence: 1 }, c3: { option: "again", confidence: 1 }, c4: { option: "release", confidence: 1 } })));
    const text = out.join("\n");
    expect(text).toContain("Brain bench: 4 cases");
    expect(text).toContain("acc 100.0%");
    expect(text).toContain("escalation");
    expect(text).toContain("wrong-confident");
  });
});
