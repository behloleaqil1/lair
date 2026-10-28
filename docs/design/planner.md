# Planner: Lair keeps the task list itself (module `planner`)

Status: built in `src/server/planner/` (see [configuration](../configuration.md#planner)). This is the first step of
[autonomy.md §4](autonomy.md#4-planner-work-comes-from-documents-not-prompts-module-planner): it maintains the task
list that [fill](../configuration.md#fill) starts runs from. Task cards, the dependency graph across documents and
docs PRs that tick the plan come later.

## The problem

Fill starts agent runs from a tasks file (`<agent>|<name>|<task>|<description>` lines), but nothing in Lair keeps that
file current. A project that runs many agents usually has a free-running "orchestrator" agent for that job: every few
minutes it reads the project plan (markdown checklists), a backlog, the owner's messages and the agents' queue lines
(`DONE`, `BLOCKED`, `WAITING`), then hand-edits the tasks file. That agent has write access to the file fill reads,
so whatever it writes, every allowlisted agent works on; it runs whether or not anything changed; and nothing checks
what it wrote.

The planner splits that job in two:

- a **deterministic part**, code with no agent, which does what rules can do: mark a task done when the queue reports
  it, drop a task the plan marks done, keep the file valid, and record every change with its reason;
- a **judgment part**, a planner agent that runs only when something happened, and whose only output is a proposal
  file that Lair checks before anything changes.

## Sources

Every source is configured, generic, bounded and path-checked:

| Kind | What it reads | What the planner takes from it |
|---|---|---|
| `markdown_plan` | Markdown files with checkbox tasks (`- [ ] <id>: text`, `- [x] ...`) | Tasks with an id (configurable `id_pattern`), done or open, their section and phase headings, sub-bullets as details, and `depends on <id>` markers (configurable) |
| `backlog_file` | One task per line: checklist (default), list items, or table rows | The same task model; list and table rows are done when `done_pattern` matches |
| `owner_messages` | The owner's message file (`inbox_file`: `- OWNER <time> [<id>]: <text>`), replies in `outbox_file` | Unanswered messages; a new one is a trigger |
| `queue_events` | The queue file the agents report to (`queue_file`) | Lines written since the last cycle: `DONE`, `BLOCKED`, `WAITING` and the rest |

A line without an id is still an open task in the planner's context (shown with its line number), but it is never
matched against the tasks file: only ids are. Ids are what make the plan and the tasks file agree.

Bounds: each file is read up to `max_bytes` (whole files; larger ones are refused, not cut) and `max_lines`; each line
is cut at 2,000 characters before any regular expression sees it; fenced code blocks are skipped. Paths are resolved
against the repository, must lie inside a configured root (`repo`, `agents_dir`, `planner.roots`), and are checked
again after symlinks are resolved, so a symlink can't lead out. The final component is opened without following a
symlink and without blocking on a FIFO, and must be a regular file. The queue file and the owner's message files
default to the project's own `queue_file`, `inbox_file` and `outbox_file`.

## The deterministic part

Every `interval_seconds` a cycle:

1. reads the tasks file (fill's parser, fill's bounds) and compares it with the last content Lair wrote or accepted;
2. reads the sources;
3. **done**: a task whose done line is in the queue, by fill's own done detection (the shared `checkDone` in
   `agents/fill.ts`: fill's kept record first, then the queue lines written since the task's latest run started, the
   whole window for a task Lair never ran), becomes `#done <line>` (`done_marker`). `mark_done: lair_runs` limits this
   to tasks the agents module has run, for projects where another launcher still runs some tasks and reuses task ids;
4. **plan done**: a line whose task id is a plan task marked `[x]` is dropped (`drop_plan_done`);
5. routes new `BLOCKED` lines and collects triggers (below).

Every change is one history row: what, why, the lines before and after, and whether it was applied or only planned.
In **act** mode the file is written atomically: a temporary file in the same directory, fsynced, then renamed over
the tasks file, and only if the file still has the content the change was computed from. Lair refuses to write a
tasks file that is a symlink. A write records its intent in the store first, so a restart in the middle finds out
whether the rename happened and finishes or rolls back the history. In **observe** mode nothing is written: the
changes are recorded as `planned`, once each.

Lair never makes the file invalid: every edit is re-parsed with fill's parser, and an edit that would add a malformed
line, a duplicate task, a task past the 200-task cap, or a file over 256 KB is refused. Lines Lair writes name only
allowlisted agents. Existing malformed lines are reported, not rewritten.

An edit by anyone else (the owner, another tool) between planner runs is accepted and recorded as `external` with its
diff.

## The judgment part

### Triggers

- an allowlisted agent reports `DONE` and has no open line left;
- an agent reports `BLOCKED` and the reason reads as a task problem (see below);
- allowlisted agents are idle: no active run and no open line (once per idle set: an edit of the tasks file that
  leaves the same agents idle is no new trigger);
- a new owner message;
- a plan or backlog file changed.

The first cycle only records a baseline (the queue's end, the messages and file hashes it sees), so history never
triggers. Triggers are kept in the store. A run starts when the newest trigger is `debounce_seconds` old, at least
`min_interval_seconds` after the previous run started, fewer than `max_runs_per_day` runs started in the 24 hours
before, and no planner run is active: many triggers make one run, and no stream of them makes more than the cap.

### The run

Lair starts a run of the configured planner agent (any adapter) through the agents module's in-process
`requestRun`, so claims, locks, recovery, failover and budgets apply as for any run. The planner agent must be a
known agent and must not be in `agents.fill.agents`: fill never gives it a task, and it is never a task's assignee.

Its prompt is the template file (`agent.prompt_file`, read from `prompts_dir` with fill's prompt-file rules: no `..`,
no symlink out, a regular file of at most 200 KB), then a section Lair writes: the proposal file's path, the schema,
the rules, and the context bundle. The bundle is JSON in a fenced block, introduced as data: the triggers, the
allowlist and idle agents, the tasks file's lines (and done tasks), open plan and backlog tasks (ready ones and those
the triggers name first) with their details, recent queue events, unanswered owner messages, and blocked tasks. Every
string is stripped of control characters and cut; arrays are capped; the bundle is cut to `context_max_bytes`. JSON
string escaping means no text from an agent, the plan or a message can start a line of its own in the prompt. The
same bundle is written to `context.json` in the run's directory.

Each run gets a fresh directory under `work_dir` (random name, mode 0700). The proposal file is `proposals.json`
there. It is the agent's only output:

```json
{"proposals": [{"op": "add", "task": "feat-search", "agent": "worker-b", "text": "Search page", "reason": "ready in the plan"}]}
```

`op` is one of `add`, `finish`, `reassign`, `reword`, `drop`, `unblock`.

### Checks

When the run ends, Lair reads the proposal file (a regular file inside the run directory, no symlink, at most 256 KB,
valid JSON) and checks each proposal in order against:

- the schema (unknown keys are refused);
- task-id rules (fill's: 1-128 characters, no leading `-`, no `.` or `..` segment; plus `task_id_pattern`);
- the allowlist (`agents.fill.agents`; never the planner agent);
- the tasks file: `add` needs a new task id (not an open line, not a done line); the others need an open line;
  `reassign` and `drop` are refused while the task has an active run; one proposal per task per run;
- blocked tasks: `unblock` needs a task the planner recorded as blocked by a task problem, with an attempt left;
  neither `unblock` nor `reword` may touch a task the owner chose to leave blocked;
- bounds: `text` is one line of at most 500 characters after cleaning; `reason` at most 500; the cap of
  `max_proposals` (the rest are refused); the file's own bounds after the edit.

A refused proposal is stored with its reason. A run whose agent didn't complete, wrote no file or a malformed one
fails; its triggers wait for the next run; after `max_failed_runs` failures in a row, planner runs pause and the owner
is asked once.

### Applying

- **act**: accepted proposals are applied, except ops marked `approval: always`, which wait for the owner. By
  default only `add` and `reword` apply by themselves: `finish` waits (a done line in the queue is the rules' job, so
  a finish of the planner's own has none behind it), and so do `reassign`, `drop` and `unblock` (it starts again work
  fill held);
- **observe**: every accepted proposal waits for the owner.

Waiting proposals are listed in the Planner view, where the owner approves or rejects each one, or a whole run, with a
confirmation; and each run with waiting proposals raises **one** Decision Inbox item ("approve all" / "reject all").
An approval is checked again against the tasks file as it is then, and applied with the same atomic write. A decision
made moot in the view is withdrawn.

Op effects: `add` appends `<agent>|<name>|<task>|<text>`, with the agent's name from the project's agent registry;
`finish` marks the line done; `reassign` changes the agent and name; `reword` changes the description; `drop` removes
the line; `unblock` releases fill's `blocked` or `no_done` hold on the task (a run that stopped without done and said
so; fill's `owner`, `waiting` and `waited_too_long` holds stay the owner's) and clears the planner's blocked record.

### What the agent can't do

- **Edit the tasks file.** Lair keeps the content it last wrote or accepted. In act mode, a change made while a planner
  run is active is restored, the run's proposals are refused, and the owner gets a decision with the diff (continue, or
  pause the planner). In observe mode, where another tool may still own the file, the change is recorded as external
  with a note, and nothing is restored. Running agents as a separate OS user is what makes the file unwritable for
  them (see [autonomy.md §6](autonomy.md#6-agents-budgets-failover-and-session-recovery-module-agents)).
- **Reach another agent's prompt.** Its `text` only becomes a description, which fill shows and never puts in a
  prompt. What a worker does comes from its prompt files and its task id, and task ids carry no instructions (a
  restricted character set, 128 characters). The planner agent's own text reaches its next run only inside the JSON
  bundle.
- **Decide for the owner.** Finishes, reassignments, drops and unblocks wait for approval by default; observe mode
  waits for everything. A task the owner left blocked is out of its reach.
- **Pass off a file anyone can write as the owner's.** Owner messages are only as trustworthy as the file they come
  from, and its prompt says so; a plan, backlog or message file inside the repository is a config warning (an agent
  could write it, and with `drop_plan_done` a ticked `[x]` drops a task).

## BLOCKED handling

A new `BLOCKED` queue line is mapped to a task (its id written in the line, else the reporting agent's only open
line) and its reason (the text after the first `: `) is classified by configurable, case-insensitive patterns,
checked in this order:

1. **owner** (approval, decisions, credentials, accounts, billing, legal...): an owner decision with the reason;
2. **environment** (permission denied, disk full, out of memory, docker, network, timeouts, load, locks, stuck
   runners...): an owner decision with the reason, and a `planner.blocked` event with the class, which a watchdog
   check can take up;
3. anything else is a **task** problem (wording, scope, a dependency): a planner run that may propose `reword` or
   `unblock`.

Fill holds a run of its own that ended on a BLOCKED line its `blocked_pattern` matches (its `blocked` hold) and raises
its decision. For such a line, the planner raises no owner or environment decision of its own, so one line asks the
owner once; it records the route and still handles task problems. The planner maps more lines to a task than that
pattern does (by the reporting agent's only open line); fill takes those for runs without a done line and starts them
again, so for them the planner asks the owner itself, at once, and its route says why.

Never a loop: each task has `attempts_per_task` attempts. A planner run for it spends one, and so does an applied
`unblock`, so fill's own cycle (runs without a done line, a `no_done` hold, an unblock that releases it, runs again)
can't go on by itself: once the attempts are spent, the next `BLOCKED` raises one decision ("let the planner try again"
or "leave it to me"). A task the owner kept is left alone until its line changes: its `BLOCKED` lines ask nothing,
and the planner's `reword` and `unblock` of it are refused; the owner rewording the line is what clears it, and only
that: the attempts count from zero again only when the owner answers "let the planner try again". A decision's
dedupe key is per task, so a task that reports `BLOCKED` every few minutes asks once.

## Surfaces

- **Planner view** (owner only, since it shows plan text): sources and their parse status, open tasks, the planner
  agent and its next possible run, pending proposals with approve and reject, recent runs, and history with each
  change's diff. A "Check now" button runs a cycle.
- **Routes** under `/api/planner` (in `OWNER_ONLY_PREFIXES`, no CORS): every read and every write needs an owner
  session (the status too: its errors and warnings name paths on the machine); writes also need `confirm: true`.
- **Events**: `planner.changed`, `planner.run_started`, `planner.run_finished`, `planner.proposals_pending`,
  `planner.blocked`, `planner.tasks_file_restored`.
- **Decisions** as module `planner`.

## Restarts and reloads

Everything that matters is in `data/planner.db` (schema version 1): the known tasks-file content, the queue cursor,
seen messages, file hashes, pending triggers, runs, proposals, attempts and history. A planner run in progress is
picked up again from the agents store after a restart; pending approvals stay pending; decision answers given while
Lair was down are delivered when it starts. `PlannerManager.reloadProject()` has the shape of the other modules'
(stop the project's service, start it from the new config, leave the others alone).

## Verification

After a planner run passes Lair's checks (the schema, task-id rules, allowlist, bounds), a **verifier run** reviews
each accepted proposal against the project's actual state before the owner is asked. The verifier is a second agent
that reads the same context the planner saw plus the proposals and returns per-proposal verdicts. It catches what
rules can't: a proposal that sounds reasonable but conflicts with what's actually in the codebase.

### Verifier agent

The verifier is configured in `planner.verifier` with the same shape as `planner.agent`: an agent id (must be a known
agent, must not be in `agents.fill.agents`, must not be the planner agent), a prompt template, bounds on runs per day,
interval and debounce (the last two unused for now; one verifier run per planner run). When not configured, proposals
proceed directly to approval as before.

Its prompt is the template file, then a section Lair writes: the verdicts file path, the schema, the rules, and the
context bundle extended with the planner run's accepted proposals (those not yet refused by checks). JSON in a fenced
block, introduced as data. The bundle is written to `context.json` in a subdirectory of the planner run's directory
(`verify/`), which also holds the verdicts file. The same bounds apply: 256 KB max, must be a regular file inside
that directory, valid JSON.

### Verdicts

The verifier writes a JSON file:

```json
{"verdicts": [{"proposal": 0, "verdict": "pass", "reason": "the plan shows feat-search ready"}]}
```

Each item names a proposal by its index (0-based, in the order the planner proposed them) and one of three verdicts:

- **pass**: the proposal makes sense in context. If its op has `approval: never`, it applies without asking the
  owner; otherwise it waits as usual.
- **fail**: the proposal conflicts with reality (the task is actually done, the dependency isn't ready, the scope is
  wrong). The proposal is refused with the verifier's reason.
- **defer**: the verifier can't tell; the owner decides even when `approval: never` (turned into `always` for this
  proposal).

An accepted proposal without a verdict is treated as `defer` (the verifier said nothing about it). A verdict for a
proposal the checks already refused is ignored. The verifier's text (reason) only ever becomes part of the stored
refusal or a note in the decision; it never reaches any prompt.

### Applying with verification

After the verifier run ends:

1. Each verdict is recorded on its proposal (`verifier_verdict`, `verifier_reason`).
2. For each accepted proposal (not refused by checks):
   - `fail`: the proposal is refused, with the verifier's reason as the refusal.
   - `pass` and `approval: never`: the proposal is applied without asking.
   - `pass` and `approval: always`, or `defer`: the proposal waits for the owner.
3. If proposals wait, the decision shows them with their verdicts ("the verifier passed 2, deferred 1, failed 1").

The decision context lists each proposal with its verdict and reason, so the owner knows what the verifier thought.

### What the verifier can't do

The same restrictions as the planner agent: it can't edit the tasks file (Lair keeps the content), it can't reach a
worker's prompt (its reason text stays in the store and the decision), and it can't pass off an arbitrary file as
verdicts (path-checked, bounded, schema-checked). A malformed verdicts file fails the verifier run; the proposals
proceed as if the verifier said `defer` for all of them (the owner sees a note), and after `max_failed_runs` verifier
failures the owner is asked once ("disable verifier" or "retry").

### Skipping verification

Verification runs only when `planner.verifier` is configured. A project that doesn't need it leaves the block out.
The verifier can also be disabled per-op: `planner.verifier.skip_ops` lists ops that bypass the verifier and proceed
straight to approval rules (default: `["finish"]` — a finish has no plan context to verify).

## Not built

Task cards with acceptance criteria and size budgets, a dependency graph across documents, stacked-branch rebases,
number-range allocation and docs PRs that tick the plan (autonomy.md §4) come next. Owner messages are read, not
answered: the planner writes no replies.
