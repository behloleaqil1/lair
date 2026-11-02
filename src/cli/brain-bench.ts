/**
 * `lair brain-bench`: scores models (and deterministic rules) on recorded
 * decisions (docs/configuration.md#brain-bench).
 *
 *   lair brain-bench --cases <file.jsonl> --model <spec> [--model <spec> ...]
 *                    [--endpoint <url>] [--api-key-env <NAME>] [--threshold <0-1>] [--limit <n>] [--json]
 *
 * A model spec is `ollama:<name>`, `openai:<name>` (any OpenAI-compatible
 * server) or `rules:<file.json>`. It reads files and calls the endpoints you
 * name; it never talks to the Lair server and changes nothing.
 *
 * Exit codes: 0 scored; 2 a usage or input error, nothing was run.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "fs";
import { parseCases, MAX_CASE_FILE_BYTES } from "../server/brain-bench/cases.js";
import { ollamaModel, openAiCompatModel, parseRules, ruleModel, type FetchLike } from "../server/brain-bench/models.js";
import { DEFAULT_THRESHOLD, formatReport, runBench } from "../server/brain-bench/run.js";
import type { BenchModel } from "../server/brain-bench/types.js";

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;

export const BRAIN_BENCH_USAGE = [
  "Usage: lair brain-bench --cases <file.jsonl> --model <spec> [--model <spec> ...]",
  "         [--endpoint <url>] [--api-key-env <NAME>] [--threshold <0-1>] [--limit <n>] [--json]",
  "",
  "Scores each model on the recorded decisions: accuracy, abstain rate, wrong-but-confident rate and latency,",
  "overall and per decision kind. A spec is ollama:<name>, openai:<name> or rules:<file.json>.",
  "--endpoint defaults to http://127.0.0.1:11434 (ollama) and http://127.0.0.1:1234/v1 (openai).",
  "--api-key-env names an environment variable that holds the bearer token for an openai endpoint.",
].join("\n");

export interface BenchCliDeps {
  env: Record<string, string | undefined>;
  fetch: FetchLike;
  /** Whole file as text; the CLI bounds the size */
  readFile: (path: string, maxBytes: number) => string;
  out: (line: string) => void;
  err: (line: string) => void;
  now?: () => number;
}

class UsageError extends Error {}

const FLAGS = new Set(["--cases", "--model", "--endpoint", "--api-key-env", "--threshold", "--limit", "--json"]);

function parse(args: string[]) {
  const models: string[] = [];
  const v: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (!FLAGS.has(name)) throw new UsageError(`unknown argument ${name.slice(0, 40)}`);
    if (name === "--json") {
      json = true;
      continue;
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${name} needs a value`);
    i++;
    if (name === "--model") models.push(value);
    else if (name in v) throw new UsageError(`${name} is given twice`);
    else v[name] = value;
  }
  if (!v["--cases"]) throw new UsageError("--cases is required");
  if (models.length === 0) throw new UsageError("at least one --model is required");
  const threshold = v["--threshold"] === undefined ? DEFAULT_THRESHOLD : Number(v["--threshold"]);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new UsageError("--threshold must be a number from 0 to 1");
  const limit = v["--limit"] === undefined ? undefined : Number(v["--limit"]);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new UsageError("--limit must be a positive whole number");
  return { casesPath: v["--cases"], models, endpoint: v["--endpoint"], keyEnv: v["--api-key-env"], threshold, limit, json };
}

/** Read a whole regular file of at most `maxBytes` as text. */
export function readBoundedFile(path: string, maxBytes: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("not a regular file");
    if (st.size > maxBytes) throw new Error(`over ${maxBytes} bytes`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function buildModel(spec: string, a: ReturnType<typeof parse>, deps: BenchCliDeps): BenchModel {
  const colon = spec.indexOf(":");
  const type = colon < 0 ? "" : spec.slice(0, colon);
  const rest = colon < 0 ? "" : spec.slice(colon + 1);
  if (!rest || !["ollama", "openai", "rules"].includes(type)) throw new UsageError(`unknown model spec ${spec.slice(0, 60)}`);
  if (type === "rules") {
    let json: unknown;
    try {
      json = JSON.parse(deps.readFile(rest, 1024 * 1024));
    } catch (e) {
      throw new UsageError(`cannot read rules ${rest.slice(0, 80)}: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      return ruleModel(rest.split("/").pop() ?? rest, parseRules(json));
    } catch (e) {
      throw new UsageError(e instanceof Error ? e.message : String(e));
    }
  }
  const key = a.keyEnv ? deps.env[a.keyEnv] : undefined;
  if (a.keyEnv && !key) throw new UsageError(`${a.keyEnv} is not set`);
  try {
    return type === "ollama"
      ? ollamaModel({ endpoint: a.endpoint ?? "http://127.0.0.1:11434", model: rest, fetch: deps.fetch })
      : openAiCompatModel({ endpoint: a.endpoint ?? "http://127.0.0.1:1234/v1", model: rest, fetch: deps.fetch, apiKey: key });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
}

export async function brainBench(args: string[], deps: BenchCliDeps): Promise<number> {
  try {
    const a = parse(args);
    let cases;
    try {
      cases = parseCases(deps.readFile(a.casesPath, MAX_CASE_FILE_BYTES));
    } catch (e) {
      throw new UsageError(`${a.casesPath.slice(0, 80)}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (cases.length === 0) throw new UsageError("the case file holds no cases");
    if (a.limit) cases = cases.slice(0, a.limit);
    const models = a.models.map((m) => buildModel(m, a, deps));
    const report = await runBench(cases, models, { threshold: a.threshold, now: deps.now });
    deps.out(a.json ? JSON.stringify(report, null, 2) : formatReport(report));
    return EXIT_OK;
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    deps.err(`lair brain-bench: ${e.message}`);
    deps.err(BRAIN_BENCH_USAGE);
    return EXIT_USAGE;
  }
}
