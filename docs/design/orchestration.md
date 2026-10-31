# Orchestration: Lair replaces the human orchestrator

> Status: design spec. Roadmap: [ROADMAP.md](ROADMAP.md) section O. Reference: each section below names its module
> and config prefix.

## What this is

An orchestrator is the person, or the AI assistant, who keeps a project running overnight: assigning tasks, noticing
stalls, answering "why is nothing merging?", diagnosing infrastructure failures, adjusting capacity, and deciding what
to do when a gate fails. Today that is a human (or an AI with a terminal). This document specifies how Lair absorbs
each orchestrator duty, turning it into a feature that runs in code with the AI only at the edges (explaining,
proposing, correlating).

Each duty below names:
- **Problem:** what goes wrong when nobody is watching.
- **Feature:** how Lair handles it.
- **Config:** the settings that control it.
- **Observe → Act:** what changes when the project moves from observe mode to act mode.
- **Acceptance:** how to know it works.

### Kill and restart safety

No duty in this document kills a process by name, pattern, port or user. Every signal targets an exact pid **and**
start time **and** command fingerprint of a process Lair itself started, from the agents store. A mismatch refuses the
signal. Every signal attempt is audited. Restarts are capped per hour, and a start command's argv comes from config
only (never agent text). A process with the same name but a different start time is never signalled.

## Duties

### D1. Never idle: no agent idles while ready work exists

**Problem:** Idle agents while ready work exists. Causes include a second launcher holding at a different load limit,
caps below the number of agents, and agents waiting on their own gate with nothing else to do.

**Feature:** Fill and the planner ensure every agent is busy when ready work exists.
- A Health check and notice: "agent X idle for N min while ready work exists". Ready work comes from the tasks file,
  the backlog, or tracker issues labelled ready.
- **Act mode:** the agent takes the next ready task, highest priority first. The task is matched to the agent's past
  workstream or area when possible.
- **Side tasks while waiting:** an agent whose task is waiting on a gate may run ONE side task from `fill.side_queue`
  (reviews, revert checks, docs), bounded to finish before its gate usually ends (learned durations). A side task is
  a separate run with its own claim under a side agent id, bounded by learned duration and a hard cap, never while
  the main run's process is alive in the same worktree. The main task resumes first when its gate lands.
- A capacity explanation per idle agent: `max_active`, capacity, holds, launcher. One idle agent must never go
  unexplained.

**Config:** `fill.idle.notice_minutes`, `fill.side_queue`, `fill.idle.ready_sources`.

**Observe → Act:**
- Observe: raises the notice; logs the ready work and the reason each agent is held.
- Act: assigns the next ready task within one tick; starts side tasks for waiting agents.

**Acceptance:**
- An idle agent with ready work gets a notice within one tick (fails on main: no notice raised).
- A waiting agent takes a side task and resumes its main task first.
- The notice is raised once per incident.

Related issues: #166.


---

### D2. Brief author: draft task briefs from the issue and code

**Problem:** Writing a good brief (what, why, scope, read-first files, tests, rules) takes the orchestrator 10–20
minutes per task. Without it, agents produce drift, wrong approaches, or incomplete work.

