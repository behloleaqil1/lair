/**
 * The triage: block (defaults, validation) and the command adapters' argv
 * building (list placeholders, refused option-like values).
 */
import { describe, expect, it } from "vitest";
import { actBlockedReason, DEFAULT_CONTEXT_PATTERNS, DEFAULT_INFRA_PATTERNS, parseTriageConfig } from "./config.js";
import { fillArgv, formatDecision } from "./adapters.js";
import { projectConfig } from "./test-harness.js";

describe("parseTriageConfig", () => {
  it("is off and in observe mode by default, with the built-in patterns", () => {
    const parsed = parseTriageConfig(undefined);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    expect(parsed.settings).toMatchObject({
      enabled: false,
      mode: "observe",
      defaultBranch: "main",
      actions: { infra: "recheck", preExisting: "fix_task", code: "route" },
      recheck: { maxRetries: 1, maxConcurrent: 1 },
      flaky: { ticketAfter: 2, quarantine: true },
      bisect: { enabled: true, revert: "propose" },
      commands: {},
    });
    expect(parsed.settings.infraPatterns.map((p) => p.id)).toEqual(DEFAULT_INFRA_PATTERNS.map((p) => p.id));
    expect(parsed.settings.contextPatterns).toHaveLength(DEFAULT_CONTEXT_PATTERNS.length);
  });

  it("puts a project's patterns first, and one with a built-in's id replaces it", () => {
    const parsed = parseTriageConfig({
      infra_patterns: [
        { id: "dns", kind: "network", pattern: "resolver is down" },
        { id: "vpn", kind: "network", pattern: "vpn tunnel closed" },
      ],
    });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const ids = parsed.settings.infraPatterns.map((p) => p.id);
    expect(ids.slice(0, 2)).toEqual(["dns", "vpn"]);
    expect(ids.filter((id) => id === "dns")).toHaveLength(1);
    expect(parsed.settings.infraPatterns[0].regex.test("the resolver is DOWN")).toBe(true);
  });

  it("refuses unknown keys, bad patterns and unknown placeholders", () => {
    const bad = parseTriageConfig({
      enabled: true,
      infra_patterns: [{ id: "x", kind: "network", pattern: "(" }],
      commands: { recheck: ["./bin/recheck", "{sha}", "{password}"] },
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.some((e) => e.startsWith("triage.infra_patterns.0.pattern: not a valid regular expression"))).toBe(true);
    expect(bad.errors).toContain(
      "triage.commands.recheck: unknown placeholder {password} (allowed: {request}, {purpose}, {sha}, {branch}, {gate}, {steps}, {tests}, {classes}, {attempt}, {project})",
    );
    const unknown = parseTriageConfig({ enabled: true, retry: 3 });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.errors[0]).toContain("Unrecognized key(s) in object: 'retry'");
    const kind = parseTriageConfig({ infra_patterns: [{ id: "x", kind: "weather", pattern: "rain" }] });
    expect(kind.ok).toBe(false);
  });

  it("act mode is blocked by observe mode and by read_only", () => {
    const parsed = parseTriageConfig({ enabled: true, mode: "act" });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    expect(actBlockedReason(projectConfig("/home/user/project", {}), parsed.settings)).toBeNull();
    expect(actBlockedReason(projectConfig("/home/user/project", {}, { read_only: true }), parsed.settings)).toBe(
      "the project is read_only",
    );
  });
});

describe("command argv", () => {
  it("spreads a list placeholder into arguments and joins it inside one", () => {
    expect(
      fillArgv("recheck", ["run", "--steps={steps}", "{tests}"], { steps: ["unit", "it"], tests: ["a#x", "b#y"] }),
    ).toEqual({ argv: ["run", "--steps=unit,it", "a#x", "b#y"] });
  });

  it("refuses values that would be read as options", () => {
    expect(fillArgv("recheck", ["run", "{tests}"], { tests: ["--delete-everything"] })).toEqual({
      error: 'triage.commands.recheck: an item of {tests} starts with "-" and would be read as an option',
    });
    expect(fillArgv("notify_agent", ["send", "{agent}"], { agent: "-rf" })).toEqual({
      error: 'triage.commands.notify_agent: a value starts with "-" and would be read as an option',
    });
    expect(fillArgv("notify_agent", ["send", "--to={agent}"], { agent: "-rf" })).toEqual({ argv: ["send", "--to=-rf"] });
    expect(fillArgv("notify_agent", ["send", "{agent}"], {})).toEqual({ error: "triage.commands.notify_agent: no value for {agent}" });
  });

  it("formats a decision as an OWNER? line the Decision Inbox importers read", () => {
    const text = formatDecision(
      {
        project: "demo",
        subject: "revert:0123abcd-0000-4000-8000-000000000000",
        kind: "other",
        question: "Revert 6d330000 to make main green again?",
        context: ["main is red since 6d330000"],
        options: ["revert", "keep and fix forward"],
        recommended: "revert",
        why: "Bisect proved it.",
        reversible: true,
        onTimeout: "wait",
        requestedBy: "triage",
      },
      "2026-01-01T12:00:00.000Z",
    );
    expect(text).toBe(
      "- OWNER? 2026-01-01T12:00:00.000Z [triage:revert:0123abcd] demo: Revert 6d330000 to make main green again? Options: revert | keep and fix forward (recommended: revert). Bisect proved it.\n  - main is red since 6d330000\n",
    );
  });
});
