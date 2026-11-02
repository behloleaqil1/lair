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
- `proposals.ts`: the matching behind link proposals (task id named, close titles).
- `routes.ts`: `GET /api/tracker/status`, `POST /api/tracker/reconcile` and `POST /api/tracker/links`, all the owner's.

## Decisions

**Events never wait on GitHub.** `EventBus.emit` awaits each handler in turn, so a handler that awaited GitHub would hold up the planner, the agents module or the review module behind a slow or hung connection. A tracker handler only parses the payload and queues a job. Jobs run one at a time per project, which also means two events for one task never interleave. The queue is bounded (500); a dropped job is counted and the next reconcile catches up. Every request has a timeout and is aborted when the tracker stops.

**Desired state in the store, writes as attempts.** A link holds the column, agent and closed state Lair wants. An event updates it and tries to send; a write that fails (rate limit, budget, network) leaves the desired state, and the reconcile sends it again. Drift fixed counts only fixes that were sent.

**Observe mode never writes.** Two layers: `write()` records the change as `would_send` (one row per distinct change, counted up on repeats) and sends nothing; and the client is built read-only, so any write that bypassed the gate is refused before a request leaves. Links to existing issues are made in observe mode too: they live in Lair's store only.

**At most one issue per task.** The link is checked first; a create is recorded as pending before it is sent and its body carries a hidden marker; a later attempt (an event, the reconcile, a restart) looks for the marker in the issues list (strongly consistent, unlike search) before creating; the link is stored as soon as the issue exists, before the board is touched, so a board failure never leads to a second issue. Title adoption uses search and is never the guard against duplicates.

**Only issues named on purpose are adopted.** An explicit keyword (`Issue:`, `Closes`, `Fixes`, `Resolves`, `Tracks`) with `#N`, an issue URL or `owner/name#N` of a tracked repository; never a bare `#N`, never another repository, never a closed issue or a pull request. A PR's closing keywords are resolved the same way: `#N` is the PR's own repository. (The exact-title search is tried for at most 10 unlinked tasks a reconcile, each reconcile starting where the last one stopped, so a task past the 10th is reached too.)

**Link proposals: guesses are proposed, not adopted.** On a real project most task lines name no issue and few issues carry a task's exact title, so most tasks never reached the board. Matching more loosely would link wrong issues, so the reconcile proposes instead (`proposals.ts` matches, `reconcileProposals` decides): for the unlinked tasks a tracked repository takes (none named, no create pending), it reads one page of each repository's open issues (the newest 100 by update; nothing when no task needs it) and finds an issue whose title or body names the task id as a word (`mentions_task`; only a distinctive id: 4 characters or more, a letter, and a digit or a separator), an open PR of the task (branch ending with the id, or the body naming it) that closes an open, unlinked issue (`pull_closes`, from the open-PR list the reconcile reads anyway; at most 5 issues read one by one), or a title close to the task's (`similar_title`: Dice coefficient of character bigrams, 0.85 or more). Texts are bounded and each issue is indexed once; the event loop gets a turn between tasks.

Candidates come only from the repository the task goes to (`repoFor`). One candidate that no other task shares is `would_link`; anything else is `ambiguous` and only the owner can resolve it. A proposal becomes a link only with `auto_link: true` in act mode (a bounded number a reconcile, and only when the task id is named or the task's PR closes the issue: a close title alone also matches a sibling task's issue, "... bug 1" against "... bug 2", whose own task may be done or gone) or when the owner accepts it (`POST /api/tracker/links`, owner-only: checked against the last proposals in the request, made by a queued job that reads the issue again, audited with the session); otherwise it is one deduplicated `would_link` row in the audit and a line in the status. Observe mode never auto-links: it is the dry run that shows what `auto_link` would do. A failed read keeps the previous proposals and links nothing, since a repository not read could hold a second candidate.

**Real payloads.** The handlers read what the modules emit: `planner.changed {op, task, source, outcome}` (only `applied`), `planner.blocked {task, agent, class, rule}`, `agent.run.started {kind, agent, task, ...}`, `review.submitted` and `review.merged {pr, ...}` (a number only: the tracker reads the PR's body and branch from GitHub, in the repository of the project's review module). `contract.test.ts` drives the real planner, agents module and review module.

