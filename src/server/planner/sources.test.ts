/**
 * The planner's sources, through the production parsers and readers on real
 * files in a temp dir: each kind parses, input is bounded, and paths that
 * leave the configured roots (directly or through a symlink) are refused.
 */
import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import {
  DEFAULT_DEPENDS_PATTERN,
  DEFAULT_ID_PATTERN,
  DEFAULT_PHASE_PATTERN,
  type OwnerSourceSettings,
  type PlanSourceSettings,
  type QueueSourceSettings,
} from "./config.js";
import { namesTask, readOwnerMessages, readPlanSource, readQueueEvents, reasonOf } from "./sources.js";
import { classifyBlocked } from "./blocked.js";
import { parsePlannerConfig } from "./config.js";
import type { ProjectConfig } from "../../shared/types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "lair-planner-src-"));
  dirs.push(dir);
  return dir;
}

function plan(paths: string[], over: Partial<PlanSourceSettings> = {}): PlanSourceSettings {
  return {
    kind: "markdown_plan",
    name: "plan",
    paths,
    format: "markdown",
    idPattern: new RegExp(DEFAULT_ID_PATTERN),
    phasePattern: new RegExp(DEFAULT_PHASE_PATTERN, "i"),
    dependsPattern: new RegExp(DEFAULT_DEPENDS_PATTERN, "gi"),
    donePattern: null,
    idColumn: 1,
    maxBytes: 1024 * 1024,
    maxLines: 20_000,
    ...over,
  };
}

describe("markdown_plan", () => {
  it("reads checkbox tasks with ids, sections, phases, details and dependencies; code blocks are skipped", () => {
    const dir = tmp();
    const file = join(dir, "plan.md");
    writeFileSync(
      file,
      [
        "# Project plan",
        "## Phase 2 — Search",
        "**Backend**",
        "- [x] S-1: Search index",
        "- [ ] S-2: Search API, depends on S-1",
        "  - paging and filters",
        "  - rate limits",
        "* [ ] S-3: Search page (depends on S-2 and S-9)",
        "- [ ] A line with no id",
        "```",
        "- [ ] S-4: inside a code block",
        "```",
        "## Risks",
        "- [ ] S-5: Risk review",
      ].join("\n"),
    );
    const read = readPlanSource(plan([file]), [dir]);

    expect(read.status).toMatchObject({ ok: true, tasks: 5, open: 4, done: 1, withoutId: 1, duplicates: 0 });
    const byId = Object.fromEntries(read.tasks.map((t) => [t.id ?? `line ${t.line}`, t]));
    expect(byId["S-1"]).toMatchObject({ done: true, phase: "2", section: "Project plan > Phase 2 — Search > Backend", line: 4 });
    expect(byId["S-2"]).toMatchObject({ done: false, dependsOn: ["S-1"], details: ["- paging and filters", "- rate limits"] });
    expect(byId["S-3"].dependsOn).toEqual(["S-2", "S-9"]);
    expect(byId["line 9"]).toMatchObject({ id: null, text: "A line with no id" });
    expect(read.tasks.map((t) => t.id)).not.toContain("S-4");
    expect(byId["S-5"]).toMatchObject({ phase: null, section: "Project plan > Risks" });
  });

  it("is bounded: a file over max_bytes is refused, lines past max_lines are not read, long lines are cut", () => {
    const dir = tmp();
    const big = join(dir, "big.md");
    writeFileSync(big, `- [ ] B-1: ${"x".repeat(5000)}\n`);
    expect(readPlanSource(plan([big], { maxBytes: 1000 }), [dir]).status.files[0]).toMatchObject({
      ok: false,
      error: `${big} is larger than 1000 bytes (5012)`,
    });
    const read = readPlanSource(plan([big]), [dir]);
    expect(read.tasks[0].text.length).toBeLessThanOrEqual(500);

    const many = join(dir, "many.md");
    writeFileSync(many, Array.from({ length: 50 }, (_, i) => `- [ ] M-${i}: task ${i}`).join("\n"));
    const cut = readPlanSource(plan([many], { maxLines: 10 }), [dir]);
    expect(cut.tasks).toHaveLength(10);
    expect(cut.status.files[0]).toMatchObject({ truncated: true, lines: 10 });
  });

  it("refuses a path outside the roots, a symlink out of them, a directory and a FIFO; a repeated id counts once", () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "secret.md"), "- [ ] X-1: a secret\n");
    symlinkSync(join(outside, "secret.md"), join(root, "link.md"));
    mkdirSync(join(root, "dir.md"));
    const fifo = join(root, "fifo.md");
    execFileSync("mkfifo", [fifo]);
    writeFileSync(join(root, "dup.md"), "- [ ] D-1: one\n- [ ] D-1: two\n");

    const read = readPlanSource(plan([join(outside, "secret.md"), join(root, "link.md"), join(root, "dir.md"), fifo, join(root, "dup.md")]), [root]);
    const errors = read.status.files.map((f) => f.error);
    expect(errors[0]).toContain("is outside the configured roots");
    expect(errors[1]).toContain("is a symlink out of the configured roots");
    expect(errors[2]).toContain("is not a regular file");
    expect(errors[3]).toContain("is not a regular file");
    expect(errors[4]).toBeNull();
    expect(read.status.ok).toBe(false);
    expect(read.tasks.map((t) => t.text)).toEqual(["D-1: one", "D-1: two"]);
    expect(read.tasks.map((t) => t.id)).toEqual(["D-1", null]);
    expect(read.status.duplicates).toBe(1);
    // Nothing of the secret was read
    expect(JSON.stringify(read)).not.toContain("a secret");
  });
});

