/**
 * Registry tests: every field in the Work and Gates pages has its own hint
 * with a label and help (settings-v2.md requirement "every field has a label,
 * help and a default"), list and record entry fields included.
 */
import { describe, expect, it } from "vitest";
import { settingsSections, SETTINGS_SECTIONS } from "./registry.js";
import { fieldIndex } from "../../client/settings-search";
import { pageForKey } from "../../client/settings-pages";

describe("registry hints for Work and Gates pages", () => {
  const sections = settingsSections(SETTINGS_SECTIONS);
  const index = fieldIndex(sections);

  // Fields routed to the Work page
  const workFields = index.filter((e) => pageForKey(e.key) === "work");

  // Fields routed to the Gates page
  const gatesFields = index.filter((e) => pageForKey(e.key) === "gates");

  it("has fields for the Work page (agents block)", () => {
    expect(workFields.length).toBeGreaterThan(0);
    // Basic fields should exist
    const keys = workFields.map((f) => f.key);
    expect(keys).toContain("agents");
    expect(keys.some((k) => k.startsWith("agents.fill"))).toBe(true);
    expect(keys.some((k) => k.startsWith("agents.recovery"))).toBe(true);
  });

  it("has fields for the Gates page (pipelines, executors, triage, placement blocks)", () => {
    expect(gatesFields.length).toBeGreaterThan(0);
    const keys = gatesFields.map((f) => f.key);
    expect(keys).toContain("pipelines");
    expect(keys).toContain("executors");
    expect(keys).toContain("triage");
    expect(keys).toContain("placement");
  });

  /** The section's own hint for an index entry (its key without the section prefix), list and record entries ("*") too */
  const hintFor = (entry: (typeof index)[number]) => {
    const section = sections.find((s) => s.key === entry.section)!;
    const pattern = entry.key.slice(entry.section.length + 1);
    return Object.prototype.hasOwnProperty.call(section.hints, pattern) ? section.hints[pattern] : undefined;
  };
  /** Every field under a section root, "*" keys (list items, record entries) included */
  const nonRoot = (fields: typeof index) => fields.filter((f) => f.key !== f.section);

  it("covers list and record entry fields (* keys) on both pages", () => {
    const keys = index.map((f) => f.key);
    for (const key of [
      "agents.locks.*.name",
      "agents.locks.*.stale_minutes",
      "placement.machines.*.on_demand.state_cmd",
      "placement.machines.*.on_demand.touch_seconds",
      "pipelines.*.steps.*.name",
      "triage.trusted_nodes.*.id",
    ]) {
      expect(keys, key).toContain(key);
    }
  });

  it("every Work page field has its own hint label and help", () => {
    const missing = nonRoot(workFields)
      .filter((f) => !hintFor(f)?.label || !hintFor(f)?.help)
      .map((f) => f.key);
    expect(missing.join(" ")).toBe("");
  });

  it("every Gates page field has its own hint label and help", () => {
    const missing = nonRoot(gatesFields)
      .filter((f) => !hintFor(f)?.label || !hintFor(f)?.help)
      .map((f) => f.key);
    expect(missing.join(" ")).toBe("");
  });

  it("no two Gates fields in one group share a label", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const f of nonRoot(gatesFields)) {
      const hint = hintFor(f);
      if (!hint?.label || !hint.group) continue;
      const id = `${f.section}/${hint.group}/${hint.label}`;
      if (seen.has(id)) dupes.push(`${seen.get(id)} and ${f.key}: ${hint.label}`);
      else seen.set(id, f.key);
    }
    expect(dupes.join("; ")).toBe("");
  });
});

describe("search finds all Work and Gates fields", () => {
  const sections = settingsSections(SETTINGS_SECTIONS);
  const index = fieldIndex(sections);

  it("agents.fill fields are indexed and searchable", () => {
    const fillFields = index.filter((e) => e.key.startsWith("agents.fill"));
    expect(fillFields.length).toBeGreaterThan(3);
    // Should have the basic fill fields
    const keys = fillFields.map((f) => f.key);
    expect(keys).toContain("agents.fill.enabled");
    expect(keys).toContain("agents.fill.tasks_file");
    expect(keys).toContain("agents.fill.max_active");
  });

  it("triage fields are indexed and searchable", () => {
    const triageFields = index.filter((e) => e.key.startsWith("triage"));
    expect(triageFields.length).toBeGreaterThan(5);
    const keys = triageFields.map((f) => f.key);
    expect(keys).toContain("triage.enabled");
    expect(keys).toContain("triage.mode");
  });

  it("placement fields are indexed and searchable", () => {
    const placementFields = index.filter((e) => e.key.startsWith("placement"));
    expect(placementFields.length).toBeGreaterThan(3);
    const keys = placementFields.map((f) => f.key);
    expect(keys).toContain("placement.enabled");
    expect(keys).toContain("placement.mode");
  });

  it("executors fields are indexed and searchable", () => {
    const executorsFields = index.filter((e) => e.key.startsWith("executors"));
    expect(executorsFields.length).toBeGreaterThan(3);
    const keys = executorsFields.map((f) => f.key);
    expect(keys).toContain("executors.order");
  });
});