**Feature:** An author agent drafts the brief from the issue, the design doc and a code map; a reviewer agent critiques
it before assignment. Part of C3 (#121, documents-first), applied per task. The brief goes to the owner only if the
reviewer rejects it twice.

**Config:** `briefs.author_role`, `briefs.reviewer_role`, `briefs.template_file`, `briefs.auto_assign` (on/off).

**Observe → Act:**
- Observe: generates the brief and shows it in the task's detail; does not assign.
- Act: assigns the task once the brief passes review.

**Acceptance:**
- A task with an issue and a design doc gets a brief that names the read-first files, the tests, and the scope (fails
  on main: no brief generated).
- A brief that misses scope or tests is rejected by the reviewer and rewritten.
- A task is never assigned with an empty or rejected brief.

Related issues: #177, #121.

---

### D3. Workstream continuation: the same agent takes the next PR of its workstream

**Problem:** When an agent finishes PR 1 of a chain, a different agent picks up PR 2. Context is lost, and the new
agent spends time rediscovering what the first already knew.

**Feature:** Fill tracks workstreams (a set of tasks that share a branch prefix, a design doc, or an explicit label).
When an agent finishes a task, fill offers it the next task in the same workstream before any other, if one exists.
Continuation is a fill preference among ready tasks, written through the planner's producer interface (`add`/`reassign`);
in observe mode it is a `planned` record.

**Config:** `agents.fill.workstream_affinity` (on/off), `agents.fill.workstream_labels`.

**Observe → Act:**
- Observe: logs which agent would get the next workstream task; does not assign.
- Act: assigns the next workstream task to the finishing agent.

**Acceptance:**
- An agent that finishes task A in workstream W is offered task B in W before any other agent (fails on main: no
  preference applied).
- If the agent is unavailable, another agent gets B.

Related issues: #178.

---

### D4. Report verification: a DONE closes a task only when its evidence checks out

**Problem:** An agent reports DONE with a gate id that doesn't exist, a PR that is not at the claimed head, or a task
name that doesn't match its open task. The orchestrator has to audit every claim.

**Feature:** A DONE closes a task only when its evidence checks out:
- The PR exists at that head (verified through the host client).
- The CI or gate result matches (pass, at that head), verified from the gates or pipelines store or a signed result,
  never from the report's text.
- The line names the task (#91, #188).

A DONE without a PR (docs or research tasks) needs an explicit evidence kind per task (`evidence: docs | research |
gate`), else it fails closed as `unverified`. ACKs work the same way: a message claiming "merged" while the host shows
the PR open is flagged in the thread.

Otherwise, Lair marks it as an `unverified report` with the task kept open, and raises a notice.

**Config:** `reports.verify` (on/off), `reports.unverified_notice` (on/off).

**Observe → Act:**
- Observe: logs unverified reports; does not close the task.
- Act: same (a verified report is required to close).

**Acceptance:**
- A DONE with a wrong gate id is not closed; a notice is raised (fails on main: closes anyway).
- A DONE at the correct head with a passing gate closes the task.
- A claim "merged" with the PR open is flagged in the thread.

Related issues: #179.

---

### D5. Audit claims: verify claims against the gate store, the git host and CI

**Problem:** Agents claim "already merged", "gate passed", or "ACK" without evidence. The orchestrator has to verify
each claim by reading the gate store, the git host and CI.

**Feature:** Same as D4: every claim (gate ids, PRs, ACKs, merge states) is verified against the source of truth before
Lair acts on it. A claim that fails verification becomes an `unverified report`.

**Config:** (same as D4).

**Observe → Act:** (same as D4).

**Acceptance:** (same as D4).

Related issues: #179.


---

### D6. Stale prompt files: warn when a prompt file describes an old task

**Problem:** A prompt file for agent X describes task Y, but task Y is done or reassigned. The agent starts with the
wrong context.

**Feature:** Fill warns when a per-agent prompt file's content doesn't match the agent's current task. The warning
appears in Health and in the agent's detail. Fill puts the line's task first as data when starting the agent.

**Config:** `agents.fill.prompt_file_check` (on/off).

**Observe → Act:**
- Observe: logs the mismatch; starts the agent anyway with the line's task as data.
- Act: same (the orchestrator or brief author should update the file).

**Acceptance:**
- A prompt file that names task Y while the agent's line names task Z raises a warning (fails on main: no warning).
- The agent's run receives the line's task, not the file's.

Related issues: #99.

---

### D7. Reviews by agents and merge: reviews by risk tier, reviewer calibration, and policy merge

**Problem:** High-risk PRs need careful review; low-risk ones don't. The orchestrator decides which tier each PR gets,
assigns reviewers, and merges when the policy passes.

**Feature:** Reviews by agents per tier (built); reviewer calibration to an agreed standard on RED-tier PRs (A6
ai-roles #111); an independent-reader review for the highest tier. Part of C3 (#121), applied per task.

**Config:** `review.tiers`, `review.reviewers`, `ai.roles.review_*`, `review.calibration_standard`.

**Observe → Act:**
- Observe: reviews run, verdicts are shown, merge is not executed.
- Act: merge is executed when the policy passes.

**Acceptance:** Built: see [autonomy.md §5](autonomy.md) and [ai-roles.md](ai-roles.md).

Related issues: #111 (A6).

---

### D8. Commit identity: the right author on every commit and merge

**Problem:** Commits appear authored by a machine user, a wrong email, or a name the repository doesn't allow. The
orchestrator has to fix authors before merging.

**Feature:** Mostly built. Lair sets the author identity on merges (`review.merge.identity`), checks commits against
`review.merge.allowed_emails`, and merges by squash with the configured identity (`review.merge.host_method: squash`).
The remaining pieces:
- The agents module puts `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` from
  `review.merge.identity` into every agent run's built environment.
- A Health check reads each worktree's `git config user.email` and warns when it is outside `review.merge.allowed_emails`.

**Config:** `review.merge.identity`, `review.merge.allowed_emails`, `review.merge.host_method`.

**Observe → Act:**
- Observe: logs identity mismatches; does not prevent commits.
- Act: rejects pushes with disallowed identities (through a pre-push hook or a check before merge); rewrites authors
  on squash merge.

**Acceptance:**
- An agent run receives `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` from config (fails on main: not in the built env).
- A push with an email not in `allowed_emails` is rejected (act mode) or warned (observe mode): built.
- A squash merge uses the configured author: built.
- A worktree config with a disallowed email raises a Health warning (fails on main: no warning).

Related issues: #180.

---

### D9. Self-update: update Lair itself after a reviewed merge

**Problem:** After a Lair PR merges, someone has to pull, rebuild, and restart Lair at a quiet moment. Rushed updates
lose in-flight work.

**Feature:** Uses the built restart module (#112, `src/server/restart/`). A merge to Lair's own main triggers an
update at a quiet moment. The trigger is a merge record Lair's own review executor wrote (sha, PR, policy result) or
a release tag Lair verifies against the host's release API (the release must be published, not draft or prerelease,
and the tag must match the release's tag_name). Quiet means no merge in flight, no run in `queued`/`waiting_lock`, no
gate started in the last `server.update_quiet_minutes` (default 5).

Steps:
1. Runs adopt on restart (#90).
2. Runs `server.update_cmd` from `data/server.yaml` (already built: a list of argvs, at most 20, each bounded by
   `server.update_timeout_seconds`). The `update_cmd` is responsible for keeping the previous build: typically it
   copies the current build to a versioned directory before pulling and rebuilding.
3. Restarts through `server.service_manager` (launchd/systemd, already built). The service manager's unit points at
   the new build directory; a rollback edits the unit to point at the kept previous build.
4. A health check after restart confirms the new version works (`supervisor.checks` green within
   `server.update_health_minutes`, default 5).
5. Rollback: if health fails, restart the kept build (edit the service manager's unit to point at it, then restart
   the unit—never a process found by name), then stop and raise one decision when that fails too. Store migrations
   are forward-only (rule 6): a rollback to an older build that can't read the newer schema is an unrecoverable
   failure that stops the update loop and raises a decision; the schema version is checked before the rollback
   restart.

Bounds: at most one update per day (`server.update_max_per_day`, default 1), audited. Requires `on_restart: adopt`
(D9 stops runs before updating when `on_restart: stop`, but the rollback path needs adopt to preserve them).

**Config:** `server.auto_update` (off | observe | act, default off), `server.update_cmd`, `server.update_timeout_seconds`,
`server.update_quiet_minutes`, `server.update_health_minutes`, `server.update_max_per_day`, `server.service_manager`.

**Observe → Act:**
- Observe: logs when an update is available and when quiet is reached; does not update.
- Act: updates at the next quiet moment; adopts runs; rolls back on failure.

**Acceptance:**
- A merge record from Lair's review executor triggers the quiet wait (fails on main: no trigger).
- In-flight runs are adopted after restart: built (#90).
- A failed health check rolls back to the previous build (fails on main: no rollback).
- A release tag is verified against the host's release API (fails on main: no verification).
- A rollback to a build incompatible with the store's schema raises a decision (fails on main: no check).
- At most one update per day.

Related issues: #181, #90, #112.


---

### D10. Restart adoption: find and adopt runs after a restart

**Problem:** A restart leaves orphaned runs or lock files. The orchestrator has to find which runs are still alive.

**Feature:** Built (#90). On restart, Lair finds runs that were active before the restart and adopts them (reconnects
their output, resumes their state). The config key is `agents.on_restart` (adopt | stop, default adopt).

Adoption means: take the process table now, compare each running process's start time against the claimed run's start
time (with a tolerance), and treat an uncertain reading (ps timed out, partial output) as alive/unknown and retry.
A process with the same name but a different start time is never adopted. A pid that is reused after the run ended is
marked lost, not killed. No kill by name or pattern.

**Config:** `agents.on_restart` (adopt | stop, default adopt).

**Observe → Act:**
- Observe: logs which runs would be adopted; marks reused pids lost.
- Act: adopts runs; marks reused pids lost.

**Acceptance:**
- A restart with an orphaned run adopts it if its pid and start time match: built.
- A process with the same name but another start time is not signalled: built.
- No kill; duplicates are never killed, only marked lost: built.

Related issues: #90.

---

### D11. Native capacity: fill decides capacity itself, not through a project script

**Problem:** Fill only knows one project script (`capacity_cmd`), which can't tell agents apart. Agents that only push
to GitHub CI (about 5% CPU each) are held for an hour by load from container gates on the same machine.

**Feature:** Mostly built (#100). Fill decides capacity natively:
- `fill.capacity.load_per_cpu_max`: built;
- `fill.capacity.memory.pressure_max`, `memory.available_min_pct`: built;
- `fill.capacity.heavy_work.detect` (globs), `heavy_work.max_active`: built;
- per-agent `fill.capacity.agent_class` and `fill.capacity.default_class` (`local` | `remote`): built.

`remote` agents are held only by memory and `max_active`, never by load. `capacity_cmd` stays as an optional extra
check.

**New work:** A per-task class label (configuration.md: "There is no per-task class label yet").

**Config:** `fill.capacity.*`, `fill.capacity.default_class`, `fill.capacity.agent_class`.

**Observe → Act:**
- Observe: logs capacity decisions; uses defaults.
- Act: same (native capacity has no act-specific behaviour).

**Acceptance:**
- A `remote` agent starts under high load: built.
- A `local` agent is held under high load: built.
- Memory pressure holds both: built.
- `capacity_cmd` is still honoured: built.
- A per-task class label holds heavy tasks (fails on main: no per-task class).

Related issues: #100.

> **Note:** Auto-tune (learning thresholds from contention) is a separate feature (#238) that proposes threshold
> changes through the `set_config` op in `supervisor.act`, never a direct write.

---

### D12. Placement: move queued gates to a faster machine, start cloud machines

**Problem:** Gates queue on a slow machine while a faster one is idle. The orchestrator has to move jobs by hand. A
cloud machine that could finish a job faster is not started.

**Feature:** Placement on demand (#85, #174): decides which machine runs each queued job, moves jobs when that finishes
them sooner, and starts cloud machines through the native provider (#104). See [cloud-runners.md §7](cloud-runners.md)
for routing and on-demand.

**Config:** `routing.prefer_when_faster`, `routing.overflow_to`, `routing.overflow_after`, `cloud.on_demand.*`.

**Observe → Act:**
- Observe: logs which moves would be made; does not move or start.
- Act: moves jobs; starts cloud machines.

**Acceptance:** Built: see [cloud-runners.md](cloud-runners.md).

Related issues: #85, #104, #174.

---

### D13. Host services: keep the container engine and tunnel daemons up

**Problem:** After a reboot, the container engine or a tunnel daemon is down. Gates fail with "Cannot connect to the
Docker daemon". The orchestrator has to restart services by hand.

**Feature:** Per-machine `services` with a probe and a start command. The watchdog probes every minute and, in act
mode, runs `start` with a backoff. Lanes that need a service are held while it is down. A probe that times out is
unknown, not down; `start` never runs on unknown. Restarts are capped per hour, and `start` argv comes from config
only.

**Config:** `machines.<name>.services[].name`, `services[].probe` (argv), `services[].start` (argv),
`services[].needed_by` (lanes or pipelines).

**Observe → Act:**
- Observe: logs service outages; does not start.
- Act: runs `start`; holds lanes; raises one notice per outage.

**Acceptance:**
- A probe that fails then passes after `start` is logged as recovered (fails on main: no recovery loop).
- Lanes are held then released.
- A `start` that keeps failing raises one decision (not repeated notices).
- A timed-out probe is treated as unknown, not down.

Related issues: #163.


---

### D14. Environment down: hold gates and decisions while the environment is broken

**Problem:** A network outage, a dead database, or a provider failure causes every gate to fail for the same reason.
The orchestrator has to pause gates until the environment recovers.

**Feature:** Triage environment class (#89, #171). Failures classified as `infra` or `load` do not block a PR; they are
retried on recovery. Decisions that depend on a broken service are held. The environment branch stops the gate re-check,
max_per_result and escalation, not just drops gate.text. Recovery re-checks go through the gate system, and do not
count against `max_retries`. The probe gets its timeout and runs outside the serial lock.

**Config:** `triage.environment.mode` (off | observe | act), `triage.environment.patterns`, `triage.environment.default_patterns`,
`triage.environment.probe`, `triage.environment.max_wait_minutes`.

**Observe → Act:**
- Observe: classifies failures; does not retry or hold.
- Act: retries on recovery; holds decisions.

**Acceptance:** See [autonomy.md §3](autonomy.md) and #171.

Related issues: #89, #171.

---

### D15. Owner decisions answered by evidence: the supervisor answers from events and data

**Problem:** The owner asks "why is this agent held?" or "what should I expect tonight?". The orchestrator has to
gather evidence from logs, events and metrics.

**Feature:** Supervisor S3 (#92). The supervisor reads Lair through the ops API and answers with cited evidence.

**Config:** `supervisor.*`.

**Observe → Act:**
- Observe: answers questions; does not fix.
- Act: proposes fixes.

**Acceptance:** See [supervisor.md](supervisor.md).

Related issues: #92.

---

### D16. Planner proposals: approve good proposals, reject duplicates

**Problem:** The planner proposes tasks, but some are duplicates or low priority. The orchestrator has to approve each
one.

**Feature:** The planner verifier (built) checks each proposal against reality. The planner's `mode: act` exists on
main and applies accepted proposals at once except ops with `approval: always`; observe mode makes them wait. The open
items are dedupe (#97) and the work-store write path only (#95).

**Config:** `planner.*`.

**Observe → Act:**
- Observe: shows proposals in the Planner view; does not apply.
- Act: applies approved proposals (built except ops with `approval: always`).

**Acceptance:** Built: see [planner.md](planner.md).

Related issues: #97, #95.

---

### D17. Config changes: edit project config from Settings, with policy-based changes

**Problem:** The orchestrator edits YAML by hand, copies it to the live location, and keeps backups. Mistakes break the
project.

**Feature:** Settings v2 (S2-2/S2-3) for every key, with history and restore (built: S2-1). Policy-based config changes
by the supervisor through the `set_config` op in `supervisor.act` ([supervisor.md](supervisor.md) S3): an allowlist of
keys the supervisor may change (per-key bounds: allowed keys, min/max, at most one change per key per hour), every
change saved through Settings history (restorable), audited.

**Config:** `supervisor.act` (the allowlist of acting ops, default none, rate limits and audit), `settings.history_days`.

**Observe → Act:**
- Observe: shows proposed changes; does not apply.
- Act: applies changes from the allowlist; audits every change.

**Acceptance:**
- A Settings change is saved with history: built.
- A supervisor-proposed change on the allowlist is applied (act mode); a change outside becomes a decision (fails on
  main: `set_config` op not implemented yet).

Related issues: #108, #109, #239 (set_config op).

---

### D18. Tracker: keep GitHub issues, boards and milestones true

**Problem:** Tasks exist in Lair but not on the tracker. Milestones are out of date. The orchestrator has to sync by
hand.

**Feature:** The tracker module (#164) syncs tasks to GitHub issues, boards and milestones. Each task has an issue;
each milestone has a due date from the plan.

**Config:** `tracker.*`.

**Observe → Act:**
- Observe: logs drift; does not sync.
- Act: creates and updates issues, boards, milestones.

**Acceptance:**
- A task without an issue gets one created (fails on main: no tracker module).
- A milestone's due date matches the plan.

Related issues: #164.


---

### D19. Project journal and reports: an event-sourced timeline and a daily digest

**Problem:** The owner asks "what happened last night?" and the orchestrator has to read logs and events to summarize.

**Feature:** A read model over the existing event sources (`events` store, `agents_events`, the supervisor's digest
S1-2, and the work store's append-only task timeline #172). Sources: gates, placement, triage stores for metrics.
Retention only for the digest, with `supervisor.digest.retention_days`. A daily digest (S1-2, built) extended with
this data. An on-demand "where do we stand" report (also in Ask Lair).

**Config:** `supervisor.digest.*`.

**Observe → Act:** No act mode (no destructive behaviour).

**Acceptance:**
- The journal query returns merges, holds, decisions and milestone changes from the existing stores (fails on main:
  no journal query).
- The daily digest summarizes the journal: built.
- "Where do we stand?" answers with milestone progress and blockers.

Related issues: #182.

---

### D20. Forecast and insights: estimate release dates, find bottlenecks

**Problem:** The owner asks "when will milestone X ship?" and the orchestrator estimates from throughput and pass rate.

**Feature:** Metrics from the gates, placement and triage stores: merges per day, gate pass rate per machine and track,
time in each state. Milestone burn-up with an ETA, bottleneck findings (e.g. "1 in 10 gates pass; load-related failures
40%"). Shown on Home.

**Config:** `insights.*` (thresholds for bottleneck flags).

**Observe → Act:** No act mode (no destructive behaviour).

**Acceptance:**
- A milestone with 10 tasks done and 5 remaining shows an ETA based on throughput (fails on main: no ETA).
- A bottleneck (low pass rate, high load failures) is flagged.

Related issues: #183.

---

### D21. Diagnose gate failures: decide if the cause is load, environment, or code

**Problem:** A gate fails and the orchestrator has to read logs to decide if it's load, environment or code.

**Feature:** Supervisor S1-3 diagnoses (#107) combined with D20 insights. The supervisor correlates failures with load,
recent config changes, machines and events.

**Config:** `supervisor.*`, `triage.*`.

**Observe → Act:**
- Observe: shows the diagnosis in the gate's detail.
- Act: proposes a fix (retry, requeue, pause).

**Acceptance:**
- A gate that fails with "OOM" while load is high is diagnosed as `load`.
- A gate that fails with a new test failure is diagnosed as `code`.

Related issues: #107.

---

### D22. Targeted checks before full gates: run quick checks first

**Problem:** Agents submit full gates that take 30 minutes, then fail on a lint error. The orchestrator tells them to
run targeted checks first.

**Feature:** Agent checks (#93, #176). A `checks.require_before_gate` policy requires targeted checks (lint, compile,
unit tests) to pass before a full gate is queued.

**Config:** `checks.require_before_gate`, `checks.*`.

**Observe → Act:**
- Observe: warns when a gate is submitted without passing checks.
- Act: rejects the gate until checks pass.

**Acceptance:**
- An agent that submits a gate without passing lint gets a rejection (fails on main: no rejection).
- An agent that passes checks can submit the gate.

Related issues: #93, #176.

---

### D23. Gate routing preferences: route gates to cloud first

**Problem:** The orchestrator wants gates to run on cloud machines first (faster, cheaper) and overflow to local.

**Feature:** Placement routing preferences as config ([cloud-runners.md §7](cloud-runners.md)): `routing.prefer_when_faster`
(e.g. `[cloud]`), overflow policy `routing.overflow_to`/`routing.overflow_after`.

**Config:** `routing.prefer_when_faster`, `routing.overflow_to`, `routing.overflow_after`.

**Observe → Act:**
- Observe: logs routing decisions.
- Act: routes according to preference.

**Acceptance:**
- A gate with `prefer_when_faster: [cloud]` routes to a cloud machine if available: built.
- Overflow to local happens when cloud is full: built.

Related issues: #85, #174.


---

### D24. Redact private details: scan public text before publishing

**Problem:** An agent writes a private path or name in an issue body. The orchestrator has to scan for leaks before
publishing.

**Feature:** Tracker `redact_patterns` plus the genericity guard (#102). Text destined for a public tracker is scanned
for patterns (home paths, denylist words, private emails) and redacted or rejected. Matching text is never published
in any mode: observe mode holds the publish, logs the match and raises one notice; act mode redacts and publishes, or
rejects when the denylist matches.

**Config:** `tracker.redact_patterns`, `tracker.denylist_file`, `tracker.mode` (off | observe | act, default observe).

**Observe → Act:**
- Observe: holds publishes with matches; raises a notice; does not publish.
- Act: redacts and publishes, or rejects denylist matches.

**Acceptance:**
- An issue body with `/Users/<name>/` is redacted to `<path>` (act) or held (observe) (fails on main: published).
- A denylist word is rejected with a notice.
- A publish with a matching body in observe mode leaves the issue unchanged.

Related issues: #102.

---

### D25. Answer "what is everyone working on": Ask Lair with the journal and forecast

**Problem:** The owner asks "what should I expect?" and the orchestrator has to summarize the fleet's state.

**Feature:** Ask Lair (#88, built) with the journal (D19) and the forecast (D20) as sources. The supervisor answers
with a summary of active tasks, blockers, and expected completions.

**Config:** `supervisor.*`.

**Observe → Act:** No act mode (no destructive behaviour).

**Acceptance:**
- "What is everyone working on?" lists each agent's current task and state: built.
- "What should I expect tonight?" lists expected completions and blockers.

Related issues: #88.

---

### D26. Usage limits: stay within provider limits, notice a daily cap

**Problem:** An AI provider has a daily limit. The orchestrator notices when runs fail with "rate limit" or "quota
exceeded" and pauses work.

**Feature:** AI roles failover (A6, built) tries the next profile when a provider fails (`failover.*_patterns`,
cooldowns and the fleet budget's rate-limit pause). The new part: parse the reset time from the rate-limit response,
hold the agent until then, show it in the UI.

**Config:** `ai.roles.*`, `failover.*`, `ai.limits.show_reset_time` (on/off).

**Observe → Act:**
- Observe: logs limit hits; does not hold.
- Act: holds runs; shows reset time; fails over.

**Acceptance:**
- A run that hits a rate limit fails over to the next profile: built.
- A daily cap holds runs and shows the reset time (fails on main: reset time not parsed).

Related issues: #185, A6 epic.

---

### D27. Wake on DONE/BLOCKED and act: event-driven modules

**Problem:** The orchestrator polls for DONE or BLOCKED lines. A delay means idle time.

**Feature:** Event-driven modules (the bus, #86). Every module subscribes to events and acts on them. A DONE event
triggers task closure, workstream assignment, and planner updates. The bus reads queue lines and publishes events;
fill consumes them.

**Config:** `bus.*`.

**Observe → Act:**
- Observe: logs events.
- Act: acts on events.

**Acceptance:**
- A DONE event closes the task within one tick (fails on main without #86).
- Fill receives events from the bus instead of polling.

Related issues: #86.

---

### D28. Gate infrastructure monitor: watch every running job's machine

**Problem:** An on-demand machine powered off under a running job. A tunnel daemon was dead after a reboot. The
orchestrator has to notice these failures.

**Feature:** Every minute, for every running external-gate job and pipeline job: is its machine up, reachable, and
holding the job (process group alive)? If not, raise one notice at once and, in act mode, re-queue the job once on the
next machine (placement's move). "Unreachable" is not "dead": re-queue once after a lease grace, mark the first job
lost (not killed), and never re-queue a job whose result then arrives twice. Also: a runner that is down while its
lane has queued jobs.

Duplicate runner slots (two runners claiming one slot): one notice with both runners' identities, no kill. See "Kill
and restart safety" above.

**Config:** `gates.infra_monitor` (on/off), `gates.infra_monitor_interval_seconds`.

**Observe → Act:**
- Observe: raises a notice; does not re-queue.
- Act: re-queues the job on the next machine.

**Acceptance:**
- A job whose machine stops gets one notice and is re-queued (act mode) (fails on main: no notice).
- A duplicate runner slot is noticed with both identities; no kill.
- A dead runner with queued jobs is noticed.

Related issues: #167.

---

### D29. Agent environment health: check the run's tools before it starts

**Problem:** Agents cannot use GitHub (gh "not authenticated" in their shell while it works elsewhere) and their PRs
must be opened by hand. Or a required CLI is missing or misconfigured. The orchestrator discovers this only after
the agent fails.

**Feature:** Extend the per-tool sign-in checks (ai-roles A6-1, built: `auth_check_cmd`, `login_hint`) with gh and git.
Before a run, Lair checks the run's tool environment (gh auth, git push dry-run with the run's built environment,
required CLIs) and reports the exact error. Agents report "pr-needed" instead of BLOCKED, and Lair opens the PR
through its own host client (review module) for pushed branches that exist at the host at the sha the run pushed and
match `review.authors` patterns, with a body Lair builds (agent text only inside a fenced block).

**Config:** `agents.environment_checks` (list of check ids), `agents.open_pr_on_failure` (on/off).

**Observe → Act:**
- Observe: logs environment errors; does not open PRs.
- Act: holds runs with broken environments; opens PRs for pushed branches.

**Acceptance:**
- An agent with a missing `gh` auth gets a clear error before the run starts (fails on main: discovered after failure).
- A pushed branch with "pr-needed" gets a PR opened by Lair (fails on main: no PR opened).
- A run is not started with a broken required CLI.

Related issues: #186.

---

### D30. Review-then-gate pipeline: gates run only when the PR is ready to merge

**Problem:** Gates run before reviews. A gate that passes is made obsolete by a REQUEST CHANGES review, wasting
machine time. The orchestrator cancels gates by hand.

**Feature:** In the review module, `review.merge.gate_after: review` means the merge gate (full or affected scope) is
requested only after the required approvals at the head. A new head cancels pending merge gates for the old head
(cancel only a job Lair itself queued, by its job id, in act mode, recorded with the old and new head; never a job in
the project's external gate queue). Agents use targeted checks (#93) while building. On main the merge gate is read
(host checks or signed results, `review/gate-source.ts`), not requested; the request path is the pipelines module's
run, in-process.

**Config:** `review.merge.gate_after` (push | review, default push), `review.merge.cancel_obsolete_gates` (on/off).

**Observe → Act:**
- Observe: logs when a gate would be deferred; does not cancel.
- Act: defers merge gates until review passes; cancels obsolete gates.

**Acceptance:**
- A PR with `gate_after: review` does not start a merge gate until approvals are in (fails on main: no deferral).
- A new push cancels the old head's pending merge gate.
- Targeted checks still run during development: built.

Related issues: #187.

---

## Related issues

Each section above names its related issues. The ROADMAP.md section O lists the order in which duties become features.
The GitHub issues (#177-#187 and others named above) carry the detailed acceptance criteria and link to their sections
in this document.
