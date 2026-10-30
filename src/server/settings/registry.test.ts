/**
 * Registry tests: every field in the Work and Gates pages has a label
 * (settings-v2.md requirement "every field has a label, help and a default").
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

  it("every Work page field has a non-empty label", () => {
    for (const field of workFields) {
      // Fields with "*" in the path are record/list entries; they may have generic labels
      if (field.key.includes("*")) continue;
      expect(field.label.length, `${field.key} should have a label`).toBeGreaterThan(0);
    }
  });

  it("every Gates page field has a non-empty label", () => {
    for (const field of gatesFields) {
      if (field.key.includes("*")) continue;
      expect(field.label.length, `${field.key} should have a label`).toBeGreaterThan(0);
    }
  });

  it("basic agents fields have help text", () => {
    const basicAgents = workFields.filter((f) => f.level === "basic" && !f.key.includes("*"));
    for (const field of basicAgents) {
      expect(field.help.length, `${field.key} should have help`).toBeGreaterThan(0);
    }
  });

  it("basic gates fields have help text", () => {
    const basicGates = gatesFields.filter((f) => f.level === "basic" && !f.key.includes("*"));
    for (const field of basicGates) {
      expect(field.help.length, `${field.key} should have help`).toBeGreaterThan(0);
    }
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
