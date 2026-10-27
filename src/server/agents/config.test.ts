/**
 * The `agents:` config block: defaults, validation, and the backoff rule.
 */
import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "../../shared/types.js";
import { backoffMs, parseAgentsConfig } from "./config.js";

const project = {
  name: "Demo",
  repo: "/home/user/project",
  github: "example/demo",
  queue_file: "/home/user/project/queue.md",
  agents_dir: "/home/user/project/agents",
  gates_dir: "/home/user/project/gates",
  machines: {},
  agent_adapters: {
    "other-cli": {
      id: "other-cli",
      name: "Other CLI",
      start_cmd: "other-cli --task-file {prompt_file}",
      stop_cmd: "kill -TERM {pid}",
      status_method: "file",
      log_dir: "logs",
    },
  },
} as ProjectConfig;

function errorsOf(raw: unknown): string[] {
  const parsed = parseAgentsConfig(raw, project);
  return parsed.ok ? [] : parsed.errors;
}

describe("agents config", () => {
  it("is off by default, with the documented defaults", () => {
    const parsed = parseAgentsConfig(undefined, project);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings).toMatchObject({
      enabled: false,
      intervalSeconds: 15,
      startTimeoutMinutes: 10,
      deadOnStartSeconds: 60,
      stopGraceSeconds: 30,
      recovery: { sameSessionRestarts: 2, freshSessions: 1, backoffSeconds: 30, maxBackoffSeconds: 1800 },
      retries: { maxRetries: 3, backoffSeconds: 60, maxBackoffSeconds: 3600 },
      failover: { silenceSeconds: 120, cooldownMinutes: 30, maxFailovers: 3 },
      envPassthrough: [],
      locks: [],
      fallbacks: {},
      budgets: { perAgent: {} },
    });
    expect(parsed.settings.hungMinutes).toBeUndefined();
    expect(parsed.settings.failover.rateLimit.length).toBeGreaterThan(0);
  });

  it("parses locks, fallbacks, providers and budgets", () => {
    const parsed = parseAgentsConfig(
      {
        enabled: true,
        locks: [{ name: "session-store", path: "/home/user/project/work/session.lock", hold: "run" }],
        env_passthrough: ["EXAMPLE_PROVIDER_KEY"],
        providers: { "other-cli": "provider-a" },
        fallbacks: { "worker-a": [{ adapter: "other-cli", model: "vendor/model-b", provider: "provider-b" }] },
        budgets: { agent: { daily_cost: { soft: 5, hard: 8 } }, per_agent: { "worker-a": { monthly_tokens: { hard: 1000000 } } } },
        usage_patterns: ["tokens: (?<tokens>\\d+)"],
      },
      project,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings.locks).toEqual([
      {
        name: "session-store",
        path: "/home/user/project/work/session.lock",
        pidFile: "pid",
        hold: "run",
        staleMinutes: 30,
        breakWithoutWaiter: false,
      },
    ]);
    expect(parsed.settings.envPassthrough).toEqual(["EXAMPLE_PROVIDER_KEY"]);
    expect(parsed.settings.fallbacks["worker-a"]).toEqual([
      { adapter: "other-cli", model: "vendor/model-b", provider: "provider-b" },
    ]);
    expect(parsed.settings.budgets.perAgent["worker-a"]).toEqual({ monthly_tokens: { hard: 1000000 } });
    expect(parsed.settings.usagePatterns[0].flags).toBe("gi");
  });

  it("refuses unknown keys, bad patterns, unknown adapters and contradictory limits", () => {
    expect(errorsOf({ enabled: true, restart_forever: true })[0]).toContain("agents.(root)");
    expect(errorsOf({ failover: { rate_limit_patterns: ["(unclosed"] } })[0]).toContain(
      "agents.failover.rate_limit_patterns[0]: not a valid regular expression",
    );
    expect(errorsOf({ usage_patterns: ["tokens: \\d+"] })).toEqual([
      "agents.usage_patterns[0]: needs a named group (?<tokens>...) or (?<cost>...)",
    ]);
    expect(errorsOf({ fallbacks: { "worker-a": [{ adapter: "no-such-cli" }] } })).toEqual([
      "agents.fallbacks.worker-a[0]: unknown adapter no-such-cli",
    ]);
    expect(errorsOf({ budgets: { agent: { daily_cost: { soft: 9, hard: 8 } } } })).toEqual([
      "agents.budgets.agent.daily_cost: soft (9) is above hard (8)",
    ]);
    expect(errorsOf({ session_dir: "{home}/sessions" })[0]).toContain("unknown placeholder {home}");
    expect(
      errorsOf({ locks: [{ name: "a", path: "/home/user/x.lock" }, { name: "a", path: "/home/user/y.lock" }] }),
    ).toEqual(["agents.locks: duplicate lock name a"]);
    expect(errorsOf({ fallbacks: { "worker-a": [{ adapter: "other-cli", model: "-rf" }] } })[0]).toContain(
      "agents.fallbacks.worker-a.0.model",
    );
    expect(errorsOf({ env_passthrough: ["LAIR_NODE_TOKEN"] })).toEqual([
      "agents.env_passthrough: LAIR_NODE_TOKEN: LAIR_* variables are never passed to agents",
    ]);
    expect(errorsOf({ env_passthrough: ["NOT A NAME"] })[0]).toContain("agents.env_passthrough.0");
    // In any case: some environments treat variable names case-insensitively
    expect(errorsOf({ env_passthrough: ["lair_node_token"] })).toEqual([
      "agents.env_passthrough: lair_node_token: LAIR_* variables are never passed to agents",
    ]);
  });

  it("backs off exponentially, capped", () => {
    expect([1, 2, 3, 4].map((n) => backoffMs(n, 10, 60))).toEqual([10_000, 20_000, 40_000, 60_000]);
  });
});
