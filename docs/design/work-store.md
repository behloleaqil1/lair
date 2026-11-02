# Work store: tasks, events, briefs and messages in Lair's database

> Status: design. This document covers what the work store is and how it will be built. A reviewer reads it line by
> line, and the owner approves it, before code begins. Roadmap: [ROADMAP.md](ROADMAP.md) A (follows the bus). Relates to:
> [phase3-bus.md](phase3-bus.md) (agents report through the bus), [planner.md](planner.md) (proposals become tasks),
> [autonomy.md §4](autonomy.md) (the planner module), [autonomy.md §6](autonomy.md) (agents),
> [configuration.md](../configuration.md#fill) (fill's tasks file). Checked against main at e8147ef (2 Nov, "Main today");
> work store 1 builds 3.3, 3.4, 6.4 and the read routes of 4.2; work store 2 builds the bus consumer (4.1), the follower
> and the comparison with fill (6.4), and schema v2 (3.3).

## The problem

Today work lives in project files:

| File | What it holds | Problems |
|---|---|---|
| tasks file | One line per agent: `<agent>\|<name>\|<task>\|<description>` | Several writers (Lair's planner, legacy scripts, the owner) edit it; malformed lines break fill; no versioning |
| queue file | Free-text lines: `DONE`, `WAITING`, `BLOCKED`, `PROGRESS` | Loose pattern matching closed 6 unrelated tasks in one day; no structured schema |
| brief files | Markdown documents per task | Prompts reference stale versions; no history |
| per-agent prompt files | The prompt template for an agent's runs | Agents follow outdated prompts when files change mid-run |

This is also not a product: "write your tasks in this exact line format" is one project's habit, not something Lair
can offer to others.

Lair already keeps its own state in stores (`src/server/*/store.ts`: agents, decisions, review, triage, planner,
placement, supervisor, bus). The work itself should live there too.

## Main today (checked against main at e8147ef)

What this design builds on, as it is on main now:

| Module | What it does now | What the work store takes from it |
|---|---|---|
| bus (`src/server/bus/`) | One store per project (`data/bus/<project>.db`); a token per run (`tokens.ts`), minted and revoked by the agents module (`wiring.ts`); `BusService.report` binds a report to the run's claimed task and stores it, the mirror appends the queue line with its `[bus:<id>]` marker, then `bus.report` is emitted; the consumers (`bus.consume: off \| observe \| on`) let fill and the planner read the report in place of the line; `BusLive` puts reports, messages and claim events on the dashboard's `bus` WebSocket channel | How agents report (4.1): the work store becomes one more consumer of `bus.report` and of the claim events, and reads each report from the bus store by id |
| fill (`agents/fill.ts`) | Reads the tasks file (`readBounded`, 256 KB) and the last 4 MB of the queue file (`QueueLines.read`) asynchronously on every check (#287); `checkDone`, `reportedOutcome` and `unassignedLine` decide done, waiting and blocked | The importer reuses these unchanged (6.4). Fill keeps reading the files until `work_store.mode: on` (work store 3) |
| planner (`planner/`) | Writes the tasks file (`tasks-file.ts`, done lines behind the done marker, `#done ` by default) and marks tasks done from `checkDone` | The importer reads done lines with the planner's own parser (`parseTasksDoc`). The planner writes the store from work store 4 |
| tracker (`tracker/`) | Its own store (`data/tracker.db`) holds the task-to-issue links; it reads tasks through a `TaskSource` (`tracker/tasks.ts`) | Links stay in the tracker's store (no copy here); a store-backed `TaskSource` replaces the file one later (12.6) |
| decisions, review, PR health, revert checks, CI guards | Unchanged by the store | The CI guards cover the new module: it is wired from `index.ts`, its routes are owner-only (route-ownership test), it uses no synchronous fs |

The problem the store fixes first is cost: fill, the planner and the tracker each re-read the growing tasks and queue
files on their own timers, and the gate result folders on top. On 2 Nov that made checks slow and, together with the
synchronous reads #287 removed, froze the server for up to 28 s. With the store a check reads indexed rows, and the
files are read only when they change (the follower, work store 2).

## Goals

1. **Single source of truth**: one database for tasks, events, briefs and messages.
2. **Type-safe schema**: every field validated, every state transition checked.
3. **Full history**: an append-only timeline of events per task, audit trail for every change.
4. **Configurable workflow**: states, transitions and WIP limits per project.
5. **Safe migration**: observe mode with file mirroring before full switch.
6. **External tracker sync**: the store is truth; GitHub Issues sync from it.

## 1. Model

### 1.1 Tasks

A task is a unit of work an agent can claim and complete.

```typescript
interface WorkTask {            // schema v1 (work store 1)
  id: string;                   // Valid per isValidTaskId (agents module), see the id rule below
  project: string;              // Project this task belongs to
  title: string;                // Max 200 chars; from the tasks file: the description's first 200 characters, else the id
  description: string;          // The tasks file's description as written (max 2000 chars, fill's line limit)
  state: StoredTaskState;       // See 2.1; `assigned` and `running` are derived at read time, see 1.5
  agent: string | null;         // Intended assignee (today's agent column), null for an unassigned line. NEVER the holder
  agentName: string | null;     // The tasks file's name column, kept so a mirror can write the line back unchanged
  priority: number;             // 1-999, lower first; from the tasks file: the line's position among the tasks
  source: TaskSource;           // Where this task came from
  blockedReason: string | null; // Why blocked, if state is blocked
  createdAt: number;
  updatedAt: number;
  version: number;              // Bumped on every stored change; optimistic locking for the writers of work store 4+
}

type StoredTaskState = 'open' | 'ready' | 'waiting' | 'blocked' | 'in_review' | 'done' | 'dropped';
type TaskState = StoredTaskState | 'assigned' | 'running';   // the last two derived from the claim (1.5)

type RiskTier = 'red' | 'amber' | 'green';

interface TaskSource {
  kind: 'import' | 'plan' | 'backlog' | 'intake' | 'planner' | 'owner';
  ref: string;    // Document path, section id, or for an import "tasks_file:<line>"
}
```

Columns that arrive with the PR that first writes them, each as a schema migration: `tier` and `labels` (the board,
work store 6), `brief_id` (briefs, work store 7), dependencies (`work_task_deps`, the planner, work store 4). There is
**no `externalRef` column**: the tracker's `tracker_links` is the one source of truth for task-to-issue links, as
`agents_claims` is for holders (1.5). An `ExternalRef` below means the tracker's link.

**One id rule.** There is one task-id rule in Lair: `isValidTaskId` from the agents module, which wraps
`TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._/#:-]{0,127}$/` (`agents/types.ts`). Fill, the planner's proposals and the
queue matching already enforce it, so ids such as `Feat-1.2` or `area/topic#3` exist in real task files. The store,
the routes and the importer call that function; none defines its own pattern. (Ids contain `/` and `#`: the
routes take the id as a query parameter, and the store treats it as an opaque string.)

### 1.2 Task events

An append-only timeline of everything that happened to a task.

```typescript
interface TaskEvent {
  id: number;                   // INTEGER, increasing: a reader keeps a cursor
  project: string;
  taskId: string;
  kind: TaskEventKind;
  actor: EventActor;            // Who did it
  payload: Record<string, unknown>;  // Event-specific data, bounded
  at: number;
}

type TaskEventKind =
  | 'created'        // Task created
  | 'assigned'       // Agent assigned
  | 'started'        // Agent run started
  | 'report'         // WAITING, DONE, BLOCKED, PROGRESS, TICK
  | 'pr_opened'      // PR opened for this task
  | 'reviewed'       // Review completed
  | 'merged'         // PR merged
  | 'state_changed'  // Any state transition
  | 'edited'         // Title, priority, labels changed
  | 'brief_updated'  // New brief version
  | 'reopened'       // Reopened after done/dropped
  | 'dropped';       // Dropped by owner or planner

interface EventActor {
  kind: 'agent' | 'owner' | 'module' | 'system';
  id: string;       // Agent id, 'owner', module name, or 'lair'
  runId?: string;   // For agents: which run
}
```

### 1.3 Briefs

Versioned documents that describe a task's requirements.

```typescript
interface Brief {
  id: string;               // UUID
  project: string;
  taskId: string;           // The task this brief is for
  version: number;          // 1, 2, 3, ...
  content: string;          // Markdown, max 200 KB
  createdBy: EventActor;
  createdAt: number;
}
```

The latest version is the active one. Older versions are kept for history. Agents see only the version that was
current when their run started.

### 1.4 Messages

**Options.**

| Option | For | Against |
|---|---|---|
| A. Leave messages in the bus store (recommended) | Already built, with unread tracking and the per-run token model; no migration; the bus keeps working in `files` mode | The task page joins two stores by task id |
| B. Copy messages into the work store | One query for the task page | Two copies to keep equal; bus 2a's consumers read the bus store |
| C. Move messages into the work store | One store | Breaks every bus consumer and the mirror; the bus must then depend on the work store |

Recommendation: A. The work store holds task data; the bus holds communication. The task page reads the task's
messages from the bus store by task id (read-only join in the route, not in SQL).

### 1.5 Relations to existing stores, and who holds a task

**`agents_claims` is the ONE source of truth for who holds a task** (`bus/service.ts`: "Claims have ONE source of
truth: the agents module's claims"). The work store never copies holder state:

- `task.agent` is the *intended* assignee: the same meaning as the agent column in today's tasks file. It says who
  should take the task, not who has it.
- The store keeps no run id and no holder column. `assigned` and `running` are *derived at read time* by joining
  the agents module's claims (`getClaimedTask`, `getAllClaims`), as the bus board does. A task whose stored state is
  `ready` and that has an active claim is shown as `running`; the stored value moves only for facts the work store
  owns (see 2.1).
- A report is bound by `getClaimedTask(binding.runId) === taskId`, exactly as `BusService.report` does today. The
  work route reuses that check; it has no check of its own.
- A claim that is released (`POST /api/agents/claims/release`, which fill already reads as `claim_released`), lost,
  or replaced after its owner died (failover, restart adoption) produces a task event written by the agents module
  through the producer interface, and the task goes back to `ready` (or `blocked` when the reason is a block) with
  that reason in the event. A claim replaced by failover changes the derived holder with no write to the task row.
- Work store 2 (observe): the consumer records each run and claim fact (`started`, `ended`, `claim_released`) on the
  task's timeline. Only a *live* run's start moves the stored state (a `waiting` or `blocked` task back to `ready`,
  shown `running`); a run's end or a released claim moves nothing, because the agents module releases a claim at
  every run's end, also right after a `WAITING` or `BLOCKED` report, and fill keeps that state then. A start replayed
  after its run ended moves nothing either: the files decide that task's state (6.4).

| Store | What it holds | How work store relates |
|---|---|---|
| agents | Runs, claims, events, usage | Source of truth for holders. Tasks reference nothing of it; the join is by `taskId` at read time |
| planner | Runs, proposals, changes | Proposals create/modify tasks via the producer interface (4.3) |
| decisions | Owner decisions, blocks | Fill blocks on `agents:<project>:task:<task>` (`fill.ts`). The work store defines no second key: it looks up that one |
| bus | Messages, reports, tokens | Reports reference tasks; the store consumes the bus's report events; messages stay there (1.4) |
| review | Reviews, tiers, policy | Reviews reference tasks by their PR; the store keeps `tier` on tasks |
| triage | Gate results, classification | Triage events can update task state |

## 2. States and workflow

### 2.1 Default state machine

```
                    ┌────────────────────────────────────────────────────────────┐
                    │                                                            │
  ┌──────┐     ┌────▼──┐     ┌────────┐     ┌───────┐     ┌───────┐     ┌──────┐ │
  │ open ├────▶│ ready ├────▶│assigned├────▶│running├────▶│waiting├────▶│ done │ │
  └──┬───┘     └───┬───┘     └────────┘     └───┬───┘     └───┬───┘     └──────┘ │
     │             │                            │             │                   │
     │             │                            ▼             │                   │
     │             │                       ┌────────┐         │                   │
     │             │                       │blocked ├─────────┼───────────────────┘
     │             │                       └────────┘         │
     │             │                                          │
     │             ▼                                          ▼
     │        ┌─────────┐                              ┌─────────┐
     └───────▶│ dropped │◀─────────────────────────────│in_review│
              └─────────┘                              └─────────┘
```

Transitions:

| From | To | Who | When |
|---|---|---|---|
| open | ready | system | All dependencies are done |
| ready | assigned | fill | Fill claimed the task for a run (derived from the claim, 1.5) |
| assigned | running | agents | Run started (derived from the claim) |
| running | waiting | agent | Reports `WAITING` with gate |
| waiting | running | system | Gate result received |
| running | blocked | agent | Reports `BLOCKED` |
| blocked | ready | owner/planner | Unblocked; fill picks it up again |
| running | in_review | agent | Reports `DONE` with PR |
| in_review | done | review/merge | PR merged |
| assigned/running/waiting | ready | agents (claim released, lost or replaced) | The claim is gone, reason in the event (from work store 3; in work store 2 a released claim is recorded and moves nothing, 1.5) |
| waiting/blocked | ready | agents (work store 2) | A live run started on the task: shown `running` (1.5) |
| * | dropped | owner | Owner drops the task |
| dropped/done | open | owner | Owner reopens |

`assigned` and `running` are the two states the work store does not own: they follow the claim. The stored state
stays `ready` until the claim exists, and the read model shows the derived state. Every other state is stored.

**Required fields per state** (checked on the transition; a missing field refuses it with a named error):

| State | Required |
|---|---|
| `open` | `title`, `source` |
| `ready` | `open` requirements and every dependency `done` (a brief is optional until briefs, work store 7) |
| `waiting` | `gateId` (the gate the run waits on) |
| `blocked` | `blockedReason` (non-empty, 1-500 chars) |
| `in_review` | `pr` (number) and `sha` |
| `done` | `pr` and `sha` when the task came from a PR flow; for tasks closed by the owner, an `owner` actor and a reason |
| `dropped` | a reason (1-500 chars) and an `owner` or `planner` actor |

The required values live on the transition's event payload and are copied to the task row only where the model has
a column (`blocked_reason`). So a task blocked again for another reason is an `edited` event with the reason before and
after (and a new version); a task still waiting on a new line has no column to change: the new line or report is on
its event (`report`, with the gate id), and the state stays. A blocked reason is a `BLOCKED` report's summary, or the
`BLOCKED` line when it was written by hand (the mirrored line of a report reads as the report's summary, so the
consumer and the follower store the same reason).

### 2.2 Configurable per project

```yaml
work_store:
  # State configuration
  states:
    open:
      initial: true
      transitions: [ready, dropped]
    ready:
      transitions: [assigned, dropped]
      required: [briefId]
    assigned:  # derived from the claim, never written by callers
      transitions: [running, ready, dropped]
      wip_limit: 1  # Per agent
    running:   # derived from the claim
      transitions: [waiting, blocked, in_review, ready]
    waiting:
      transitions: [running, blocked, ready]
      required: [gateId]
      timeout_minutes: 60
    blocked:
      transitions: [ready, dropped]
      required: [blockedReason]
    in_review:
      transitions: [done, running, dropped]  # running = fix requested
      required: [pr, sha]
    done:
      terminal: true
      transitions: [open]  # reopen
    dropped:
      terminal: true
      transitions: [open]  # reopen

  # Who may make each transition
  transitions:
    ready_to_assigned: [fill, owner]
    assigned_to_running: [agents]
    running_to_blocked: [agents]
    blocked_to_ready: [owner, planner]
    '*_to_dropped': [owner]
```

Callers named in `transitions` are modules, each with one producer interface (4.3): `fill` and `agents` write
claim-related facts through the agents module's interface, `planner` through `WorkStoreProducer`, `review/merge`
through a `ReviewProducer` (`markInReview`, `markMerged`). The role names are checked against the route-derived
actor (7.2), never against a field the caller sends.

## 3. Storage

### 3.1 Architecture

**Options.**

| Option | For | Against |
|---|---|---|
| A. One database per project, `data/work/<project>.db` (recommended) | Same as the bus store (`getBusStore`); a project's data is one file to back up, export or delete; no cross-project lock contention; project isolation is structural | Cross-project views (a global board) read several files |
| B. One shared database with a `project` column | One connection; global queries are simple | One writer lock for all projects; a bug in a `WHERE project` clause leaks across projects; backup and delete are per-row |

Recommendation: A. The `project` column stays in every table anyway (it keeps rows self-describing in exports).

```
src/server/work/
├── config.ts         # The work_store: block (mode)
├── store.ts          # WorkStore interface, SqliteWorkStore, schema and migrations, the task and event model
├── importer.ts       # Reads the configured files with fill's and the planner's parsers and checks
├── manager.ts        # WorkStoreManager: per-project mode, stores, imports, live reload
├── routes.ts         # Owner-only REST API
├── index.ts
└── work.test.ts      # Through the routes and the manager
```

### 3.2 SQLite now, Postgres later

**Options.**

| Option | For | Against |
|---|---|---|
| A. SQLite only, behind a repository interface (recommended) | Same as every Lair store; the interface is at the level of domain operations, so a Postgres implementation can follow (M6, platform.md) without touching callers | One more layer than the other stores |
| B. A generic SQL backend (`query`, `exec`, `transaction`) | Looks small | A SQL-level interface cannot be synchronous for Postgres (no Node client is), and SQLite's `better-sqlite3` is. A synchronous interface rules Postgres out; an async one makes every caller async for no gain today |
| C. SQLite calls directly in the store, no interface | Least code | Postgres later means a rewrite of every caller |

Recommendation: A. The boundary is an **async `WorkStore` repository interface** (`createTask`, `transition`,
`appendEvent`, `listByState`, `readyByPriority`, `timeline`, `dependents`, ...). The first
implementation is `SqliteWorkStore` (its methods return resolved promises; transactions are internal to one
method). A `PostgresWorkStore` is a second implementation of the same interface. Cost: every caller `await`s, which
the HTTP routes and the planner already do. A transition that spans repository calls (4.4, 7.4) is expressed as one
repository method, never as a caller holding a transaction.

### 3.3 Schema

```sql
-- Schema version 1 (work store 1)
CREATE TABLE work_schema (version INTEGER NOT NULL);
CREATE TABLE work_tasks (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  agent TEXT,
  agent_name TEXT,
  priority INTEGER NOT NULL DEFAULT 500,
  source_kind TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  blocked_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (project, id)
);
CREATE INDEX work_tasks_state ON work_tasks(project, state, priority);
CREATE INDEX work_tasks_agent ON work_tasks(project, agent) WHERE agent IS NOT NULL;

CREATE TABLE work_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,   -- increasing: a reader keeps a cursor
  project TEXT NOT NULL,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_run_id TEXT,
  payload TEXT NOT NULL,  -- JSON, bounded
  at INTEGER NOT NULL
);
CREATE INDEX work_events_task ON work_events(project, task_id, id);

-- One row per applied import: who, when, what it changed
CREATE TABLE work_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  tasks_file_hash TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  dropped INTEGER NOT NULL,
  warnings INTEGER NOT NULL
);
```

Later migrations, each with its PR: v2 `work_cursors` (work store 2, below), then `work_task_deps` (with its reverse
index on `depends_on`), `tier` and `labels`, and `work_briefs` (unique on `project, task_id, version`), as in the first
draft of this section.

```sql
-- Schema version 2 (work store 2): the consumer's position in each source of facts
CREATE TABLE work_cursors (
  project TEXT NOT NULL,
  source TEXT NOT NULL,       -- 'bus.report' (a bus report id) or 'agents.event' (an agents_events row)
  position INTEGER NOT NULL,  -- the last fact applied from that source
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project, source)
);
```

One cursor per source, because the facts come from two stores with their own ids: reports from the project's bus
store, run and claim facts from the agents store's events (by row: that table's id is a text id, and its rows only
grow). The owner's first applied import starts both cursors where the sources ended before the files were read (a
fact before that is in the files the import read; one after it is the consumer's). A store adopted under work store 1
has no cursor: each source starts at its end when the consumer first reads it. A source whose end is behind its cursor
(its file was replaced) starts again at its end.

### 3.4 Schema versioning and migrations

The work store has its own file, so its version lives in its own table (`work_schema`), as the tracker's does, never
in `PRAGMA user_version`: a file whose `user_version` is set belongs to another store and is refused, and so is a
file written by a newer Lair (a schema version above the one this build knows). Migrations are an ordered list, one
per version, each applied in one transaction with the version update, so an older file is brought up step by step;
each later PR adds its migration and a test that opens a file written at the previous version. The directory is
created with `fs/promises` before the database is opened (no synchronous fs on a request path); the `better-sqlite3`
calls themselves are synchronous, as in every Lair store, and each is a few indexed statements in one transaction.

### 3.5 Backups and export

- **Backup**: new; no Lair store calls `.backup()` on main today, and the cleanup module covers worktrees and
  watched folders only (ROADMAP B1 lists store backups as not built). This design defines it for the work store
  and B1 may later generalise it:
  - *when*: before an import apply, before an archive run, and daily (`work_store.backup.daily: true`);
  - *where*: `data/backups/work/<project>-<timestamp>.db`, written with SQLite's online `.backup()`;
  - *retention*: the last 7 daily copies plus every pre-import and pre-archive copy younger than 30 days; removals
    are audited like the cleanup module's;
  - *restore*: owner-only (`POST /api/work/restore`, `requireOwnerForChanges`), takes a backup name from the list,
    stops writes for the project, swaps the file and starts the start-up reconcile (7.4).
- **Export**: JSON and Markdown export via routes. JSON is the full store; Markdown is a human-readable task list.

### 3.6 Retention

**Options.**

| Option | For | Against |
|---|---|---|
| A. By task: archive the events of tasks terminal (`done`, `dropped`) for more than `retention_days` (recommended) | An open task keeps its whole history; "full history" holds for every live task | Long-open tasks keep growing |
| B. By event age, keep the latest per task | Simple | An open task older than the window loses `created` and `assigned`; the task page and 7.3 break |
| C. No archive | Nothing lost | 200,000 events per project becomes unbounded |

Recommendation: A. Events of a task that has been `done` or `dropped` for more than `retention_days` (default 90;
a reopened task is not terminal) move to `data/work/archive/<project>-<year>.db`, leaving its `created` and its
terminal event in the main store. Never an open task's events. The task page reads the archive on demand through
`timeline(project, taskId, { includeArchive: true })`, which reads the main store, then the archive file for the
task's terminal year. Bounded per cycle, every removal audited, a backup first (3.5).

### 3.7 Query paths

| Query | Used by | Index |
|---|---|---|
| Board: tasks by state | UI board | `idx_work_tasks_state` |
| Ready list by priority | fill | `idx_work_tasks_priority` |
| A task's timeline | task page | `idx_work_events_task` |
| Latest event per task | board cards | `idx_work_events_task` (last row per task, `LIMIT 1`) |
| Dependents of a finished task | `open` to `ready` on completion | `idx_work_task_deps_reverse` (`depends_on`), no JSON scan |
| Task by external ref | tracker sync | In the tracker's own store (`tracker_links_issue`), not here (1.1) |
| Tasks of an agent | owner page | `idx_work_tasks_agent` |

`dependencies` JSON on the task row is a display copy written in the same transaction as `work_task_deps`; the
table is what queries read. The "< 10 ms" target in section 8 holds for these seven.

## 4. Access

### 4.1 Agent access: bus tools and HTTP

**How agents report (no change for agents).** Agents keep reporting with the bus tools and their run's token (`lair
bus report`, the MCP tool, `POST /api/bus/call`), or with a `DONE`/`WAITING`/`BLOCKED` line written by hand.
`BusService.report` binds the report to the task the run holds (`getClaimedTask`), stores it, the mirror appends the
queue line, and `bus.report` is emitted. The work store is one more consumer (work store 2): on `bus.report`, and at
start, it reads the bus store's reports above its cursor (`work_cursors`) and applies each, with the cursor update,
in one transaction. A report therefore applies once across restarts, and a missed event is caught up by the next
one. Claim facts arrive the same way from `agent.run.started`, `agent.run.ended` and `agent.claim.released`. A
hand-written line (an agent without a token) reaches the store through the follower (6.4), read with fill's own
checks. The tools below are for later PRs (work store 7); `report` is unchanged.

What a report does to its task (work store 2): every report is a `report` event on the task, with the agent and run
from the bus store as the actor; `WAITING` makes it `waiting`, `BLOCKED` makes it `blocked` (its summary is the
reason), a `DONE` that fill's ready guard accepts makes it `done` (a refused one is recorded as refused and moves
nothing: the follower reads its line again when the files next change); `PROGRESS` and `TICK` move nothing, nor does
any report on a `done` or `dropped` task. A report for a task the store does not have is skipped (counted in the
status) and the cursor moves past it: the follower imports the task from the files. The two sources are applied in
time order (a full batch of one source holds the other back to its last time), so a replay after a restart applies a
run's start, its reports and its end in the order they happened.

Agents access tasks through the bus tools, extended:

```typescript
// New bus tool: get my task and brief
task(): {
  task: Task;
  brief: string;        // The brief content at run start
  unreadMessages: number; // Count only: task() does NOT mark messages read
}                         // (inbox() stays the call that reads them and marks them read)

// Unchanged signature: report stays as agents and bus 2a's consumers call it today
report(kind: ReportKind, task: string, summary: string, opts?: {
  gateId?: string;
  pr?: number;
  sha?: string;
}): void;  // `task` is optional-and-verified: if given and not the run's task, the same refusal and message

// New bus tool: read checks for the task
check(what: 'gate' | 'review' | 'merge'): CheckResult;
```

`report` keeps the `task` argument so no agent or consumer changes. The server refuses a mismatch exactly as
`BusService.report` does now, with the same message.

HTTP for curl access (no node needed): the bus's existing token route, `POST /api/bus/call`, gains the `task` and
`check` tools (work store 7); `report` is already one of its tools. No `/api/work/agent/*` route is added, so the
whole `/api/work` prefix stays owner-only.

These calls require the run's bus token, issued by the agents module at run start. **Agent, run and task are derived
from the token binding only.** There is no `run_id` parameter, and a `run_id` or `actor` in a query or body is
ignored (and logged once as a notice-worthy mismatch if it differs from the binding). Every event the route writes
records that derived actor, which is the audit trail.

### 4.2 Owner access

Owner routes require an owner session (`src/server/human-auth/`). Owner-only is a **route property**, not a store
check: `/api/work` is added to `OWNER_ONLY_PREFIXES`, reads that expose paths or other projects' data use
`requireOwner()`, and writes use `requireOwnerForChanges()`. Both run before the body is parsed. The route layer
builds the actor from the authenticated session (`{ kind: 'owner', id: session.id }`: the session's public id, never
its secret) and passes it to the store as a trusted argument; the store has no way to read an actor from a request
body. Agents never call
`/api/work`: they use the bus's token routes (4.1). In work store 1 every `/api/work` route, reads included, needs the
owner (`requireOwner()` on the whole prefix): task text and file paths are the owner's.

```
GET    /api/work/status?project=<p>                  # WS1: mode, schema version, counts by state, last import;
                                                     # WS2: adopted, cursors, the follower, the comparison with fill
GET    /api/work/tasks?project=<p>&state=<s>&agent=<a>&limit=<n>   # WS1: with the derived state and holder (1.5)
GET    /api/work/task?project=<p>&id=<id>            # WS1: one task and its newest events
POST   /api/work/import?project=<p>                  # WS1: import from the configured files (6.4); body { dry_run }, default true
POST   /api/work/tasks                               # Create task (WS4)
PATCH  /api/work/task?id=<id>                        # Edit task (WS4)
POST   /api/work/task/drop?id=<id>                   # Drop task (WS4)
POST   /api/work/task/reopen?id=<id>                 # (WS4)
GET    /api/work/task/brief?id=<id>                  # (WS7)
POST   /api/work/task/brief?id=<id>                  # New brief version (WS7)
GET    /api/work/export?project=<p>&format=json|md   # (WS9)
```

### 4.3 Planner access

The planner module uses an in-process interface, not HTTP:

```typescript
interface WorkStoreProducer {
  createTask(input: TaskInput): Task;
  updateTask(project: string, id: string, changes: TaskChanges): Task;
  dropTask(project: string, id: string, reason: string): void;
  unblockTask(project: string, id: string): void;
}
```

Proposals (`add`, `finish`, `reassign`, `reword`, `drop`, `unblock`) become calls to this interface, checked by
planner's own validation first. The planner agent itself has no write path except this producer interface.

**What replaces the file-based planner parts in `db` mode** (planner.md, `planner/tasks-file.ts`):

| Today (files) | In `db` mode |
|---|---|
| Done-marking from queue lines | A `done` fact comes from `report` events through bus 2a, not from reading queue text |
| `drop_plan_done` | The planner proposes `drop` for tasks whose plan source is complete; applied through `dropTask` |
| External edits recorded with a diff, known-content hash | Edits made by hand are owner edits through the API (events with the owner actor); the hash exists only in `mirror` mode (6.2) |
| `mark_done: lair_runs` | A task is `done` when a `merged` fact arrives from review/merge, or by owner edit |
| "The agent can't edit the tasks file" | The planner agent has no route to the store; only `WorkStoreProducer` is callable, from the planner module |

Each module has its own producer, named in the `transitions` config (2.2): `WorkStoreProducer` (planner),
`ReviewProducer` (review/merge: `markInReview`, `markMerged`), and the agents module's claim events (1.5). The
`fill` role never writes a state; it asks the agents module to claim.

### 4.4 Transitions that span stores

A transition with a side effect is one repository method with a fixed write order; 7.4 gives the order and the
recovery for each.

### 4.5 Module subscriptions

Other modules subscribe to task events:

```typescript
// In event-bus.ts
type TaskEventType =
  | 'work.task.created'
  | 'work.task.state_changed'
  | 'work.task.assigned'
  | 'work.report'
  | 'work.brief.updated';

// Fill subscribes to state_changed to know when tasks become ready
eventBus.on('work.task.state_changed', ({ task, from, to }) => {
  if (to === 'ready') fill.onTaskReady(task);
});
```

## 5. UI

### 5.1 Work board

A Kanban board with columns per state, live-updated through the live module (5.3):

```
┌─────────┬─────────┬─────────┬─────────┬─────────┬─────────┐
│  Ready  │ Running │ Waiting │ Blocked │In Review│  Done   │
├─────────┼─────────┼─────────┼─────────┼─────────┼─────────┤
│ [drag]  │ [drag]  │         │ [drag]  │         │         │
│ task-1  │ task-3  │ task-5  │ task-7  │ task-9  │ task-11 │
│ task-2  │ task-4  │ task-6  │ task-8  │ task-10 │ task-12 │
└─────────┴─────────┴─────────┴─────────┴─────────┴─────────┘
```

Drag-and-drop for owner transitions (ready → assigned, blocked → running). Each card shows: id, title, agent
(if assigned), priority badge, tier colour.

### 5.2 Task detail

A detail view with everything about a task:

- Header: id, title, state badge, priority, tier, labels
- Timeline: all events, with actor and timestamp
- Brief: current version, version history, edit button
- Related:
  - PR (if any): status, gate, review
  - Gates: the task's gate results
  - Checks: triage results
  - Reviews: review findings
- Messages: thread from bus

### 5.3 Live updates

There is no `live` module on main. `BusLive` (`bus/live.ts`) coalesces bus events (100 ms quiet, at most 1 s, 50 per
update) onto the dashboard's `bus` WebSocket channel (`wsServer.broadcast`), and carries only what any viewer may see.
The work store publishes on a `work` channel the same way, per project: ids, states, agents and titles, never a
description or a brief (those need the owner's session through the routes). No SSE route is added.

## 6. Files as adapters

**Options for how a project moves off the files.**

| Option | For | Against |
|---|---|---|
| A. Three modes per project: `files`, `mirror`, `db` (recommended) | Each step is a config change; `files` is today's behaviour, so adoption is opt-in | Three code paths to test (kept small: see below) |
| B. Big-bang switch with a one-off import | One code path | A project with a legacy writer breaks the day it switches |
| C. Permanent two-way sync | No retirement needed | Two truths, the conflict class this design exists to remove |

Recommendation: A, as two switches so each step changes one thing, with `mirror` one-way (store to files), never
two-way:

```yaml
work_store:
  mode: off | observe | on        # who reads the store; default off
  files: follow | mirror | none   # how the legacy files relate to it; default follow (work store 2 and 5)
```

| `mode` | Who reads the store | The files |
|---|---|---|
| `off` (default) | Nothing: no store file is created; the status route reports `off`, and every other read and the import answer 404 for the project | Fill, the planner and the tracker read them, exactly as today |
| `observe` | The owner (read API, import dry runs, and from work store 2 a comparison with fill's view). Fill, the planner and the tracker still read the files | `follow`: the store follows the files one way: on the owner's import (work store 1), automatically when they change (work store 2) |
| `on` | Fill (work store 3), then the planner (4) and the tracker (8) | `follow` while legacy writers still edit the files; `mirror` once the store is written directly (Lair writes the files for old scripts, 6.2); `none` when nothing reads them (the first draft's `db` mode) |

Work store 1 accepts `mode: off | observe` only; work store 2 adds `files: follow` (the default; `mirror` and `none`
are refused until the PRs that build them), and `on` arrives with work store 3.

### 6.1 `off` (default for every project)

`off` is **today's path, with no work store**: fill reads the tasks file, queue matching and bus 2a work as they
do now, and nothing is written to a database. A project adopts the store by switching to `observe`, running the
importer (6.4) with a dry run, then applying it. No new parser of the queue file is added in any mode.

### 6.2 `files: mirror` (transition)

The database is truth; Lair writes the legacy files for old scripts. Mirror mode is **detect, refuse, one notice**.

**One writer per file**, so Lair never races itself:

| File | Writer | How |
|---|---|---|
| tasks file | the work store's mirror adapter (replacing the planner's rewrite) | Atomic rewrite, only when the file's content hash equals the hash Lair last wrote (the planner's known-content pattern) |
| queue file | the bus mirror (`BusMirror.mirrorReport`), the existing append-only writer | Append only, lines carry the existing id marker; the work store adds no queue writer |
| brief files | the mirror adapter | Written once per brief version, never rewritten |

**Detection is by content hash against the last write, not mtime** (Lair's own appends and atomic rewrites move
mtime). On the next mirror write the adapter compares the file's current hash (for the queue file: the hash of the
file prefix Lair wrote, so appended foreign lines are found without being touched) with the recorded one.

**On a foreign edit:**

1. **Refuse**: the file is not overwritten. The foreign line in the queue file survives; the tasks file is left as
   the legacy writer left it, and mirroring of that file pauses.
2. Record one `external_edit` event with the diff (bounded), actor `system`.
3. Raise **one** notice with a dedupe key per file (`work:<project>:external_edit:<file>`). Ten more edits to the
   same file produce no further notice while the first is open.
4. Offer the owner two actions: **adopt** (import the diff as task changes through the owner path, then resume
   mirroring) or **discard** (rewrite the file from the database after a backup, then resume).

A `DONE` or `BLOCKED` line written by hand by an agent without the bus therefore stays in the file and is read by
bus 2a's consumers as before; it is not lost.

Mirror mode lets a project observe the new system before retiring file-based tools.

### 6.3 `files: none` (target)

Database only. No file reads or writes. This is the target for new projects and for projects that have
retired their legacy scripts.

### 6.4 Importer and follower

**One way, idempotent, re-runnable, observe first.** It reads only the project's **configured** files
(`agents.fill.tasks_file`, resolved against the repository as fill resolves it, and `queue_file`), never paths from
the request, asynchronously and with fill's bounds (`readBounded`, 256 KB; `QueueLines.read`, the last 4 MB).

```
POST /api/work/import?project=<p>     # owner session (the /api/work prefix is owner-only)
{ "dry_run": true }                   # the default: report, write nothing
```

It **reuses fill's and the planner's code**, so there is no third parser and no new pattern setting:

- the tasks file through the planner's `parseTasksDoc` (fill's `parseTasksFile` with its bounds and `isValidTaskId`,
  plus done lines behind the planner's `done_marker`); a line fill refuses is a warning, and the task ids on it are
  kept, never dropped because their line is malformed (as the tracker does);
- each open line's state through fill's own checks with the project's patterns: `checkDone` (with `queueWindowEnd`
  and fill's kept `fill_done` record), then `reportedOutcome` for the task's latest run (`WAITING`, `BLOCKED`), and
  `unassignedLine` for a line with no agent; with `bus.consume: on` a mirrored line is read by its bus report, as
  fill reads it; a `DONE` that fill's ready guard refuses (`reportAccepted`) does not make the task done;
- a task with an active run or a claim says nothing new in the files while the run works (its reports reach the store
  through the bus consumer, 4.1): the import keeps its stored state, a new task is stored `ready`, and the read model
  shows it `assigned` or `running` (1.5). Whether a run holds it is read before the queue file, so a run that ends
  meanwhile has its last lines in the read;
- **fill's holds are not a stored state.** Fill holds a line for the owner (a decision on
  `agents:<project>:task:<task>`, a refusal, a pause, a backoff, capacity) before its done check; the import does not
  copy those: a held line is stored by what its lines say (usually `ready`). Only the holds that are a state the store
  keeps, `waiting` (and `waited_too_long`) and `blocked`, are compared with it (the comparison below ignores the rest).

| In the files | Stored state |
|---|---|
| An open line, no report | `ready` |
| An open line, a `DONE` fill accepts (or fill's kept record) | `done` |
| An open line whose latest run last wrote `WAITING` / `BLOCKED` (an unassigned line's too) | `waiting` / `blocked` (the line is the reason, or the report's summary for a mirrored line) |
| An open line a run or a claim holds | unchanged (a new task: `ready`) |
| A done line (`#done ...`) | `done` |
| Gone from a readable file, imported before | `dropped` ("no longer in the tasks file") |

**`files: follow` follows only what an import made.** A task whose `source` is not `import` (the planner's or the
owner's, from work store 4) is never edited, moved or dropped by the files, even when a line names it: the import
lists it as skipped. Only an import-sourced task can be dropped for leaving the file. So the planner's and the owner's
writes (work store 4) and the follower never fight over one row.

The import diffs the files against the store and changes only what differs, in **one transaction** (no `await`
between the diff and the writes): a new task is `created`; a changed agent, name or description is `edited` (before
and after); a new state is `state_changed`, and a done or dropped task back in the file is `reopened`. A position
change only updates `priority`. Running it twice changes nothing the second time. It never drops anything when the
tasks file cannot be read, and two imports of one project never run at once (the second is refused). Each applied
import adds one `work_imports` row; it and every event carry the owner's session as actor. In `observe` the store
can always be rebuilt from the files, so the pre-import backup of 3.5 arrives before `on` (work store 9).

**The follower (work store 2)** runs the same import when a configured file changed (its size, mtime and inode; the
import itself compares content, so a file touched with nothing new changes nothing), never on a timer alone, so a
check that finds nothing changed costs two `stat`s instead of 256 KB and 4 MB of reads. It is the only file reader in `observe` and in `on` with `files: follow`.

As built in work store 2:

- **Adoption.** Nothing follows until the owner applies a first import (after a dry run): that apply adopts the store
  and starts the consumer's cursors (3.3). A dry run adopts nothing. Until then the status says the follower waits.
- **One step per project at a time,** every 15 s and at start: the consumer drains first (bus reports and run and claim
  facts above the cursors, 4.1), then the two files are `stat`ed (size, mtime, inode, taken before the read so a change
  during it is read next time); only a change runs the import, with the follower (`module`) as the actor. A bus report
  or a run or claim event drains at once. A request during a step runs once after it.
- **Failures.** A step that fails, or takes longer than 60 s, is a failure in the status, with a backoff that doubles
  from the interval up to 10 minutes; the step in flight still ends before another starts (its writes are each one
  transaction). An unreadable tasks file fails the step and drops nothing.
- **Live reload.** A change to the blocks an import reads (`agents`, `planner`) replaces the config the next step
  reads; a step or import in flight ends with the config it started with and is not restarted. `mode: off` closes
  the store and forgets the follower.
- **The comparison.** `GET /api/work/status` puts the store next to fill's view at fill's last complete check: a
  fill `done` line against a `done` task, `started` or `claimed` against a task a run or claim holds, a `waiting` or
  `blocked` hold against that state, an unassigned line that is ready work against `ready`; every other hold is
  ignored (counted). It names the first 50 tasks they disagree on, including a store task fill has no line for and a
  line the store does not have. A status read in `observe` opens the store, and so creates its file.

## 7. Security

### 7.1 Agents are untrusted

- An agent's report is bound to the task its run holds, by `getClaimedTask(binding.runId) === taskId` (the same
  check `BusService.report` makes today). It cannot report for another task, even if it knows the id. A report after
  the claim was released is refused.
- The bus token is scoped to one run; agent, run and task come from the token binding only. The work store keeps no
  run id of its own to compare with (1.5).
- An agent cannot read another agent's brief or task details (task() returns only its own).

### 7.2 Owner-only transitions

Some transitions require an owner session:

- `* → dropped`: only owner
- `dropped → open` (reopen): only owner
- `blocked → ready` when blocked by owner: only owner

The check is made **on the authenticated session in the route layer** (`requireOwnerForChanges`, 4.2), which
builds the actor. The store takes that actor as a trusted argument from the routes and modules in the same
process; an `actor` in a request body is never read. ROADMAP rule 1: a name in the request proves nothing.

### 7.3 Audit trail

Every change is an event with actor, timestamp, and before/after state. The events table is append-only. Events
are never deleted; those of tasks terminal for more than `retention_days` are archived and stay readable (3.6). The
actor on a process-written event is a role (`agent`, `owner`, `module`, `system`), never a tool or vendor name.

### 7.4 Restart safety

A transition spans two databases (`data/work/<project>.db` and `data/agents.db`) and side effects (mirror files,
tracker sync). No single SQLite transaction covers that, so each has a **write order** and a **recovery on start**.
The reconcile runs **before fill's first tick** (the same gate the restart-adoption design uses). In `observe` (work
store 2) nothing reads the store, so its replay starts with the follower, after the agents module and the bus have
started; work store 3, where fill reads the store, moves it before fill's first tick.

| Transition | Write order | Recovery on start |
|---|---|---|
| `ready` to `assigned` to `running` | 1. the run is inserted in the agents store; 2. the claim; 3. the work store writes its event (the task row's stored state stays `ready`, 2.1) | A claim whose task has no row raises one notice. An event naming a run with no active run and no claim is closed with a `claim_lost` event; the task shows `ready` again. After a kill between 1 and 3 there is one derived state and one run |
| Report to `waiting`, `blocked`, `in_review` | 1. the bus store records the report; 2. the work store applies the state and event in one transaction | A report with no matching work event is replayed from the bus's last applied report id (idempotent by report id) |
| Mirror write | 1. an intent row with the file's expected hash; 2. the file write; 3. the intent is cleared | An intent found at start: if the file hash equals the expected after-hash the write finished (clear it); if it equals the before-hash it is rolled back (retry); otherwise it is a foreign edit (6.2) |
| Tracker sync | The tracker records the last synced event id per task | Replayed from that id, idempotent by the tracker's link for the task (an update to an issue already in the target state is a no-op) |

Like planner.md's `INTENT` and `afterHash`, but generalised to each side effect above.

## 8. Scale

Design targets:

| Dimension | Target | How |
|---|---|---|
| Tasks | 5,000 per project | Indexed by state, agent, priority |
| Events | 200,000 per project | Indexed by task, kind; archived past retention |
| Agents | 50 concurrent | One task per agent (wip_limit); separate runs |
| Query paths | < 10 ms | The seven queries in 3.7, each with its named index; no full scans |

The SQLite store handles this easily. Postgres (M6) handles more.

## 9. Migration plan

### 9.1 Lair's own project first

Lair's own project goes to `on` with `files: none` first, as it has no legacy scripts. This validates the design
before other projects adopt it.

### 9.2 Existing projects

```
off ──▶ observe (dry run, apply, compare) ──▶ observe + follow (kept current, compared with fill's view)
    ──▶ on + follow (fill reads the store) ──▶ the planner and the owner write the store, files: mirror ──▶ files: none
```

Each step is a config change, and each is undone by the previous value: until `files: mirror` the files stay the
input every writer edits, so `mode: off` is always today's behaviour. No data migration is needed beyond the import.

**Agents during the switch.** Agents never change. They report through the bus with their run's token, or by a line
in the queue file. In `observe` both reach fill as today, and the store through the bus consumer and the follower.
In `on`, fill reads the state those two keep current: a bus report at once (the event, then the cursor), a
hand-written line when the follower sees the queue file change. The planner keeps writing the tasks file, which is
followed, until it writes the store itself (work store 4).

## 10. PR plan

Each PR stays under about 450 non-test lines (work store 1: 600), drives the real entry point in its tests, and says
in its body how each acceptance test was checked to fail on main, with revert-check lines.

| PR | What | Size | Acceptance tests (fail on main) |
|---|---|---|---|
| WS1 | Schema v1, `SqliteWorkStore`, the task and event model, the importer (dry run and apply), the read API, `work_store.mode: off \| observe` | ~600 | Every route is 403 without the owner session; a dry run reports `Feat-1.2`, `area/topic#3`, a done line and a malformed-line warning and writes nothing; an apply stores the DONE, WAITING and BLOCKED states fill's checks read, a second apply changes nothing, a removed line is dropped and an unreadable file drops nothing; a claimed task reads `running` with no write to its row; a newer or foreign store file is refused |
| WS2 | The follower (import on file change) and the bus consumer (reports and claim facts by cursor, v2 `work_cursors`, replay at start); `files: follow`; the status compares the store with fill's view | ~450 | A report applies once across a restart between the bus write and the store write; an unchanged file is not re-read; the comparison names a task fill and the store disagree on |
| WS3 | `mode: on`: fill takes its lines and their done, waiting and blocked state from the store; no tasks-file parse or queue window per check | ~450 | Fill starts the store's ready task with the tasks file unreadable; a DONE bus report closes the task without a queue read; `mode: off` again is today's behaviour |
| WS4 | `WorkStoreProducer` for the planner, owner writes (create, edit, drop, reopen), `work_task_deps` | ~450 | A proposal creates a task through the producer; the planner agent has no route to the store; a write without the owner session is 403 before the body is read |
| WS5 | `files: mirror`: hash detection, intent rows, one notice per file | ~400 | A foreign line in the queue file survives the next mirror write; one notice for ten edits; a kill between intent and write is reconciled at start |
| WS6 | Board (read-only, `work` WebSocket channel), then owner transitions; `tier`, `labels` | ~400 | The board shows a derived `running`; a drag without the session changes nothing |
| WS7 | Briefs (versioned, `work_briefs`), the `task()` and `check()` bus tools | ~400 | An agent sees the brief version current at run start; another run's task is refused |
| WS8 | The tracker reads tasks from the store (`TaskSource`) | ~150 | The tracker's reconcile in `on` makes the same writes as from the files |
| WS9 | Backups, export, retention (3.5, 3.6) | ~350 | A JSON export round-trips; retention never touches an open task's events |

## 11. Open questions for the owner

1. **Event retention**: 90 days after a task is terminal (3.6). Does that work, or should it be longer?
   - **Recommendation**: 90 days is enough for debugging; archived events stay readable on the task page.

2. **WIP limit default**: 1 task per agent. Should this be configurable per agent?
   - **Recommendation**: Per-project is enough. An agent that needs more can be exempt in config.

3. **Brief size limit**: 200 KB. Is that enough for large specs?
   - **Recommendation**: 200 KB is about 50,000 words; briefs should be focused. Link to external docs if
     needed.

## 12. External trackers

The store is the source of truth. GitHub Issues, Projects boards and milestones sync FROM it, not to it.

### 12.1 Task ↔ issue links

The tracker's link for a task (a `tracker_links` row in the tracker's own store, 1.1) ties it to a GitHub issue; the
task row holds no copy of it. A link names:

```typescript
interface ExternalRef {   // the tracker's link, as the tracker reads it

  provider: 'github';
  owner: string;      // e.g. 'example-org'
  repo: string;       // e.g. 'example-repo'
  number: number;     // Issue number
  url: string;        // Full URL
}
```

### 12.2 Status mapping

**Options.**

| Option | For | Against |
|---|---|---|
| A. One `status/*` label per state, issue open or closed by done/dropped (recommended) | Every state is visible in the issue list and filterable; closing follows the terminal states | Nine labels to create; `assigned` and `running` labels follow the derived state (1.5), so they can flip when a claim is lost |
| B. Only open/closed | No labels to maintain | The issue list says nothing about progress |
| C. A Projects board column per state | Native board view | Needs a board per repo and extra API scopes; the labels already carry the same data |

Recommendation: A. The tracker reads the *derived* state from the read model, never from a stored holder.

| Task state | GitHub issue state | GitHub label |
|---|---|---|
| open | open | status/open |
| ready | open | status/ready |
| assigned | open | status/assigned |
| running | open | status/in-progress |
| waiting | open | status/waiting |
| blocked | open | status/blocked |
| in_review | open | status/in-review |
| done | closed (completed) | — |
| dropped | closed (not planned) | — |

Labels are created if they don't exist. Other labels (feature, bug, etc.) stay as-is.

### 12.3 Adopting existing issues

The importer can link existing issues to tasks by matching on title or a `task: <id>` marker in the issue
body. Unmatched issues become new tasks in `open` state.

### 12.4 Reconciliation

A sync cycle (every 5 minutes, or on webhook):

1. For each task the tracker has a link for: compare state. If different, update the issue.
2. For each open issue without a task: create a task (if `tracker.auto_import: true`) or log it.
3. For each task whose issue was edited on GitHub: the edit becomes a decision ("accept GitHub edit" or
   "revert to store state") unless it's only a label or assignee change, which the tracker handles
   automatically.

### 12.5 Who wins on conflict

The store wins. An edit made on GitHub that changes the title or state becomes a decision or intake item,
not an automatic override. This preserves the principle that Lair is the source of truth.

### 12.6 Tracker module compatibility

The tracker module is on main (`src/server/tracker/`). It reads tasks through `TaskSource` (`tracker/tasks.ts`),
whose comment already names the work store as another source, and keeps its links, sync state and audit in its own
store. Work store 8 adds a store-backed `TaskSource` (open: tasks not `done` or `dropped`; done: `done`), chosen when
`work_store.mode` is `on`. The links stay in `tracker_links` (1.1: no `externalRef` copy); the tracker's interface
stays the same and only its data source changes.
