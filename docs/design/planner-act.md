# Planner Act Mode: verified proposals apply without waiting

- **Status:** Draft
- **Plan lines / issues:** Owner directive 31 Oct: "how is our planner performing" → 36% of proposals applied, only 11% of tasks-file changes come from it, every proposal waits 10–50 min for an answer. GitHub issues: #166 (no agent idles while ready work exists), #97 (identical changes in consecutive runs), #119 (C1 cards epic).
- **Owner questions:**
  1. Should the planner be able to override "phase order" if an agent is idle and the only ready work is in a later phase? (Default recommendation: no, phases are sacred.)
  2. When a race is detected (task added between proposal and apply), should the planner silently drop the proposal, or record it as "superseded" with an event for the owner?
  3. For "stay ahead", is N=1 ready task per agent the right default, or should it be N=2 to absorb startup latency?

## 1. Problem

The planner reviews sources, proposes changes, a verifier checks them—and then every proposal waits for the owner. With 10–50 minutes between proposal and answer, agents sit idle: 36% of proposals are eventually applied, but most of that time is decision latency, not judgment. Of the changes made to the tasks file today, only 11% came from the planner's proposals; the rest were manual. The owner also reported that on 30 Oct two of three consecutive proposals duplicated lines added minutes earlier by another proposal, because the planner ran before the first proposal's apply completed.

