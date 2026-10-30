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

## Duties

### D1. Never idle: no agent idles while ready work exists

**Problem:** The owner found idle agents three times in one night, each time before the orchestrator noticed. Causes
include a second launcher holding at a different load limit, caps below the number of agents, and agents waiting on
their own gate with nothing else to do.

**Feature:** Fill and the planner ensure every agent is busy when ready work exists.
- A Health check and notice: "agent X idle for N min while ready work exists". Ready work comes from the tasks file,
  the backlog, or tracker issues labelled ready.
- **Act mode:** the agent takes the next ready task, highest priority first. The task is matched to the agent's past
  workstream or area when possible.
- **Side tasks while waiting:** an agent whose task is waiting on a gate may run ONE side task from `fill.side_queue`
  (reviews, revert checks, docs), bounded to finish before its gate usually ends (learned durations). The main task
  resumes first when its gate lands.
- A capacity explanation per idle agent: `max_active`, capacity, holds, launcher. One idle agent must never go
  unexplained.

**Config:** `fill.idle_notice_minutes`, `fill.side_queue`, `fill.priority_order`.

**Observe → Act:**
- Observe: raises the notice; logs the ready work and the reason each agent is held.
- Act: assigns the next ready task within one tick; starts side tasks for waiting agents.

**Acceptance:**
- An idle agent with ready work gets a task within one tick.
- A waiting agent takes a side task and resumes its main task first.
- The notice is raised once per incident.

Related issues: #94 (planner), #95 (work store).


---

### D2. Brief author: draft task briefs from the issue and code

**Problem:** Writing a good brief (what, why, scope, read-first files, tests, rules) takes the orchestrator 10–20
minutes per task. Without it, agents produce drift, wrong approaches, or incomplete work.

**Feature:** An author agent drafts the brief from the issue, the design doc and a code map; a reviewer agent critiques
it before assignment (C3 documents-first applied per task). The brief goes to the owner only if the reviewer rejects it
twice.

**Config:** `briefs.author_role`, `briefs.reviewer_role`, `briefs.template_file`, `briefs.auto_assign` (on/off).

**Observe → Act:**
- Observe: generates the brief and shows it in the task's detail; does not assign.
- Act: assigns the task once the brief passes review.

**Acceptance:**
- A task with an issue and a design doc gets a brief that names the read-first files, the tests, and the scope.
- A brief that misses scope or tests is rejected by the reviewer and rewritten.
- A task is never assigned with an empty or rejected brief.

---

### D3. Workstream continuation: the same agent takes the next PR of its workstream

**Problem:** When an agent finishes PR 1 of a chain, a different agent picks up PR 2. Context is lost, and the new
agent spends time rediscovering what the first already knew.

**Feature:** Fill tracks workstreams (a set of tasks that share a branch prefix, a design doc, or an explicit label).
When an agent finishes a task, fill offers it the next task in the same workstream before any other, if one exists.

**Config:** `fill.workstream_affinity` (on/off), `fill.workstream_labels`.

**Observe → Act:**
- Observe: logs which agent would get the next workstream task; does not assign.
- Act: assigns the next workstream task to the finishing agent.

**Acceptance:**
- An agent that finishes task A in workstream W is offered task B in W before any other agent.
- If the agent is unavailable, another agent gets B.

---

### D4. Report verification: a DONE closes a task only when its evidence checks out

**Problem:** An agent reports DONE with a gate id that doesn't exist, a PR that is not at the claimed head, or a task
name that doesn't match its open task. The orchestrator has to audit every claim.

**Feature:** A DONE closes a task only when its evidence checks out:
- The PR exists at that head.
- The CI or gate result matches (pass, at that head).
- The line names the task.

Otherwise, Lair marks it as an `unverified report` with the task kept open, and raises a notice.

**Config:** `reports.verify` (on/off), `reports.unverified_notice` (on/off).

**Observe → Act:**
- Observe: logs unverified reports; does not close the task.
- Act: same (a verified report is required to close).