describe("backlog_file", () => {
  it("reads a table: one task per row, the id from a column, done by done_pattern", () => {
    const dir = tmp();
    const file = join(dir, "backlog.md");
    writeFileSync(
      file,
      [
        "# Backlog",
        "## Ready",
        "| # | What | Status |",
        "|---|---|---|",
        "| R1 | Search page | DONE: merged |",
        "| R2 (Bob) | Cart, depends on R1 | building |",
        "| not an id | Something | |",
        "",
        "Text between tables.",
      ].join("\n"),
    );
    const read = readPlanSource(
      plan([file], {
        kind: "backlog_file",
        name: "backlog",
        format: "table",
        idPattern: /^(?<id>R\d+)\b/,
        donePattern: /\bdone\b/i,
      }),
      [dir],
    );
    expect(read.tasks.map((t) => [t.id, t.done, t.section])).toEqual([
      ["R1", true, "Backlog > Ready"],
      ["R2", false, "Backlog > Ready"],
      [null, false, "Backlog > Ready"],
    ]);
    expect(read.tasks[1].dependsOn).toEqual(["R1"]);
  });

  it("reads list items as tasks with the list format", () => {
    const dir = tmp();
    const file = join(dir, "backlog.md");
    writeFileSync(file, "- L-1: first\n- L-2: second (done)\n1. L-3: third\n");
    const read = readPlanSource(plan([file], { kind: "backlog_file", format: "list", donePattern: /\(done\)/ }), [dir]);
    expect(read.tasks.map((t) => [t.id, t.done])).toEqual([
      ["L-1", false],
      ["L-2", true],
      ["L-3", false],
    ]);
  });
});

describe("owner_messages", () => {
  it("reads unanswered OWNER lines (parsers/inbox.ts), newest max_messages, from the end of a bounded tail", () => {
    const dir = tmp();
    const inbox = join(dir, "inbox.md");
    const outbox = join(dir, "outbox.md");
    writeFileSync(
      inbox,
      [
        "- OWNER 2026-03-02T10:00:00Z [a1]: Answered already",
        "- OWNER 2026-03-02T11:00:00Z [a2]: Do search first",
        "not a message",
        "- OWNER 2026-03-02T11:30:00Z [a3]: Then the cart",
      ].join("\n"),
    );
    writeFileSync(outbox, "- REPLY a1 2026-03-02T10:05:00Z by orchestrator: done\n");
    const source: OwnerSourceSettings = {
      kind: "owner_messages",
      name: "owner",
      path: inbox,
      repliesPath: outbox,
      projectFile: true,
      maxMessages: 1,
      maxBytes: 4096,
    };
    const read = readOwnerMessages(source, []);
    expect(read.messages).toEqual([{ id: "a3", at: "2026-03-02T11:30:00Z", text: "Then the cart" }]);
    expect(readOwnerMessages({ ...source, maxMessages: 10 }, []).messages.map((m) => m.id)).toEqual(["a2", "a3"]);
    // A missing file is no messages, not an error
    expect(readOwnerMessages({ ...source, path: join(dir, "none.md") }, []).status.ok).toBe(true);
    // A configured path outside the roots is refused
    expect(readOwnerMessages({ ...source, projectFile: false }, [tmp()]).status.files[0].error).toContain("outside the configured roots");
  });
});

