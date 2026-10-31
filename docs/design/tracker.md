# Tracker: GitHub issues, boards and milestones managed by Lair

Status: built (module `src/server/tracker/`). Configuration: [configuration.md#tracker](../configuration.md#tracker).

## Why

A project's work is on GitHub: an issue per task, Projects (v2) boards with a Status column and an Agent field, milestones with the owner's due dates. Nobody should move cards by hand: Lair knows when a task is added, started, blocked, reviewed, merged or done, so it keeps GitHub true to that. The provider is GitHub; another tracker (GitLab, Jira, Linear) would be another client behind the same service.

## Shape

```
planner.changed / planner.blocked ─┐
agent.run.started                  ├─> TrackerService (one per project)
review.submitted / review.merged ──┘     │  handler: queue a job, return
                                         │  bounded queue, one job at a time
periodic reconcile ──────────────────────┤
POST /api/tracker/reconcile (owner) ─────┘
                                         ▼
                    store (data/tracker.db): links, pending creates,
                    sync state, audit of every write
                                         ▼
                    write(): observe records │ act: budget, audit, send
                                         ▼
                    GitHubTrackerClient: REST + GraphQL, timeouts,
                    rate limits, read-only in observe mode
```

- `manager.ts`: one service per project with `tracker.enabled`, wired in `src/server/index.ts` (load, start after the planner and the agents, live reload through `reload/modules.ts`, stop before the store closes). The store is opened only when a project enables the tracker. Start never waits on GitHub and never throws.
- `service.ts`: the event handlers, the queue, the write gate, linking, the board, blocked labels, PRs, the reconcile, the scope check and its decision.
- `github-projects.ts`: the client. One per project (one token) for all its repositories.
- `store.ts`: its own file; its schema version in its own table (`PRAGMA user_version` belongs to other stores: a file with one set is refused, and so is a newer schema).
- `tasks.ts`: the tasks it follows, agents.fill's tasks file, read asynchronously and parsed as the planner parses it. The work store, once tasks live there, is another source.
- `redact.ts`: what every outgoing text goes through.
- `routes.ts`: `GET /api/tracker/status` and `POST /api/tracker/reconcile`, both the owner's.

## Decisions

**Events never wait on GitHub.** `EventBus.emit` awaits each handler in turn, so a handler that awaited GitHub would hold up the planner, the agents module or the review module behind a slow or hung connection. A tracker handler only parses the payload and queues a job. Jobs run one at a time per project, which also means two events for one task never interleave. The queue is bounded (500); a dropped job is counted and the next reconcile catches up. Every request has a timeout and is aborted when the tracker stops.

**Desired state in the store, writes as attempts.** A link holds the column, agent and closed state Lair wants. An event updates it and tries to send; a write that fails (rate limit, budget, network) leaves the desired state, and the reconcile sends it again. Drift fixed counts only fixes that were sent.

**Observe mode never writes.** Two layers: `write()` records the change as `would_send` (one row per distinct change, counted up on repeats) and sends nothing; and the client is built read-only, so any write that bypassed the gate is refused before a request leaves. Links to existing issues are made in observe mode too: they live in Lair's store only.

**At most one issue per task.** The link is checked first; a create is recorded as pending before it is sent and its body carries a hidden marker; a later attempt (an event, the reconcile, a restart) looks for the marker in the issues list (strongly consistent, unlike search) before creating; the link is stored as soon as the issue exists, before the board is touched, so a board failure never leads to a second issue. Title adoption uses search and is never the guard against duplicates.

**Only issues named on purpose are adopted.** An explicit keyword (`Issue:`, `Closes`, `Fixes`, `Resolves`, `Tracks`) with `#N`, an issue URL or `owner/name#N` of a tracked repository; never a bare `#N`, never another repository, never a closed issue or a pull request. A PR's closing keywords are resolved the same way: `#N` is the PR's own repository.

**Real payloads.** The handlers read what the modules emit: `planner.changed {op, task, source, outcome}` (only `applied`), `planner.blocked {task, agent, class, rule}`, `agent.run.started {kind, agent, task, ...}`, `review.submitted` and `review.merged {pr, ...}` (a number only: the tracker reads the PR's body and branch from GitHub, in the repository of the project's review module). `contract.test.ts` drives the real planner, agents module and review module.

**Several repositories.** `repos` lists them, each with its own board, status mapping, labels and milestone rules. A task goes to the repository its line names, else the first `match` rule, else the default. Board items are keyed by repository and number, so the same issue number in two repositories never mixes.

**The token is the owner's problem, raised once.** The tracker reads the token's scopes at start; missing ones stop its writes and raise one decision listing them (deduplicated by key while open), answered by "check again". A 401 or a non-rate-limit 403 also stops writes. Fine-grained tokens report no scopes and are not refused up front.

**Rate limits.** A 429, a 403 marked as a rate limit (`Retry-After`, `X-RateLimit-Remaining: 0`, the message) and a GraphQL `RATE_LIMITED` set a wait; no request is sent before it ends, and it is kept across a restart. Any other 403 is a permission problem, never retried as a rate limit. Writes also have a per-minute budget, creates included.

**Redaction by default.** Built-in rules (secret environment values, token and key shapes, credentials, absolute paths and the home directory, emails, private addresses) run before the owner's `redact_patterns`, on titles as well as bodies and comments. A blocked comment carries Lair's own words and the planner's class and rule, never the agent's text.

**No synchronous I/O on the event loop.** The tasks file is read with `fs/promises`; the token command runs with the asynchronous `execFile`; a test fails if a tracker source uses a `*Sync(` call or `child_process` directly. Only the SQLite store is synchronous, as every Lair store is.

## Not built yet

- The Tracker tab in Work, and a supervisor health check for a sync that keeps failing (the status route has what both need).
- Labels per risk tier and milestones from plan sections (the original brief); milestone rules by task glob cover the first use.