**Acceptance:**
- A DONE with a wrong gate id is not closed; a notice is raised.
- A DONE at the correct head with a passing gate closes the task.

Related issues: #91 (stale prompt files).

---

### D5. Audit claims: verify claims against the gate store, the git host and CI

**Problem:** Agents claim "already merged", "gate passed", or "ACK" without evidence. The orchestrator has to verify
each claim by reading the gate store, the git host and CI.

**Feature:** Same as D4. Every claim (gate ids, PRs, ACKs, merge states) is verified against the source of truth before
Lair acts on it. A claim that fails verification becomes an `unverified report`.

**Config:** (same as D4).

**Observe → Act:** (same as D4).

**Acceptance:**
- A claim "gate 123 passed" with gate 123 in state failed is flagged as unverified.
- A claim "PR merged" with the PR open is flagged.


---

### D6. Stale prompt files: warn when a prompt file describes an old task

**Problem:** A prompt file for agent X describes task Y, but task Y is done or reassigned. The agent starts with the
wrong context.

**Feature:** Fill warns when a per-agent prompt file's content doesn't match the agent's current task. The warning
appears in Health and in the agent's detail. Fill puts the line's task first as data when starting the agent.

**Config:** `fill.prompt_file_check` (on/off).

**Observe → Act:**
- Observe: logs the mismatch; starts the agent anyway with the line's task as data.
- Act: same (the orchestrator or brief author should update the file).

**Acceptance:**
- A prompt file that names task Y while the agent's line names task Z raises a warning.
- The agent's run receives the line's task, not the file's.

Related issues: #99.

---

### D7. Reviews by agents and merge: reviews by risk tier, reviewer calibration, and policy merge

**Problem:** High-risk PRs need careful review; low-risk ones don't. The orchestrator decides which tier each PR gets,
assigns reviewers, and merges when the policy passes.

**Feature:** Reviews by agents per tier (built); reviewer calibration to an agreed standard on RED-tier PRs (A6
ai-roles); an independent-reader review for the highest tier.

**Config:** `reviews.tiers`, `reviews.slots`, `ai.roles.review_*`, `reviews.calibration_standard`.

**Observe → Act:**
- Observe: reviews run, verdicts are shown, merge is not executed.
- Act: merge is executed when the policy passes.

**Acceptance:** See [autonomy.md §5](autonomy.md) and [ai-roles.md](ai-roles.md).

Related issues: A6 epic.

---

### D8. Commit identity: the right author on every commit and merge

**Problem:** Commits appear authored by a machine user, a wrong email, or a name the repository doesn't allow. The
orchestrator has to fix authors before merging.

**Feature:** Lair sets the author identity for every agent run (via environment variables), checks pushes and merges
against `commits.allowed_emails`, merges by squash with a configured identity, and shows a Health warning when a
repo's git config identity is not allowed.

**Config:** `commits.author_name`, `commits.author_email`, `commits.allowed_emails`, `merge.squash_author`.

**Observe → Act:**
- Observe: logs identity mismatches; does not prevent commits.
- Act: rejects pushes with disallowed identities (through a pre-push hook or a check before merge); rewrites authors
  on squash merge.

**Acceptance:**
- An agent run receives `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` from config.
- A push with an email not in `allowed_emails` is rejected (act mode) or warned (observe mode).
- A squash merge uses the configured author.

---

### D9. Self-update: update Lair itself after a reviewed merge

**Problem:** After a Lair PR merges, someone has to pull, rebuild, and restart Lair at a quiet moment. Rushed updates
lose in-flight work.

