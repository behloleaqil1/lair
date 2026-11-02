/**
 * The classifier's features from a case: structured fields only (design §3
 * tier 2). Free text never enters: strings count only when short and
 * identifier-shaped, so a sentence in an evidence field adds nothing.
 */
import type { BenchCase } from "../brain-bench/types.js";
import type { Features } from "./types.js";

export const MAX_FEATURES_PER_CASE = 200;
const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
const KEY = /^[A-Za-z0-9_.-]{1,64}$/;

function put(out: Features, name: string, value: number): void {
  if (!Number.isFinite(value)) return;
  if (Object.keys(out).length >= MAX_FEATURES_PER_CASE && !(name in out)) return;
  out[name] = value;
}

function addValue(out: Features, name: string, value: unknown, depth: number): void {
  if (typeof value === "number") put(out, name, value);
  else if (typeof value === "boolean") put(out, name, value ? 1 : 0);
  else if (typeof value === "string") {
    if (TOKEN.test(value)) put(out, `${name}=${value}`, 1);
  } else if (Array.isArray(value)) {
    put(out, `${name}.len`, value.length);
    for (const item of value.slice(0, 20)) {
      if (typeof item === "string" && TOKEN.test(item)) put(out, `${name}[]=${item}`, 1);
      else if (typeof item === "number" || typeof item === "boolean") put(out, `${name}[]=${String(item)}`, 1);
    }
  } else if (typeof value === "object" && value !== null && depth < 2) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (KEY.test(k)) addValue(out, `${name}.${k}`, v, depth + 1);
    }
  }
}

/** Sparse feature vector for a case: absent names are 0. The label is never read. */
export function featuresOf(c: Omit<BenchCase, "label">): Features {
  const out: Features = {};
  put(out, `class=${c.kind}`, 1);
  put(out, `module=${c.module}`, 1);
  put(out, "options.len", c.options.length);
  for (const o of c.options) put(out, `offered=${o.id}`, 1);
  if (c.recommended) put(out, `recommended=${c.recommended}`, 1);
  if (c.at) {
    const t = Date.parse(c.at);
    if (Number.isFinite(t)) put(out, "hour", new Date(t).getUTCHours());
  }
  for (const [k, v] of Object.entries(c.evidence)) {
    if (KEY.test(k)) addValue(out, `ev.${k}`, v, 0);
  }
  return out;
}
