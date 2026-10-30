/**
 * The planner's config: the parser the manager uses, its errors (each names
 * its field) and its warnings.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import { parsePlannerConfig } from "./config.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(planner: unknown, agents: Record<string, unknown> | undefined, inRepo = false): ProjectConfig {
  const dir = mkdtempSync(join(tmpdir(), "lair-planner-config-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const tasksFile = inRepo ? join(repo, "tasks.txt") : join(dir, "tasks.txt");
  return {
    name: "Demo",
    repo,
    queue_file: join(dir, "queue.md"),
    agents_dir: join(dir, "agents"),
    gates_dir: join(dir, "gates"),
    prompts_dir: inRepo ? join(repo, "prompts") : join(dir, "prompts"),
    machines: {},
    dragons: {
      "worker-a": { id: "worker-a", name: "A", model: "m", machine: "local", instructions: "" },
      planner: { id: "planner", name: "P", model: "m", machine: "local", instructions: "" },
    },
    agents: agents ?? { enabled: true, fill: { tasks_file: tasksFile, agents: ["worker-a"] } },
    planner: planner as Record<string, unknown>,
  } as unknown as ProjectConfig;
}

const errorsOf = (config: ProjectConfig) => {
  const parsed = parsePlannerConfig(config.planner, config);
  return parsed.ok ? [] : parsed.errors;
};

describe("planner config", () => {
  it("defaults: observe mode, fill's tasks file, allowlist and done pattern; only add and reword apply without approval", () => {
    const config = project({ enabled: true, agent: { id: "planner", prompt_file: "planner.md" } }, undefined);
    const parsed = parsePlannerConfig(config.planner, config);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const s = parsed.settings;
    expect(s.mode).toBe("observe");
    expect(s.tasksFile).toBe((config.agents as { fill: { tasks_file: string } }).fill.tasks_file);
    expect(s.allowlist).toEqual(["worker-a"]);
    expect(s.fillPatterns).toEqual({
      donePattern: "^-\\s+DONE\\s+{task}(?=\\s|$)",
      waitingPattern: "^-\\s+WAITING\\s+{task}(?=\\s|$)",
      blockedPattern: "^-\\s+BLOCKED\\s+{task}(?=\\s|$)",
      doneMatch: "task_id",
    });
    expect(s).toMatchObject({ onePerAgent: false, fillEnabled: false });
    expect(s.approval).toEqual({ add: "never", finish: "always", reassign: "always", reword: "never", drop: "always", unblock: "always" });
    expect(s.agent).toMatchObject({ maxRunsPerDay: 24, minIntervalSeconds: 600 });
    expect(s.workDir).toBe(join(config.agents_dir, "lair-planner"));
    expect(s.doneMarker).toBe("#done ");
    expect(s.warnings).toEqual([]);
  });

  it("refuses what would let the planner reach past fill: another tasks file, an allowlisted or unknown planner agent, a '..' prompt", () => {
    const config = project({ enabled: true, tasks_file: "/elsewhere/tasks.txt" }, undefined);
    expect(errorsOf(config)).toEqual([expect.stringContaining("planner.tasks_file: must be agents.fill.tasks_file")]);

    const listed = project({ enabled: true, agent: { id: "worker-a", prompt_file: "p.md" } }, undefined);
    expect(errorsOf(listed)).toEqual(["planner.agent.id: worker-a is in agents.fill.agents: the planner agent must not be an agent fill starts"]);

    const unknown = project({ enabled: true, agent: { id: "ghost", prompt_file: "../p.md" } }, undefined);
    expect(errorsOf(unknown)).toEqual([
      "planner.agent.id: ghost is not one of the project's agents",
      'planner.agent.prompt_file: a ".." segment is refused (it stays inside prompts_dir)',
    ]);
  });

  it("needs the agents module and fill's tasks file; unknown keys and bad patterns are errors", () => {
    expect(errorsOf(project({ enabled: true }, { enabled: false, fill: { tasks_file: "/t.txt", agents: [] } }))).toEqual([
      "planner.enabled: the planner needs agents.enabled: true",
    ]);
    expect(errorsOf(project({ enabled: true }, { enabled: true }))).toEqual([
      "planner: agents.fill.tasks_file must be set (the planner keeps that file)",
    ]);
    expect(errorsOf(project({ enabled: true, extra: 1 }, undefined))[0]).toContain("planner.(root): Unrecognized key(s)");
    expect(
      errorsOf(project({ enabled: true, sources: [{ kind: "markdown_plan", paths: ["p.md"], id_pattern: "^[A-Z]+-\\d+" }] }, undefined)),
    ).toEqual(["planner.sources[0].id_pattern: needs a named group (?<id>...) or a capture group"]);
    expect(errorsOf(project({ enabled: true, sources: [{ kind: "queue_events" }, { kind: "queue_events" }] }, undefined))).toEqual([
      "planner.sources[1]: only one queue_events source",
    ]);
    expect(
      errorsOf(project({ enabled: true, sources: [{ kind: "queue_events", name: "q" }, { kind: "owner_messages", name: "q", path: "m.md" }] }, undefined)),
    ).toEqual(["planner.sources[1].name: q is used by another source"]);
    expect(errorsOf(project({ enabled: true, done_marker: "done" }, undefined))[0]).toContain("planner.done_marker");
  });

  it("warns when the tasks file or the prompts are inside the repository the agents work in", () => {
    const config = project({ enabled: true, agent: { id: "planner", prompt_file: "planner.md" } }, undefined, true);
    const parsed = parsePlannerConfig(config.planner, config);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    expect(parsed.settings.warnings).toEqual([
      expect.stringContaining("the tasks file"),
      expect.stringContaining("prompts_dir"),
    ]);
  });

  it("warns when a plan or the owner's messages come from inside the repository: an agent could write them", () => {
    const config = project(
      {
        enabled: true,
        agent: { id: "planner", prompt_file: "planner.md" },
        sources: [
          { kind: "markdown_plan", paths: ["docs/plan.md"] },
          { kind: "owner_messages", path: "inbox.md" },
          { kind: "backlog_file", paths: ["/elsewhere/backlog.md"] },
        ],
      },
      undefined,
    );
    const parsed = parsePlannerConfig(config.planner, config);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    expect(parsed.settings.warnings).toEqual([
      expect.stringMatching(/^source markdown-plan: .*docs\/plan\.md is inside the repository .*drop a task from the tasks file by ticking it \[x\] \(drop_plan_done\)$/),
      expect.stringMatching(/^source owner-messages: .*inbox\.md is inside the repository the agents work in: an agent can write "owner" messages$/),
    ]);
    // Without drop_plan_done the plan can't remove a line, but it still steers the planner
    const noDrop = project({ ...(config.planner as object), drop_plan_done: false }, undefined);
    const quiet = parsePlannerConfig(noDrop.planner, noDrop);
    if (!quiet.ok) throw new Error(quiet.errors.join("; "));
    expect(quiet.settings.warnings[0]).toMatch(/an agent can change what the planner reads$/);
  });
});