This design makes verified proposals self-applying by default, adds a plan file as a ready source (the owner's schedule), keeps ready tasks queued per agent so nothing idles while work exists, and prevents race-condition duplicates by re-checking the file at apply time.

## 2. Users and stories

- **As the planner service**, I apply a verified "add" proposal immediately so the agent starts without waiting.
- **As the planner service**, I refuse to apply a proposal when the task already exists (added by another proposal or by the owner between my run and the apply).
- **As the owner**, I see "superseded" proposals in history with their reason, not silent drops.
- **As an agent**, I have a ready task waiting before I finish my current one, so I never idle while work exists.
- **As the owner**, I configure which plan file supplies ready work, and the planner respects phase order: it never proposes a later-phase task while an earlier-phase task is ready.
- **As the owner**, I mark a plan line as "owner-only" or "blocked" and the planner never proposes it.
- **As the owner**, I can switch a project to act-mode and know that only `add` and `reword` auto-apply by default; `drop`, `finish`, `reassign`, and `unblock` still wait for my approval.
- **As an agent or orchestrator**, I see tier and gate scope on every task the planner proposes, because the planner requires them.

## 3. Scope

### In

1. **Act mode auto-apply**: verifier-approved `add` and `reword` proposals apply without a decision; `reject` and `unsure` still wait.
2. **Plan file source**: a markdown plan (checkbox lines, phase headings) as a ready source the planner draws from; respects phase order and blocked/owner-only markers.
3. **Stay-ahead fill**: keep N ready tasks per agent (default 1), triggered on task completion and on cycle, not only when an agent goes idle.
4. **Race-condition guard**: re-read the tasks file immediately before applying any proposal; drop proposals whose task or agent assignment now exists; record each dropped proposal as "superseded".
5. **Tier and gate scope required**: every proposed add must include tier and gate scope in its text; proposals without them are refused by checks.
6. **Observe-first default**: new behaviour behind config switches, defaulting to observe or off; promotion to act documented.

### Out (non-goals)

- **Automatic retries of rejected proposals**: a rejected proposal needs owner attention; retries are outside this scope.
- **Full autonomy**: the planner never drops, finishes, reassigns, or unblocks without owner approval (those ops stay `approval: always`).
- **Multi-project coordination**: each project has its own planner; cross-project scheduling is future work.
- **Stacked-branch rebases or docs PRs that tick the plan**: tracked in C1 (#119).

## 4. Design

### Where it lives

- `src/server/planner/service.ts`: auto-apply logic after verification, race-condition guard at apply time, stay-ahead trigger logic.
- `src/server/planner/proposals.ts`: tier/gate-scope validation in `checkProposals`.
- `src/server/planner/config.ts`: new keys for verifier `auto_apply`, stay-ahead settings, plan-source ordering config.
- `src/server/planner/sources.ts`: plan-source readiness calculation (phase-aware), blocked/owner-only marker parsing.
- `docs/configuration.md#planner`: new keys documented.

### Data model

No new tables. Existing schema unchanged.

- **Proposal row** (`planner_proposals`): existing `status` values `pending`, `approved`, `rejected`. Add value `superseded` for proposals dropped by the race-condition guard.
- **Planner state** (in-memory and persisted per project): add `ready_by_agent: Map<string, string[]>` tracking ready task ids per agent (transient, rebuilt each cycle from sources).

### Interfaces

#### Config keys (planner block)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `verifier.auto_apply` | `PlannerOp[]` | `["add", "reword"]` | Ops where a verifier `approve` verdict auto-applies (act mode only). `drop` never allowed. |
| `verifier.auto_reject` | `PlannerOp[]` | `[]` | Ops where a verifier `reject` verdict auto-rejects (act mode only). |
| `stay_ahead.enabled` | `boolean` | `false` | Keep N ready tasks per agent, not only on idle. |
| `stay_ahead.ready_tasks` | `number` | `1` | How many ready tasks to keep per agent. Range: 1–5. |
| `stay_ahead.trigger_on_done` | `boolean` | `true` | Trigger a planner run when an agent's task is marked done and they have fewer than N ready tasks. |
| `plan_source.phase_order` | `boolean` | `true` | Respect phase order: never propose a task from phase N+1 while a ready task exists in phase N or earlier. |
| `plan_source.blocked_markers` | `string[]` | `["blocked", "hold", "owner-only", "owner only"]` | Case-insensitive markers in a plan line that make it unproposable. |
| `require_tier_and_gate` | `boolean` | `true` | Proposals for `add` must include a tier (pattern: case-insensitive `tier`, followed by one of: RED, YELLOW, GREEN, MIGRATIONS, AUTH, BILLING, PRIVACY) and a gate scope (pattern: "gate:" or "gate scope:" followed by text). |

#### Events

| Event | Payload | When |
|-------|---------|------|
| `planner.proposal_auto_applied` | `{ project, runId, proposalId, task, op }` | A verified proposal was applied without a decision. |
| `planner.proposal_superseded` | `{ project, runId, proposalId, task, reason }` | A proposal was dropped because the task/assignment already exists. |
| `planner.stay_ahead_triggered` | `{ project, agent, readyCount, target }` | Stay-ahead logic triggered a cycle because an agent has fewer than target ready tasks. |

#### Routes

No new routes. Existing `/api/planner/*` routes remain owner-only. The Planner view shows superseded proposals in history with their reason.

### Flow

#### Auto-apply after verification (act mode)

1. Verifier run completes with verdicts.
2. For each accepted proposal:
   a. If `verdict == "approve"` and `op in verifier.auto_apply` and `mode == "act"`:
      - Call `applyWithRaceGuard(proposal)` (see below).
   b. If `verdict == "reject"` and `op in verifier.auto_reject` and `mode == "act"`:
      - Mark proposal `status: rejected`, `decidedBy: "verifier"`.
   c. Else: proposal waits for owner (existing behavior).
3. Emit `planner.proposal_auto_applied` for each auto-applied proposal.

#### Race-condition guard (`applyWithRaceGuard`)

1. Re-read the tasks file (fresh read, not from cache).
2. Parse it with `parseTasksDoc`.
3. For `add`: if `findTask(doc, proposal.task)` returns a line, or `doc.done.has(proposal.task)`:
   - Mark proposal `status: superseded`, `refusal: "task {task} was added between proposal and apply"`.
   - Emit `planner.proposal_superseded`.
   - Return without applying.
4. For `reassign`: if the task's current agent matches the proposed agent:
   - Mark proposal `status: superseded`, `refusal: "task {task} is already assigned to {agent}"`.
   - Emit `planner.proposal_superseded`.
   - Return without applying.
5. Else: apply the edit atomically (existing `commit` logic).

#### Stay-ahead fill

1. On every cycle, after sources are read:
   a. For each allowlisted agent, count ready tasks (open tasks assigned to them).
   b. If `stay_ahead.enabled` and count < `stay_ahead.ready_tasks`:
      - Add trigger `stay_ahead` with `{ agent, current: count, target: ready_tasks }`.
2. On deterministic mark-done (a task marked `#done`):
   a. If `stay_ahead.trigger_on_done` and the agent's ready count drops below target:
      - Add trigger immediately (don't wait for next cycle interval).
3. Planner context includes `readyByAgent` map so the planner agent knows which agents need work.

#### Plan source readiness

1. Plan tasks are sorted by phase (phase headings parsed by `phase_pattern`).
2. A task is **proposable** if:
   - It has an id (matches `id_pattern`).
   - It is not done (`[x]` or `done_pattern`).
   - It is not already in the tasks file (by id match).
   - It does not contain any `blocked_markers` (case-insensitive substring match in the line text).
   - Its dependencies (from `depends_pattern`) are all done (in the plan or in the tasks file as done).
3. If `phase_order: true`:
   - Collect all proposable tasks.
   - Let `earliest_phase` = the lowest phase number with at least one proposable task.
   - Filter to only tasks in `earliest_phase`.
4. The planner agent's context shows proposable tasks sorted by phase, with dependencies.

#### Tier and gate scope validation

1. In `checkProposals`, when `op == "add"` and `require_tier_and_gate: true`:
   a. Check `proposal.text` for tier pattern: `/\b(tier:?\s*)?(RED|YELLOW|GREEN|MIGRATIONS|AUTH|BILLING|PRIVACY)\b/i`.
   b. Check `proposal.text` for gate pattern: `/\bgate(?:\s+scope)?:?\s+\S+/i`.
   c. If either is missing: refuse with `"add proposals must include a tier (e.g. GREEN) and gate scope (e.g. gate: backend-targeted ClassName)"`.
2. The planner agent's prompt instructs it to include tier and gate in the `text` field of add proposals.

### Security and privacy

- **No new auth surfaces**: all routes remain owner-only.
- **Tenant scoping**: per-project planner state, no cross-project access.
- **Secrets**: no secrets in proposals, tiers, or gate scopes (plain text identifiers only).
- **Logging**: events log task ids and ops, never task descriptions or plan content.
- **Injection**: proposal text is cleaned by existing `clean()` before any use; tier/gate patterns are anchored regexes, not user-provided.

### Reliability

- **Timeouts**: existing cycle and run timeouts apply; race-guard re-read uses the same `MAX_TASKS_FILE_BYTES` limit.
- **Retries**: verifier retries are existing (`verifier.attempts`); auto-apply has no separate retry (a superseded proposal stays superseded).
- **Idempotency**: the race-condition guard makes auto-apply idempotent: a restart re-reads the file and re-checks.
- **Dependency down**: if the tasks file can't be read, the cycle fails and logs the error (existing behavior); proposals wait.

### Observability

- **Events**: `planner.proposal_auto_applied`, `planner.proposal_superseded`, `planner.stay_ahead_triggered` join existing events.
- **Metrics**: count of auto-applied, superseded, and waiting proposals per project (existing metrics pattern).
- **Logs**: `[planner]` prefix, level info for auto-apply, warn for superseded, error for failures.
- **Dashboard**: Planner view shows superseded proposals with their reason; history tab shows auto-apply decisions as "verifier (auto)".

## 5. Acceptance tests

Each test name is the function name in the test file.

- **AT-1 `autoAppliedAddDoesNotWait`**: Given a verifier-approved `add` proposal in act mode with `auto_apply: ["add"]`, when `finishAfterVerification` runs, then the proposal is applied (task appears in tasks file) and `status == "approved"`, `decidedBy == "verifier"`, and event `planner.proposal_auto_applied` is emitted. The decision inbox has no item for this proposal.
- **AT-2 `autoAppliedRewordDoesNotWait`**: Given a verifier-approved `reword` proposal in act mode with `auto_apply: ["add", "reword"]`, when `finishAfterVerification` runs, then the task's description is updated and the decision inbox has no item.
- **AT-3 `rejectVerdictWaitsUnlessAutoReject`**: Given a verifier `reject` verdict on an `add` proposal, and `auto_reject: []`, when `finishAfterVerification` runs, then `status == "pending"` and the proposal waits for owner (decision inbox has an item).
- **AT-4 `rejectVerdictAutoRejectsWhenConfigured`**: Given a verifier `reject` verdict on a `reword` proposal, and `auto_reject: ["reword"]`, when `finishAfterVerification` runs, then `status == "rejected"`, `decidedBy == "verifier"`, and no decision inbox item.
- **AT-5 `unsureVerdictAlwaysWaits`**: Given a verifier `unsure` verdict on an `add` proposal with `auto_apply: ["add"]`, when `finishAfterVerification` runs, then the proposal waits for owner.
- **AT-6 `observeModeNeverAutoApplies`**: Given a verifier-approved `add` proposal in observe mode, when `finishAfterVerification` runs, then the proposal waits for owner (observe mode ignores `auto_apply`).
- **AT-7 `dropNeverAutoApplies`**: Config validation refuses `auto_apply: ["drop"]` with error "drop can never be auto-applied".
- **AT-8 `raceGuardRefusesExistingTask`**: Given an `add` proposal for task `feat-x`, and between verification and apply another process adds `feat-x` to the tasks file, when `applyWithRaceGuard` runs, then `status == "superseded"`, `refusal` contains "was added between proposal and apply", and event `planner.proposal_superseded` is emitted.
- **AT-9 `raceGuardRefusesDoneTask`**: Given an `add` proposal for task `feat-y`, and the task is already `#done` in the tasks file, when `applyWithRaceGuard` runs, then the proposal is superseded.
- **AT-10 `raceGuardAllowsFreshTask`**: Given an `add` proposal for task `feat-z` that does not exist in the tasks file, when `applyWithRaceGuard` runs, then the task is added and `status == "approved"`.
- **AT-11 `stayAheadTriggersWhenBelowTarget`**: Given `stay_ahead.enabled: true`, `ready_tasks: 2`, and agent `worker-a` has 1 ready task, when `cycle()` runs, then a trigger `stay_ahead` is added for `worker-a`.
- **AT-12 `stayAheadDoesNotTriggerWhenAtTarget`**: Given `stay_ahead.enabled: true`, `ready_tasks: 2`, and agent `worker-a` has 2 ready tasks, when `cycle()` runs, then no `stay_ahead` trigger is added.
- **AT-13 `stayAheadTriggersOnDone`**: Given `stay_ahead.enabled: true`, `ready_tasks: 2`, `trigger_on_done: true`, and agent `worker-a` has 2 ready tasks, when one task is marked done (leaving 1), then a trigger is added immediately.
- **AT-14 `planSourceRespectsPhaseOrder`**: Given plan tasks in Phase 1 (task A, ready), Phase 2 (task B, ready), and `phase_order: true`, when the planner agent's context is built, then only task A is in `proposableTasks` (task B is filtered out).
- **AT-15 `planSourceIgnoresBlockedMarkers`**: Given a plan line `- [ ] feat-blocked: text (owner-only)` with `blocked_markers: ["owner-only"]`, when sources are read, then `feat-blocked` is not in `proposableTasks`.
- **AT-16 `planSourceRespectsDependencies`**: Given plan task `feat-b` depends on `feat-a`, and `feat-a` is not done, when sources are read, then `feat-b` is not in `proposableTasks`.
- **AT-17 `tierAndGateRequiredForAdd`**: Given `require_tier_and_gate: true` and an `add` proposal with text "search page", when `checkProposals` runs, then the proposal is refused with "must include a tier ... and gate scope".
- **AT-18 `tierAndGateAcceptedWhenPresent`**: Given `require_tier_and_gate: true` and an `add` proposal with text "search page. GREEN. gate: backend-targeted SearchTest", when `checkProposals` runs, then the proposal is accepted.
- **AT-19 `tierAndGateNotRequiredWhenDisabled`**: Given `require_tier_and_gate: false` and an `add` proposal with text "search page" (no tier/gate), when `checkProposals` runs, then the proposal is accepted.
- **AT-20 `multiplePhasesInOrder`**: Given plan phases 1, 2, 3 with ready tasks in each, when building context with `phase_order: true`, then `proposableTasks` contains only phase 1 tasks; when phase 1 is exhausted (all done), then phase 2 tasks appear.

## 6. Rollout

1. **Config switches default off**: `stay_ahead.enabled: false`, `verifier.auto_apply: []`, `require_tier_and_gate: false`.
2. **Observe mode first**: deploy with mode `observe`; monitor `planner.changed` events and the Planner view for what would have auto-applied.
3. **Enable stay-ahead**: set `stay_ahead.enabled: true` in one project; watch for unexpected trigger storms; tune `ready_tasks` if needed.
4. **Enable auto-apply for add**: set `verifier.auto_apply: ["add"]` in act mode; monitor auto-applied proposals and superseded events.
5. **Enable tier/gate requirement**: set `require_tier_and_gate: true`; update planner agent prompt to include tier and gate in proposals; monitor refusals.
6. **Full act mode**: set `verifier.auto_apply: ["add", "reword"]` once stable.
7. **Rollback**: set `auto_apply: []` to return to decision-based flow; set `stay_ahead.enabled: false` to disable proactive filling.

## 7. PR split

1. **PR 1: Race-condition guard** (~200 lines): `applyWithRaceGuard` in service.ts, `superseded` status, event, tests AT-8, AT-9, AT-10.
2. **PR 2: Auto-apply after verification** (~300 lines): config keys `auto_apply`, `auto_reject`; logic in `finishAfterVerification`; tests AT-1 through AT-7.
3. **PR 3: Stay-ahead fill** (~250 lines): config keys, trigger logic in `collect` and `deterministic`, event, tests AT-11 through AT-13.
4. **PR 4: Plan source phase order and markers** (~200 lines): `phase_order`, `blocked_markers` config; readiness calculation in sources.ts; tests AT-14 through AT-16, AT-20.
5. **PR 5: Tier and gate scope validation** (~150 lines): `require_tier_and_gate` config; validation in proposals.ts; tests AT-17 through AT-19.

Each PR is independently mergeable and wired (config parsed, defaults safe, tests pass).

## 8. Open risks

- **Trigger storms**: stay-ahead with a tight target and many agents could trigger many planner runs. Mitigation: the existing `max_runs_per_day` cap applies; monitor `planner.stay_ahead_triggered` count.
- **Superseded cascades**: if many proposals race, all but one are superseded. Mitigation: record each with its reason; the owner sees patterns in history; consider debouncing applies.
- **Agent misbehavior**: an agent that rapidly marks tasks done could exhaust planner runs. Mitigation: existing daily cap; blocked classification routes egregious patterns to owner decisions.
- **Phase-order inflexibility**: strict phase order may leave agents idle if the owner hasn't ticked earlier phases. Mitigation: owner question #1; provide override config or owner message to unlock a phase.
