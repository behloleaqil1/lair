/** Reading a bench file: one JSON object per line, validated strictly. */
import type { BenchCase } from "./types.js";

export const MAX_CASE_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_CASE_LINE_BYTES = 32 * 1024;
export const MAX_CASES = 50_000;
const ID = /^[A-Za-z0-9._:-]{1,80}$/;
const OPTION_ID = /^[A-Za-z0-9._-]{1,64}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown, what: string, max: number): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) throw new Error(`${what} must be a string of 1-${max} characters`);
  return v;
}

export function parseCase(value: unknown): BenchCase {
  if (!isRecord(value)) throw new Error("a case must be a JSON object");
  const id = text(value.id, "id", 80);
  if (!ID.test(id)) throw new Error("id may only hold letters, digits and . _ : -");
  const kind = text(value.kind, "kind", 80);
  const mod = text(value.module, "module", 80);
  if (!isRecord(value.evidence)) throw new Error("evidence must be an object of structured fields");
  if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 12) {
    throw new Error("options must be a list of 2-12 {id, label}");
  }
  const seen = new Set<string>();
  const options = value.options.map((o: unknown) => {
    if (!isRecord(o)) throw new Error("an option must be {id, label}");
    const oid = text(o.id, "option id", 64);
    if (!OPTION_ID.test(oid)) throw new Error("option id may only hold letters, digits and . _ -");
    if (seen.has(oid)) throw new Error(`option id ${oid} is repeated`);
    seen.add(oid);
    return { id: oid, label: text(o.label, "option label", 300) };
  });
  const label = text(value.label, "label", 64);
  if (!seen.has(label)) throw new Error(`label ${label} is not one of the option ids`);
  const reason = value.reason === undefined || value.reason === "" ? undefined : text(value.reason, "reason", 2000);
  const at = value.at === undefined || value.at === "" ? undefined : text(value.at, "at", 40);
  if (at !== undefined && !Number.isFinite(Date.parse(at))) throw new Error("at must be an ISO-8601 time");
  const recommended = value.recommended === undefined || value.recommended === "" ? undefined : text(value.recommended, "recommended", 64);
  if (recommended !== undefined && !seen.has(recommended)) throw new Error(`recommended ${recommended} is not one of the option ids`);
  const outcome = value.outcome === undefined || value.outcome === "" ? undefined : value.outcome;
  if (outcome !== undefined && outcome !== "good" && outcome !== "bad" && outcome !== "pending") {
    throw new Error("outcome must be good, bad or pending");
  }
  return {
    id,
    kind,
    module: mod,
    evidence: value.evidence,
    options,
    label,
    ...(reason ? { reason } : {}),
    ...(at ? { at } : {}),
    ...(recommended ? { recommended } : {}),
    ...(outcome ? { outcome } : {}),
  };
}

/** Parse JSON Lines text. Throws with the line number on the first bad line, and on a repeated id. */
export function parseCases(content: string): BenchCase[] {
  if (Buffer.byteLength(content) > MAX_CASE_FILE_BYTES) throw new Error(`the case file is over ${MAX_CASE_FILE_BYTES} bytes`);
  const cases: BenchCase[] = [];
  const ids = new Set<string>();
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    try {
      if (line.length > MAX_CASE_LINE_BYTES) throw new Error(`the line is over ${MAX_CASE_LINE_BYTES} characters`);
      const c = parseCase(JSON.parse(line));
      if (ids.has(c.id)) throw new Error(`id ${c.id} is repeated`);
      ids.add(c.id);
      cases.push(c);
      if (cases.length > MAX_CASES) throw new Error(`more than ${MAX_CASES} cases`);
    } catch (e) {
      throw new Error(`line ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return cases;
}