**Feature:** After a reviewed merge to Lair's own main branch, Lair updates at a quiet moment (no merge in flight, few
runs starting). Runs are adopted on restart (#90). A health check after restart confirms the new version works.
Automatic rollback if the health check fails.

**Config:** `lair.self_update` (on/off), `lair.update_quiet_window`, `lair.rollback_on_failure` (on/off).

**Observe → Act:**
- Observe: logs when an update is available; does not update.
- Act: updates at the next quiet moment; adopts runs; rolls back on failure.

**Acceptance:**
- A merge to Lair main triggers an update at the next quiet moment.
- In-flight runs are adopted after restart.
- A failed health check rolls back to the previous version.

Related issues: #90 (restart adoption).


---

### D10. Restart adoption: find and adopt runs after a restart

**Problem:** A restart leaves duplicate agent runs or orphaned lock files. The orchestrator has to find and kill
duplicates.

**Feature:** #90. On restart, Lair finds runs that were active before the restart, adopts them (reconnects their
output, resumes their state), and kills duplicates.

**Config:** `agents.adopt_on_restart` (on/off).

**Observe → Act:**
- Observe: logs which runs would be adopted; does not kill duplicates.
- Act: adopts runs; kills duplicates.

**Acceptance:**
- A restart with two runs of the same agent kills one and adopts the other.
- No orphaned lock files remain.

Related issues: #90.

---

### D11. Native capacity: fill decides capacity itself, not through a project script

**Problem:** Fill only knows one project script (`capacity_cmd`), which can't tell agents apart. Agents that only push
to GitHub CI (about 5% CPU each) are held for an hour by load from container gates on the same machine.

**Feature:** Fill decides capacity natively, with per-agent or per-task classes:
- `agents.fill.capacity.load_per_cpu_max`;
- `agents.fill.capacity.memory.pressure_max`, `memory.available_min_pct`;
- `agents.fill.capacity.heavy_work.detect` (globs or commands), `heavy_work.max_active`;
- per-agent or per-task `class: local | remote` (default `local`).

`remote` agents are held only by memory and `max_active`, never by load. `capacity_cmd` stays as an optional extra
check.

**Auto-tune:** Lair learns from contention (gate failure rate vs load) and adjusts thresholds.

**Config:** `agents.fill.capacity.*`, `agents.defaults.class`, `tasks.class_labels`.

**Observe → Act:**
- Observe: logs capacity decisions; uses defaults.
- Act: applies learned thresholds.

**Acceptance:**
- A `remote` agent starts under high load.
- A `local` agent is held.
- Memory pressure holds both.
- `capacity_cmd` is still honoured.
- The defaults equal today's behaviour.

Related issues: #100.

---

### D12. Placement: move queued gates to a faster machine, start cloud machines

**Problem:** Gates queue on a slow machine while a faster one is idle. The orchestrator has to move jobs by hand. A
cloud machine that could finish a job faster is not started.