describe("queue_events", () => {
  it("gives the lines written since the cursor: a first read is a baseline, a rewritten file a new one", () => {
    const dir = tmp();
    const file = join(dir, "queue.md");
    writeFileSync(file, "- DONE old-task by worker-a 09:00Z: long ago\n");
    const source: QueueSourceSettings = { kind: "queue_events", name: "queue", path: file, projectFile: true, maxEvents: 2 };

    const first = readQueueEvents(source, [], null);
    expect(first).toMatchObject({ events: [], reset: true });
    appendFileSync(file, "- BLOCKED feat-a by worker-a 12:00Z: docker is down\n- WAITING feat-b by worker-b 12:01Z: gate\n- DONE feat-c by worker-a 12:02Z: merged\n- PROG");
    const second = readQueueEvents(source, [], first.cursor);
    // At most max_events (the newest), and the line still being written waits
    expect(second.events.map((e) => [e.type, e.agent])).toEqual([
      ["WAITING", "worker-b"],
      ["DONE", "worker-a"],
    ]);
    appendFileSync(file, "RESS feat-d by worker-b 12:03Z: half way\n");
    const third = readQueueEvents(source, [], second.cursor);
    expect(third.events.map((e) => e.text)).toEqual(["- PROGRESS feat-d by worker-b 12:03Z: half way"]);

    writeFileSync(file, "- DONE everything by worker-a 13:00Z: a rewritten file\n");
    expect(readQueueEvents(source, [], third.cursor)).toMatchObject({ events: [], reset: true });
  });

  it("finds a task id as a whole token and the reason after the first ': '", () => {
    expect(namesTask("- BLOCKED feat/login-2 by a: x", "feat/login")).toBe(false);
    expect(namesTask("- BLOCKED feat/login by a: x", "feat/login")).toBe(true);
    expect(namesTask("- DONE (feat-x): merged", "feat-x")).toBe(true);
    expect(reasonOf("- BLOCKED t by worker-a 12:00Z: the scope is unclear")).toBe("the scope is unclear");
  });
});

describe("BLOCKED reasons", () => {
  const config = {
    name: "Demo",
    repo: "/nonexistent/repo",
    queue_file: "/nonexistent/queue.md",
    agents_dir: "/nonexistent/agents",
    gates_dir: "/nonexistent/gates",
    machines: {},
  } as unknown as ProjectConfig;
  const parsed = parsePlannerConfig({}, config);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const patterns = parsed.settings.blocked;

  it("owner first, then environment; anything else is a task problem", () => {
    expect(classifyBlocked("the protected path needs owner approval", patterns).class).toBe("owner");
    expect(classifyBlocked("gate policy requires approval for .github", patterns).class).toBe("owner");
    expect(classifyBlocked("permission denied writing /var/lib/x", patterns).class).toBe("environment");
    expect(classifyBlocked("docker daemon not running", patterns).class).toBe("environment");
    expect(classifyBlocked("the gate is stuck on the remote runner", patterns).class).toBe("environment");
    expect(classifyBlocked("waiting for load < 40", patterns).class).toBe("environment");
    expect(classifyBlocked("ENOSPC: no space left on device", patterns).class).toBe("environment");
    expect(classifyBlocked("waiting on #183 for the backend APIs", patterns)).toEqual({ class: "task", rule: "default" });
    expect(classifyBlocked("the task says cart but the plan says checkout", patterns).class).toBe("task");
  });
});
