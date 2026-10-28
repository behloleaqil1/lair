/**
 * The Settings search (⌘K inside Settings; docs/design/settings-v2.md):
 * every field of every section the registry describes
 * (GET /api/settings/modules), found by its label, its help text or its YAML
 * key, at every level, advanced and expert included. No DOM: the search box
 * (components/SettingsSearch.tsx) draws what this returns, and a pick opens
 * the page that edits the field (settings-pages.ts).
 */
import type { FieldHint, FieldLevel, JsonSchema, SettingsSection } from "../shared/settings-types";
import { levelOf, unwrap } from "./settings-form";
import { pageForKey, type SettingsPage } from "./settings-pages";

export interface SearchEntry {
  /** The section's key */
  section: string;
  sectionTitle: string;
  /** The YAML key from the file's top level, "*" for any record key or list index: "dragons.*.adapter" */
  key: string;
  label: string;
  help: string;
  level: FieldLevel;
  group?: string;
  /** The page that edits it */
  page: SettingsPage;
}

export type MatchedBy = "key" | "label" | "help" | "section";

export interface SearchHit {
  entry: SearchEntry;
  /** What the query matched best */
  matched: MatchedBy;
  score: number;
}

const MAX_DEPTH = 8;
const MAX_ENTRIES = 5000;
const MAX_QUERY = 100;
const MAX_TOKENS = 8;

/** A key in words: "interval_seconds" is "Interval seconds". */
export function words(key: string): string {
  const text = key.replace(/[_-]+/g, " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : key;
}

/** What a field of `schema` holds that is a field too: its properties, a record's values, a list's objects ("*"). */
function children(schema: JsonSchema): [string, JsonSchema][] {
  const s = unwrap(schema);
  const out: [string, JsonSchema][] = Object.entries(s.properties ?? {});
  if (typeof s.additionalProperties === "object") out.push(["*", s.additionalProperties]);
  if (s.type === "array" && s.items) {
    const items = unwrap(s.items);
    if (items.type === "object" && items.properties) out.push(["*", items]);
  }
  return out;
}

function hintOf(section: SettingsSection, pattern: string[]): FieldHint | undefined {
  const key = pattern.join(".");
  return Object.prototype.hasOwnProperty.call(section.hints, key) ? section.hints[key] : undefined;
}

/** Every field the sections describe, once each, in the sections' order. */
export function fieldIndex(sections: readonly SettingsSection[]): SearchEntry[] {
  const entries: SearchEntry[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    const add = (keyPath: string[], pattern: string[], schema: JsonSchema, label?: string) => {
      const key = keyPath.join(".");
      if (seen.has(key) || entries.length >= MAX_ENTRIES) return;
      seen.add(key);
      const hint = hintOf(section, pattern);
      entries.push({
        section: section.key,
        sectionTitle: section.title,
        key,
        label: hint?.label ?? label ?? words(keyPath[keyPath.length - 1]),
        help: hint?.help ?? unwrap(schema).description ?? "",
        level: levelOf(hint),
        group: hint?.group,
        page: pageForKey(key),
      });
    };
    const walk = (schema: JsonSchema, keyPath: string[], pattern: string[], depth: number) => {
      if (depth > MAX_DEPTH) return;
      for (const [key, child] of children(schema)) {
        const k = [...keyPath, key];
        const p = [...pattern, key];
        if (key !== "*") add(k, p, child);
        walk(child, k, p, depth + 1);
      }
    };
    if (section.root) {
      // Its hints are keyed from the top level
      walk(section.schema, [], [], 0);
    } else {
      add([section.key], [], section.schema, section.title);
      walk(section.schema, [section.key], [], 0);
    }
  }
  return entries;
}

/** How well an entry's lower-cased key, label and help match a query (and its words); the caller knows every word is in one of them. */
function rank(key: string, label: string, help: string, q: string, tokens: string[]): [number, MatchedBy] {
  const last = key.slice(key.lastIndexOf(".") + 1);
  if (key === q || last === q) return [100, "key"];
  if (label === q) return [90, "label"];
  if (key.includes(q)) return [70, "key"];
  if (label.includes(q)) return [60, "label"];
  if (help.includes(q)) return [40, "help"];
  if (tokens.every((t) => key.includes(t) || label.includes(t))) return [30, label.includes(tokens[0]) ? "label" : "key"];
  if (tokens.every((t) => key.includes(t) || label.includes(t) || help.includes(t))) return [20, "help"];
  return [10, "section"];
}

/**
 * The fields that match `query` (every word of it, in the key, label, help
 * or section title), best first: the key or its last part exactly, then the
 * label exactly, then within the key, the label, the help; basic fields
 * before others of the same rank, shorter keys first.
 */
export function searchSettings(index: readonly SearchEntry[], query: string, limit = 12): SearchHit[] {
  const q = query.slice(0, MAX_QUERY).trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/\s+/).filter(Boolean).slice(0, MAX_TOKENS);
  const hits: SearchHit[] = [];
  for (const entry of index) {
    const key = entry.key.toLowerCase();
    const label = entry.label.toLowerCase();
    const help = entry.help.toLowerCase();
    const all = `${key} ${label} ${help} ${entry.sectionTitle.toLowerCase()}`;
    if (!tokens.every((t) => all.includes(t))) continue;
    const [base, matched] = rank(key, label, help, q, tokens);
    hits.push({ entry, matched, score: base + (entry.level === "basic" ? 2 : 0) });
  }
  hits.sort((a, b) => b.score - a.score || a.entry.key.length - b.entry.key.length || a.entry.key.localeCompare(b.entry.key));
  return hits.slice(0, limit);
}

/**
 * Where a key is shown on the classic page: its section (by its top-level
 * key, or a section's own id such as "project") and the field's path up to
 * its first "*" (a record's entries show in the record). The path is "" for
 * a whole section: a module's block, or a section id.
 */
export function fieldTarget(sections: readonly SettingsSection[], key: string): { section: string; path: string } | null {
  const parts = key.split(".").filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const byBlock = sections.find((s) => s.blocks.includes(parts[0]));
  const section = byBlock ?? sections.find((s) => s.key === parts[0]);
  if (!section) return null;
  const star = parts.indexOf("*");
  const path = star < 0 ? parts : parts.slice(0, star);
  const whole = !byBlock || (!section.root && path.length <= 1);
  return { section: section.key, path: whole ? "" : path.join(".") };
}