**Merges seen without the review module.** `review.merged` is emitted only when the review module merges; a PR merged by another path (a script's fast-forward push, `gh pr merge`, the web UI) emits nothing, and its tasks would stay In review. The reconcile closes that gap by reading, not by listening: while a linked task is In progress or In review, it reads one page of each tracked repository's closed PRs (the newest 100 by update; one request per repository, the client's timeout and abort apply) and matches them exactly as `review.submitted` does (`linksOfPull`: the issues a PR closes, a task id ending its branch name). A merged PR goes through the same `finish(task, "completed")` as `review.merged` (Done, then the issue closed as completed), so the write gate, the budget and observe mode apply unchanged. A list rather than a per-task lookup keeps the cost fixed (the PR list has `merged_at`, so no second read is needed), and it runs inside the reconcile job, never in an event handler. Once finished, a task is not a candidate any more, so the move is applied once, also across a restart; a later `review.merged` for the same PR finds nothing to change. A PR closed without merging changes nothing and is listed in the status (`closedUnmerged`), recomputed by each reconcile. Limits: at most 10 tasks finished a reconcile; a PR that has left the newest 100 closed ones is not seen.

**Task lines removed by hand.** A linked task whose line left the tasks file (deleted or commented out) while no `planner.changed drop` came was dropped by hand. The reconcile counts, in memory, the reconciles in a row that missed it (not in the open lines, not done); at 2 it counts as dropped. Two reconciles, not one, because a file caught in the middle of an edit must never close an issue. A line fill refuses (malformed, too long, past its cap) is still in the file: the task source reports every task-id-shaped word on such lines (`mentioned`), and those tasks are never counted. A file with no task line at all is taken for a broken write and counts nothing. Closing is behind `close_removed_tasks` (default off): on, the task goes through `finish(task, "not_planned")` like a planner drop (the issue closed as not planned, at most 10 a reconcile); off, a `would_close` row is recorded in the audit (deduplicated, counted up) and the task is listed in the status (`removedTasks`). The count is not persisted: a restart or a reload starts it again, which can only delay a close, never cause one. Only a task this process has seen in the file counts (`seenPresent`): a reload that points `agents.fill.tasks_file` at another file would otherwise make every link "missing" at once.

**Several repositories.** `repos` lists them, each with its own board, status mapping, labels, milestone rules, create switch (`create_issues`, default the project-wide `create_issues_for_new_tasks`: a public repository can link without ever receiving task text in a new issue) and redaction patterns. A task goes to the repository its line names, else the first `match` rule, else the default. Board items are keyed by repository and number, so the same issue number in two repositories never mixes.

**The token is the owner's problem, raised once.** The tracker reads the token's scopes at start; missing ones stop its writes and raise one decision listing them (deduplicated by key while open), answered by "check again". A 401 or a non-rate-limit 403 also stops writes. Fine-grained tokens report no scopes and are not refused up front.

**Rate limits.** A 429, a 403 marked as a rate limit (`Retry-After`, `X-RateLimit-Remaining: 0`, the message) and a GraphQL `RATE_LIMITED` set a wait; no request is sent before it ends, and it is kept across a restart. Any other 403 is a permission problem, never retried as a rate limit. Writes also have a per-minute budget, creates included.

**Redaction by default.** Built-in rules (secret environment values, token and key shapes, credentials, absolute paths and the home directory, emails, private addresses) run before the owner's `redact_patterns`, on titles as well as bodies and comments. Then the repository's own `repos[].redact_patterns`, on that repository's texts only (each repository has its own redactor: `withPatterns` over the project's), so a name a public repository must never see can stay in the private repository's issues. The bound is applied after every pattern, so a cut never leaves part of a name; a task id a repository's redaction changes is not searched for there. A blocked comment carries Lair's own words and the planner's class and rule, never the agent's text.

**No synchronous I/O on the event loop.** The tasks file is read with `fs/promises`; the token command runs with the asynchronous `execFile`; a test fails if a tracker source uses a `*Sync(` call or `child_process` directly. Only the SQLite store is synchronous, as every Lair store is.

## Not built yet

- The Tracker tab in Work, and a supervisor health check for a sync that keeps failing (the status route has what both need).
- Labels per risk tier and milestones from plan sections (the original brief); milestone rules by task glob cover the first use.