**Feature:** Placement on demand (#85): decides which machine runs each queued job, moves jobs when that finishes them
sooner, and starts cloud machines through the native provider (#104).

**Config:** `placement.*`, `cloud.providers.*`.

**Observe → Act:**
- Observe: logs which moves would be made; does not move or start.
- Act: moves jobs; starts cloud machines.

**Acceptance:** See [cloud-runners.md](cloud-runners.md).

Related issues: #85, #104.

---

### D13. Host services: keep the container engine and tunnel daemons up

**Problem:** After a reboot, the container engine or a tunnel daemon is down. Gates fail with "Cannot connect to the
Docker daemon". The orchestrator has to restart services by hand.

**Feature:** Per-machine `services` with a probe and a start command. The watchdog probes every minute and, in act
mode, runs `start` with a backoff. Lanes that need a service are held while it is down.

**Config:** `machines.<name>.services[].name`, `services[].probe` (argv), `services[].start` (argv),
`services[].needed_by` (lanes or pipelines).

**Observe → Act:**
- Observe: logs service outages; does not start.
- Act: runs `start`; holds lanes; raises one notice per outage.

**Acceptance:**
- A probe that fails then passes after `start` is logged as recovered.
- Lanes are held then released.
- A `start` that keeps failing raises one decision (not repeated notices).


---

### D14. Environment down: hold gates and decisions while the environment is broken

**Problem:** A network outage, a dead database, or a provider failure causes every gate to fail for the same reason.
The orchestrator has to pause gates until the environment recovers.

**Feature:** Triage environment class (#89). Failures classified as `infra` or `load` do not block a PR; they are
retried on recovery. Decisions that depend on a broken service are held.

**Config:** `triage.environment_checks`, `triage.infra_patterns`.

**Observe → Act:**
- Observe: classifies failures; does not retry or hold.
- Act: retries on recovery; holds decisions.

**Acceptance:** See [autonomy.md §3](autonomy.md).

Related issues: #89.

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

**Feature:** The planner verifier (built) checks each proposal against reality. Act mode after the work store (#95)
applies approved proposals. Dedupe (#97) rejects tasks that already exist.

**Config:** `planner.*`.

**Observe → Act:**
- Observe: shows proposals in the Planner view; does not apply.
- Act: applies approved proposals.

**Acceptance:** See [planner.md](planner.md).

Related issues: #97, #95.

---

### D17. Config changes: edit project config from Settings, with policy-based changes

**Problem:** The orchestrator edits YAML by hand, copies it to the live location, and keeps backups. Mistakes break the
project.

**Feature:** Settings v2 (S2-2/S2-3) for every key, with history and restore (built). Policy-based config changes by
the supervisor: an allowlist of keys the supervisor may change (bounded values, audited).

**Config:** `supervisor.config_allowlist`, `settings.history_days`.

**Observe → Act:**
- Observe: shows proposed changes; does not apply.
- Act: applies changes from the allowlist; audits every change.

**Acceptance:**
- A Settings change is saved with history.
- A supervisor-proposed change on the allowlist is applied (act mode).
- A change outside the allowlist becomes a decision.

Related issues: #108, #109.

---

### D18. Tracker: keep GitHub issues, boards and milestones true

**Problem:** Tasks exist in Lair but not on the tracker. Milestones are out of date. The orchestrator has to sync by
hand.

**Feature:** The tracker module syncs tasks to GitHub issues, boards and milestones. Each task has an issue; each
milestone has a due date from the plan.

**Config:** `tracker.*`.

**Observe → Act:**
- Observe: logs drift; does not sync.
- Act: creates and updates issues, boards, milestones.

**Acceptance:** See the tracker module spec.


---

### D19. Project journal and reports: an event-sourced timeline and a daily digest

**Problem:** The owner asks "what happened last night?" and the orchestrator has to read logs and events to summarize.

**Feature:** An event-sourced timeline with merges, holds, decisions and milestone progress. A daily digest (S1-2)
extended with this data. An on-demand "where do we stand" report (also in Ask Lair).

**Config:** `journal.retention_days`, `supervisor.digest`.

**Observe → Act:**
- Observe: builds the journal; shows the digest.
- Act: same.

**Acceptance:**
- The journal contains every merge, hold, decision and milestone change.
- The daily digest summarizes the journal.
- "Where do we stand?" answers with milestone progress and blockers.

---

### D20. Forecast and insights: estimate release dates, find bottlenecks

**Problem:** The owner asks "when will milestone X ship?" and the orchestrator estimates from throughput and pass rate.

**Feature:** Merges per day, gate pass rate per machine and track, time in each state, milestone burn-up with an ETA,
bottleneck findings (e.g. "1 in 10 gates pass; load-related failures 40%").

**Config:** `insights.*`.

**Observe → Act:**
- Observe: shows insights on Home.
- Act: same.

**Acceptance:**
- A milestone with 10 tasks done and 5 remaining shows an ETA based on throughput.
- A bottleneck (low pass rate, high load failures) is flagged.

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

**Feature:** Agent checks (#93). A `checks.require_before_gate` policy requires targeted checks (lint, compile, unit
tests) to pass before a full gate is queued.

**Config:** `checks.*`, `gates.require_checks`.

**Observe → Act:**
- Observe: warns when a gate is submitted without passing checks.
- Act: rejects the gate until checks pass.

**Acceptance:**
- An agent that submits a gate without passing lint gets a rejection.
- An agent that passes checks can submit the gate.

Related issues: #93.

---

### D23. Gate routing preferences: route gates to cloud first

**Problem:** The orchestrator wants gates to run on cloud machines first (faster, cheaper) and overflow to local.

**Feature:** Placement routing preferences as config: `placement.prefer` (e.g. `[cloud, local]`), overflow policy.

**Config:** `placement.prefer`, `placement.overflow`.

**Observe → Act:**
- Observe: logs routing decisions.
- Act: routes according to preference.

**Acceptance:**
- A gate with `prefer: [cloud]` routes to a cloud machine if available.
- Overflow to local happens when cloud is full.

Related issues: #85.


---

### D24. Redact private details: scan public text before publishing

**Problem:** An agent writes a private path or name in an issue body. The orchestrator has to scan for leaks before
publishing.

**Feature:** Tracker `redact_patterns` plus the genericity guard (#102). Text destined for a public tracker is scanned
for patterns (home paths, denylist words, private emails) and redacted or rejected.

**Config:** `tracker.redact_patterns`, `tracker.denylist_file`.

**Observe → Act:**
- Observe: logs matches; does not redact.
- Act: redacts or rejects text with private details.

**Acceptance:**
- An issue body with `/Users/dev/` is redacted to `<path>`.
- A denylist word is rejected with a notice.

Related issues: #102.

---

### D25. Answer "what is everyone working on": Ask Lair with the journal and forecast

**Problem:** The owner asks "what should I expect?" and the orchestrator has to summarize the fleet's state.

**Feature:** Ask Lair (#88) with the journal (D19) and the forecast (D20) as sources. The supervisor answers with a
summary of active tasks, blockers, and expected completions.

**Config:** `supervisor.*`.

**Observe → Act:**
- Observe: answers the question.
- Act: same.

**Acceptance:**
- "What is everyone working on?" lists each agent's current task and state.
- "What should I expect tonight?" lists expected completions and blockers.

Related issues: #88.

---

### D26. Usage limits: stay within provider limits, notice a daily cap

**Problem:** An AI provider has a daily limit. The orchestrator notices when runs fail with "rate limit" or "quota
exceeded" and pauses work.

**Feature:** AI roles failover (A6) tries the next profile when a provider fails. A usage limit detector holds runs and
shows the reset time when a limit is hit.

**Config:** `ai.roles.*`, `ai.limits.*`.

**Observe → Act:**
- Observe: logs limit hits; does not hold.
- Act: holds runs; shows reset time; fails over.

**Acceptance:**
- A run that hits a rate limit fails over to the next profile.
- A daily cap holds runs and shows the reset time.

Related issues: A6 epic.

---

### D27. Wake on DONE/BLOCKED and act: event-driven modules

**Problem:** The orchestrator polls for DONE or BLOCKED lines. A delay means idle time.

**Feature:** Event-driven modules (the bus, #86). Every module subscribes to events and acts on them. A DONE event
triggers task closure, workstream assignment, and planner updates.

**Config:** `bus.*`.

**Observe → Act:**
- Observe: logs events.
- Act: acts on events.

**Acceptance:**
- A DONE event closes the task within one tick.
- No polling loop for queue lines.

Related issues: #86.

---

### D28. Gate infrastructure monitor: watch every running job's machine

**Problem:** An on-demand machine powered off under a running job, and nobody noticed for 12 minutes. A tunnel daemon
was dead after a reboot, and every cloud start failed for 3 hours.

**Feature:** Every minute, for every running external-gate job and pipeline job: is its machine up, reachable, and
holding the job (process group alive)? If not, raise one notice at once and, in act mode, re-queue the job once on the
next machine (placement's move). Also a duplicate runner slot (two runners claiming one slot), and a runner that is
down while its lane has queued jobs.

**Config:** `gates.infra_monitor` (on/off), `gates.infra_monitor_interval`.

**Observe → Act:**
- Observe: raises a notice; does not re-queue.
- Act: re-queues the job on the next machine.

**Acceptance:**
- A job whose machine stops gets one notice and is re-queued (act mode).
- A duplicate runner slot is detected and one is killed.
- A dead runner with queued jobs is noticed.

Related issues: #85, #167.

---

### D29. Agent environment health: check the run's tools before it starts

**Problem:** Agents cannot use GitHub (gh "not authenticated" in their shell while it works elsewhere) and their PRs
must be opened by hand. Or a required CLI is missing or misconfigured. The orchestrator discovers this only after
the agent fails.

**Feature:** Before a run, Lair checks the run's tool environment (gh auth, git push dry-run, required CLIs) and
reports the exact error. Agents report "pr-needed" instead of BLOCKED, and Lair opens the PR through its own host
client (review module) for pushed branches.

**Config:** `agents.environment_checks`, `agents.open_pr_on_failure` (on/off).

**Observe → Act:**
- Observe: logs environment errors; does not open PRs.
- Act: holds runs with broken environments; opens PRs for pushed branches.

**Acceptance:**
- An agent with a missing `gh` auth gets a clear error before the run starts.
- A pushed branch with "pr-needed" gets a PR opened by Lair.
- A run is not started with a broken required CLI.

---

### D30. Review-then-gate pipeline: gates run only when the PR is ready to merge

**Problem:** Gates run before reviews. A gate that passes is made obsolete by a REQUEST CHANGES review, wasting
machine time. The orchestrator cancels gates by hand.

**Feature:** In the review module, `merge.gate_after: review` means the merge gate (full or affected scope) is
requested only after the required approvals at the head. A new head cancels pending merge gates for the old head.
Agents use targeted checks (#93) while building.

**Config:** `merge.gate_after` (push | review), `merge.cancel_obsolete_gates` (on/off).

**Observe → Act:**
- Observe: logs when a gate would be deferred; does not cancel.
- Act: defers merge gates until review passes; cancels obsolete gates.

**Acceptance:**
- A PR with `gate_after: review` does not start a merge gate until approvals are in.
- A new push cancels the old head's pending merge gate.
- Targeted checks still run during development.

---

## Roadmap: O. Lair is the orchestrator

This section lists the order in which orchestration duties become features. Add it to [ROADMAP.md](ROADMAP.md) as
section O, after the "C. The whole lifecycle" section.

### Phase 1: Correctness (prevents wrong outcomes)

| Duty | Feature | Issue |
|---|---|---|
| D10 | Restart adoption | #90 |
| D4, D5 | Report verification: a DONE closes only with evidence | #179 |
| D6 | Fill warns on stale prompt files | #99 |

### Phase 2: Keep the fleet busy and honest

| Duty | Feature | Issue |
|---|---|---|
| D1, D3 | Never idle, workstream continuation | #166, #178 |
| D13 | Host services health | #163 |
| D11 | Native capacity and auto-tune | #100 |
| D9 | Self-update policy | #181 |
| D29 | Agent environment health | #186 |

### Phase 3: Visibility

| Duty | Feature | Issue |
|---|---|---|
| D19 | Project journal and reports | #182 |
| D20 | Forecast and insights | #183 |
| D18 | Tracker module | #164 |

### Phase 4: The rest

| Duty | Feature | Issue |
|---|---|---|
| D2 | Brief author role | #177 |
| D8 | Commit identity policy | #180 |
| D17 | Policy-based config changes | #108, #109 |
| D26 | Usage limit detector | #185 |
| D28 | Gate infrastructure monitor | #167 |
| D30 | Review-then-gate pipeline | #187 |

---

## Issues to create

The following duties are NEW and have GitHub issues (milestone "A: Unattended operation"):

| Duty | Issue |
|---|---|
| D2 | #177 Brief author |
| D3 | #178 Workstream continuation |
| D4, D5 | #179 Report verification |
| D8 | #180 Commit identity policy |
| D9 | #181 Self-update policy |
| D19 | #182 Project journal and reports |
| D20 | #183 Forecast and insights |
| D26 | #185 Usage limit detector |
| D29 | #186 Agent environment health |
| D30 | #187 Review-then-gate pipeline |
