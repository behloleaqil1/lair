# Work store: tasks, events, briefs and messages in Lair's database

> Status: design. This document covers what the work store is and how it will be built. A reviewer reads it line by
> line, and the owner approves it, before code begins. Roadmap: [ROADMAP.md](ROADMAP.md) A (follows the bus). Relates to:
> [phase3-bus.md](phase3-bus.md) (agents report through the bus), [planner.md](planner.md) (proposals become tasks),
> [autonomy.md §4](autonomy.md) (the planner module), [autonomy.md §6](autonomy.md) (agents),
> [configuration.md](../configuration.md#fill) (fill's tasks file).

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
interface Task {
  id: string;                   // Valid per isValidTaskId (agents module), see the id rule below
  project: string;              // Project this task belongs to
  title: string;                // Short description, max 200 chars
  state: TaskState;             // See 2.1; `assigned` and `running` are derived, see 1.5
  agent: string | null;         // Intended assignee (today's agent column). NEVER the holder, see 1.5
  priority: number;             // 1-999, lower = higher priority
  tier: RiskTier;               // red, amber, green
  source: TaskSource;           // Where this task came from
  labels: string[];             // User-defined labels
  briefId: string | null;       // Reference to versioned brief
  dependencies: string[];       // Task ids this waits on
  blockedReason: string | null; // Why blocked, if state is blocked
  externalRef: ExternalRef | null; // Link to GitHub issue, etc.
  createdAt: number;
  updatedAt: number;
  version: number;              // Optimistic locking
}

type TaskState = 'open' | 'ready' | 'assigned' | 'running' | 'waiting' | 'blocked' | 'in_review' | 'done' | 'dropped';

type RiskTier = 'red' | 'amber' | 'green';

interface TaskSource {
  kind: 'plan' | 'backlog' | 'intake' | 'planner' | 'owner' | 'import';
  ref: string;    // Document path, section id, or import source
}

interface ExternalRef {
  provider: 'github' | 'gitlab' | 'jira';
  owner: string;
  repo: string;
  number: number;
  url: string;
}
```

**One id rule.** There is one task-id rule in Lair: `isValidTaskId` from the agents module, which wraps
`TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._/#:-]{0,127}$/` (`agents/types.ts`). Fill, the planner's proposals and the
queue matching already enforce it, so ids such as `Feat-1.2` or `area/topic#3` exist in real task files. The store,
the routes and the importer call that function; none defines its own pattern. (Ids contain `/`: route handlers
URL-decode `:id` and the store treats it as an opaque string.)

### 1.2 Task events

An append-only timeline of everything that happened to a task.

```typescript
interface TaskEvent {
  id: string;                   // UUID
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
| assigned/running/waiting | ready | agents (claim released, lost or replaced) | The claim is gone, reason in the event |
| * | dropped | owner | Owner drops the task |
| dropped/done | open | owner | Owner reopens |

`assigned` and `running` are the two states the work store does not own: they follow the claim. The stored state
stays `ready` until the claim exists, and the read model shows the derived state. Every other state is stored.

**Required fields per state** (checked on the transition; a missing field refuses it with a named error):

| State | Required |
|---|---|
| `open` | `title`, `source` |
| `ready` | `open` requirements, every dependency `done`, `briefId` (a brief, even a one-line one, exists) |
| `waiting` | `gateId` (the gate the run waits on) |
| `blocked` | `blockedReason` (non-empty, 1-500 chars) |
| `in_review` | `pr` (number) and `sha` |
| `done` | `pr` and `sha` when the task came from a PR flow; for tasks closed by the owner, an `owner` actor and a reason |
| `dropped` | a reason (1-500 chars) and an `owner` or `planner` actor |

The required values live on the transition's event payload and are copied to the task row only where the model has
a column (`blocked_reason`).

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
├── store.ts          # WorkStore class
├── store.test.ts     # Unit tests
├── types.ts          # Task, Brief, TaskEvent interfaces
├── manager.ts        # WorkManager: project lifecycle, event subscriptions
├── routes.ts         # REST API
├── adapters.ts       # File adapter interfaces
└── index.ts
```

### 3.2 SQLite now, Postgres later

**Options.**

| Option | For | Against |
|---|---|---|
| A. SQLite only, behind a repository interface (recommended) | Same as every Lair store; the interface is at the level of domain operations, so a Postgres implementation can follow (M6, platform.md) without touching callers | One more layer than the other stores |
| B. A generic SQL backend (`query`, `exec`, `transaction`) | Looks small | A SQL-level interface cannot be synchronous for Postgres (no Node client is), and SQLite's `better-sqlite3` is. A synchronous interface rules Postgres out; an async one makes every caller async for no gain today |
| C. SQLite calls directly in the store, no interface | Least code | Postgres later means a rewrite of every caller |

Recommendation: A. The boundary is an **async `WorkStore` repository interface** (`createTask`, `transition`,
`appendEvent`, `listByState`, `readyByPriority`, `timeline`, `dependents`, `byExternalRef`, ...). The first
implementation is `SqliteWorkStore` (its methods return resolved promises; transactions are internal to one
method). A `PostgresWorkStore` is a second implementation of the same interface. Cost: every caller `await`s, which
the HTTP routes and the planner already do. A transition that spans repository calls (4.4, 7.4) is expressed as one
repository method, never as a caller holding a transaction.

### 3.3 Schema

```sql
-- Schema version 1
CREATE TABLE work_tasks (
  id TEXT NOT NULL,
  project TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  agent TEXT,
  priority INTEGER NOT NULL DEFAULT 500,
  tier TEXT NOT NULL DEFAULT 'green',
  source_kind TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  labels TEXT NOT NULL DEFAULT '[]',  -- JSON array
  brief_id TEXT,
  dependencies TEXT NOT NULL DEFAULT '[]',  -- JSON array, display copy; work_task_deps is queried
  blocked_reason TEXT,
  external_provider TEXT,
  external_owner TEXT,
  external_repo TEXT,
  external_number INTEGER,
  external_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (project, id)
);
CREATE INDEX idx_work_tasks_state ON work_tasks(project, state);
CREATE INDEX idx_work_tasks_agent ON work_tasks(project, agent) WHERE agent IS NOT NULL;
CREATE INDEX idx_work_tasks_priority ON work_tasks(project, state, priority) WHERE state IN ('open', 'ready');
CREATE UNIQUE INDEX idx_work_tasks_external
  ON work_tasks(project, external_provider, external_owner, external_repo, external_number)
  WHERE external_number IS NOT NULL;

CREATE TABLE work_task_deps (
  project TEXT NOT NULL,
  task_id TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (project, task_id, depends_on)
);
CREATE INDEX idx_work_task_deps_reverse ON work_task_deps(project, depends_on);

CREATE TABLE work_events (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_run_id TEXT,
  payload TEXT NOT NULL,  -- JSON, max 64 KB
  at INTEGER NOT NULL
);
CREATE INDEX idx_work_events_task ON work_events(project, task_id, at);
CREATE INDEX idx_work_events_kind ON work_events(project, kind, at);

CREATE TABLE work_briefs (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  task_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,  -- max 200 KB
  created_by_kind TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_work_briefs_task_version ON work_briefs(project, task_id, version);
```

### 3.4 Schema versioning and migrations

Like other stores, use `user_version` pragma:

```typescript
export const SCHEMA_VERSION = 1;

constructor(dbPath: string) {
  this.db = new Database(dbPath);
  this.db.pragma('journal_mode = WAL');
  this.db.pragma('busy_timeout = 5000');

  const version = this.db.pragma('user_version', { simple: true }) as number;
  if (version < SCHEMA_VERSION) {
    this.migrate(version);
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}
```

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
| Task by external ref | tracker sync | `idx_work_tasks_external` (unique) |
| Tasks of an agent | owner page | `idx_work_tasks_agent` |

`dependencies` JSON on the task row is a display copy written in the same transaction as `work_task_deps`; the
table is what queries read. The "< 10 ms" target in section 8 holds for these seven.

## 4. Access

### 4.1 Agent access: bus tools and HTTP

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

HTTP routes for curl access (no node needed):

```
GET  /api/work/task                   # Same as task() tool
POST /api/work/report                 # Same as report() tool
GET  /api/work/check?what=gate
```

These routes require the run's bus token, issued by the agents module at run start. **Agent, run and task are derived
from the token binding only.** There is no `run_id` parameter, and a `run_id` or `actor` in a query or body is
ignored (and logged once as a notice-worthy mismatch if it differs from the binding). Every event the route writes
records that derived actor, which is the audit trail.

### 4.2 Owner access

Owner routes require an owner session (`src/server/human-auth/`). Owner-only is a **route property**, not a store
check: `/api/work` is added to `OWNER_ONLY_PREFIXES`, reads that expose paths or other projects' data use
`requireOwner()`, and writes use `requireOwnerForChanges()`. Both run before the body is parsed. The route layer
builds the actor from the authenticated session (`{ kind: 'owner', id: session.subject }`) and passes it to the
store as a trusted argument; the store has no way to read an actor from a request body. The agent routes in 4.1
are the single exception to the prefix: they authenticate by bus token and are mounted under `/api/work/agent/`
(`/api/work/agent/task`, `/report`, `/check`), outside the owner-only prefix by design.

```
GET    /api/work/tasks?project=<p>&state=<s>&limit=<n>
GET    /api/work/tasks/:id
POST   /api/work/tasks                # Create task
PATCH  /api/work/tasks/:id            # Edit task
DELETE /api/work/tasks/:id            # Drop task
POST   /api/work/tasks/:id/reopen
GET    /api/work/tasks/:id/events
GET    /api/work/tasks/:id/brief
POST   /api/work/tasks/:id/brief      # New brief version
GET    /api/work/export?project=<p>&format=json|md
POST   /api/work/import               # Import from the configured files (6.4); body: { dry_run }
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

The `live` module (live UI, PR 2b) is the transport: it replaces main's SSE feed (`/api/bus/events`) with topics,
coalescing (one update per row per 250 ms) and an 8 KB cap. The work store publishes on a `work` topic keyed by
project; the board and detail view subscribe to it. No SSE route is added for the work store.

## 6. Files as adapters

Three modes, configured per project:

```yaml
work_store:
  mode: db | mirror | files
```

### 6.1 `files` mode (default for existing projects)

The store reads from and writes to the legacy files. This is today's import path:

- **Read**: parse tasks file, queue file, brief files on each cycle.
- **Write**: changes go to files, not the database.
- **Events**: queue lines become events in the database for the timeline.

This mode lets a project adopt the work store without changing anything else.

### 6.2 `mirror` mode (transition)

The database is truth; Lair writes the legacy files read-only for old scripts:

- **Read**: from database only.
- **Write**: to database; then mirror to files as a side effect.
- **Conflict detection**: if a legacy writer edits a mirrored file, Lair detects the mtime change, logs a
  warning, and overwrites with the database state. A repeated conflict raises a decision: "disable file
  mirroring or stop the legacy writer."

Mirror mode lets a project observe the new system before retiring file-based tools.

### 6.3 `db` mode (target)

Database only. No file reads or writes. This is the target for new projects and for projects that have
retired their legacy scripts.

### 6.4 Importer

```
POST /api/work/import
{
  "project": "my-project",
  "dry_run": true,
  "sources": {
    "tasks_file": "/path/to/dragons.txt",
    "queue_file": "/path/to/queue.md",
    "briefs_dir": "/path/to/briefs/"
  }
}
```

Returns a report: tasks to import, briefs to import, queue lines to parse as events, warnings (malformed
lines, duplicate ids), and what would change. With `dry_run: false`, applies the import.

Line formats are configuration, not one project's habit:

```yaml
work_store:
  import:
    tasks_format: '<agent>|<name>|<task>|<text>'  # default
    done_pattern: '^- DONE (?<task>[^ ]+)'
    waiting_pattern: '^- WAITING (?<task>[^ ]+) (?<gate>[^ ]+)'
    blocked_pattern: '^- BLOCKED (?<task>[^ ]+)'
```

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
- `blocked → running` when blocked by owner: only owner

The store checks `actor.kind === 'owner'` for these.

### 7.3 Audit trail

Every change is an event with actor, timestamp, and before/after state. The events table is append-only;
events are never deleted, only archived.

### 7.4 Restart safety

Like planner.md: writes record their intent in the store first, so a restart in the middle finds out
whether the change completed.

## 8. Scale

Design targets:

| Dimension | Target | How |
|---|---|---|
| Tasks | 5,000 per project | Indexed by state, agent, priority |
| Events | 200,000 per project | Indexed by task, kind; archived past retention |
| Agents | 50 concurrent | One task per agent (wip_limit); separate runs |
| Query paths | < 10 ms | Indexes on common queries; no full scans |

The SQLite store handles this easily. Postgres (M6) handles more.

## 9. Migration plan

### 9.1 Lair's own project first

Lair's own project starts on `db` mode, as it has no legacy scripts. This validates the design before other
projects adopt it.

### 9.2 Existing projects

```
files mode ──▶ mirror mode (observe 7 days) ──▶ retire writers ──▶ db mode
```

Each step is a config change; no data migration needed (the importer runs once at adoption).

## 10. PR plan

Five PRs, each with acceptance tests that fail on main:

| PR | Module | What | Lines | Tests |
|---|---|---|---|---|
| W1 | store | WorkStore, importer, read-only API and UI | ~400 | Store CRUD, import parsing, API routes |
| W2 | agents | `task()` and `report()` tools, fill reads store | ~300 | Bus tools work, fill sees ready tasks |
| W3 | planner | Proposals write to store, Work board writes | ~350 | Planner proposals create tasks, board drag works |
| W4 | mirror | Mirror mode, conflict detection | ~250 | Mirror writes files, detects conflicts |
| W5 | briefs | Brief versioning, export | ~200 | Brief history, JSON/MD export |

Each PR adds its own tests. Acceptance tests must fail on main before the change: the PR body says how the
author checked.

## 11. Open questions for the owner

1. **Event retention**: 90 days default. Does that work, or should it be longer?
   - **Recommendation**: 90 days is enough for debugging; archived events are still accessible.

2. **WIP limit default**: 1 task per agent. Should this be configurable per agent?
   - **Recommendation**: Per-project is enough. An agent that needs more can be exempt in config.

3. **Brief size limit**: 200 KB. Is that enough for large specs?
   - **Recommendation**: 200 KB is about 50,000 words; briefs should be focused. Link to external docs if
     needed.

## 12. External trackers

The store is the source of truth. GitHub Issues, Projects boards and milestones sync FROM it, not to it.

### 12.1 Task ↔ issue links

A task's `externalRef` links it to a GitHub issue:

```typescript
interface ExternalRef {
  provider: 'github';
  owner: string;      // e.g. 'example-org'
  repo: string;       // e.g. 'example-repo'
  number: number;     // Issue number
  url: string;        // Full URL
}
```

### 12.2 Status mapping

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

1. For each task with an `externalRef`: compare state. If different, update the issue.
2. For each open issue without a task: create a task (if `tracker.auto_import: true`) or log it.
3. For each task whose issue was edited on GitHub: the edit becomes a decision ("accept GitHub edit" or
   "revert to store state") unless it's only a label or assignee change, which the tracker handles
   automatically.

### 12.5 Who wins on conflict

The store wins. An edit made on GitHub that changes the title or state becomes a decision or intake item,
not an automatic override. This preserves the principle that Lair is the source of truth.

### 12.6 Tracker module compatibility

The tracker module (its own design doc, when it lands) builds the sync against today's task model. This design
ensures the tracker can move onto the work store with no behaviour change:

- The tracker reads tasks from the work store instead of files.
- It updates `externalRef` when it syncs.
- The event types it listens to (`work.task.*`) carry the same information.

The tracker module's interface stays the same; only its data source changes.
