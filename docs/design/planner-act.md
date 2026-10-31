# Planner Act Mode: verified proposals apply without waiting

- **Status:** Draft
- **Plan lines / issues:** Owner directive 31 Oct: "how is our planner performing" → 36% of proposals applied, only 11% of tasks-file changes come from it, every proposal waits 10–50 min for an answer. GitHub issues: #166 (no agent idles while ready work exists), #97 (identical changes in consecutive runs), #119 (C1 cards epic).
- **Owner questions:**
  1. ~~Should the planner be able to override "phase order" if an agent is idle and the only ready work is in a later phase?~~ **Closed:** No, phases are sacred; blocked or owner-only lines in earlier phases do not unblock later phases.
  2. ~~When a race is detected (task added between proposal and apply), should the planner silently drop the proposal, or record it as "superseded" with an event for the owner?~~ **Closed:** Record as `superseded` with the reason (the race guard already uses `rejected` with "no longer valid"; adding `superseded` distinguishes owner rejection from race-guard rejection).
  3. ~~For "stay ahead", is N=1 ready task per agent the right default, or should it be N=2 to absorb startup latency?~~ **Closed:** N=1 by default; the fingerprint-based dedupe prevents trigger storms. Range 1–5.

## 1. Problem

Who has the problem, what happens today, why it matters now.

The planner reviews sources, proposes changes, a verifier checks them—and then every proposal waits for the owner. With 10–50 minutes between proposal and answer, agents sit idle: 36% of proposals are eventually applied, but most of that time is decision latency, not judgment. Of the changes made to the tasks file today, only 11% came from the planner's proposals; the rest were manual. The owner also reported that on 30 Oct two of three consecutive proposals duplicated lines added minutes earlier by another proposal, because the planner ran before the first proposal's apply completed.

This design makes verified proposals self-applying in act mode (off by default), adds a plan file as a ready source (the owner's schedule), keeps ready tasks queued per agent so nothing idles while work exists, and prevents race-condition duplicates by adding a `superseded` status for proposals refused by the existing race guard.

## 2. Users and stories

- **As the planner service**, I apply a verified `add` proposal immediately so the agent starts without waiting.
- **As the planner service**, I refuse to apply a proposal when the task already exists (added by another proposal or by the owner between my run and the apply), and I record it as `superseded` with its reason.
- **As the owner**, I see `superseded` proposals in history with their reason, separate from `rejected` proposals.
- **As an agent**, I have a ready task waiting before I finish my current one, so I never idle while work exists.
- **As the owner**, I configure which plan file supplies ready work, and the planner respects phase order: it never proposes a later-phase task while an OPEN task exists in an earlier phase (OPEN = not done, in the plan or the tasks file, regardless of blocked/owner-only markers).
- **As the owner**, I mark a plan line as "owner-only" or "blocked" (whole-word match, after the id) and the planner never proposes it.
- **As the owner**, I switch a project to act mode and know that only ops I list in `verifier.auto_apply` (default `[]`) apply automatically; `drop` is never allowed in auto_apply; `finish`, `reassign`, `unblock` still wait unless I add them.
- **As an agent or orchestrator**, I see tier and gate scope on every task the planner proposes, because the planner requires them (when `require_tier_and_gate: true`; default `false`).
- **As the owner**, I can undo an auto-applied change (restore the prior line), and I see the evidence that led to each auto-apply (the verifier verdict, reason, run id, before/after line).

## 3. Scope

### In

1. **Superseded status**: a new `ProposalStatus` value `superseded` for proposals refused by the race guard (distinct from `rejected`, which the owner or verifier chooses); schema migration for the new value; events and view.
2. **Evidence and undo on changes**: the existing `planner_changes.diff` already stores before/after; add `verifier_verdict`, `verifier_reason`, `verifier_evidence` (from the proposal) and an undo operation that restores the prior line (refuses if the line changed since).
3. **Observe mode record**: in observe mode, record `would_auto_apply: true` on proposals that would auto-apply, and emit event `planner.would_auto_apply` so the owner can compare before promoting to act.
4. **Plan file source refinements**: line identity for id-less lines (slug of line text); file-order within a phase; phase order blocks on OPEN tasks (not only proposable); whole-word match for blocked markers; explicit ticked-line test.
5. **Stay-ahead fill with fingerprint**: fingerprint-based dedupe prevents repeated triggers; cooldown or fingerprint unchanged = no new trigger; `max_runs_per_day` cap.
6. **Tier and gate scope validation**: explicit marker required (`tier: GREEN`, `gate: <scope>`), case-insensitive tier keyword, default `require_tier_and_gate: false`.
7. **Line-length handling**: the composed line (`agent|task|text`) is checked against `MAX_TASK_LINE_CHARS` (2000) in `checkProposals`; over it, refuse; long briefs go to a brief file under `brief_dir` (config), path in the line, text in the file.

### Out (non-goals)

- **Automatic retries of rejected proposals**: a rejected proposal needs owner attention; retries are outside this scope.
- **Full autonomy**: the planner never drops without owner approval (`drop` can never be in `auto_apply`).
- **Multi-project coordination**: each project has its own planner; cross-project scheduling is future work.
- **Stacked-branch rebases or docs PRs that tick the plan**: tracked in C1 (#119).

## 4. Design

### What already exists (delta from main)

Main already has:
- `verifier.auto_apply` (default `[]`) and `auto_reject` (default `[]`) config keys.
- `finishAfterVerification` (~service.ts:1274) with auto-apply logic: `approval[op] === "never"` AND `autoApply.includes(op)` AND `verdict === "approve"` → apply via `this.apply()`.
- `apply()` (~service.ts:1482) which re-reads the tasks file and re-runs `checkProposals` against it right before the write; a proposal whose task now exists gets `status: "rejected"` with `refusal: "no longer valid: <reason>"`.
- `markdown_plan` source with `phase_pattern`, `depends_pattern`, `id_pattern`.
- `ProposalStatus = "pending" | "applied" | "rejected" | "declined"` (where `declined` = verifier/auto rejection, `rejected` = no longer valid or owner rejection).
- `store.addChange` with `diff` (before/after lines) and `reason`.
- `approval.add` and `approval.reword` default to `never` on main (ops without explicit approval config go through verifier if present, else wait).

**This spec adds:**
- `superseded` status (race-guard refusal separate from owner/verifier rejection).
- Evidence fields on `planner_changes` (`verifier_verdict`, `verifier_reason`, `verifier_evidence`, `undone_by`).
- An undo operation and route (`POST /api/planner/{project}/changes/{id}/undo`).
- `would_auto_apply` field on proposals and event `planner.would_auto_apply` for observe mode.
- Plan-source refinements: id-less line slug, file order, phase blocks on OPEN tasks, whole-word blocked markers.
- Stay-ahead with fingerprint dedupe.
- Tier/gate explicit marker validation with `require_tier_and_gate: false` default.
- Line-length check in `checkProposals` and brief-file overflow.

### Where it lives

- `src/server/planner/service.ts`: superseded status in apply, evidence on auto-apply, undo logic, would_auto_apply observe record, stay-ahead fingerprint.
- `src/server/planner/proposals.ts`: tier/gate explicit marker validation, line-length check, brief-file overflow.
- `src/server/planner/config.ts`: new keys (`stay_ahead.*`, `require_tier_and_gate`, `brief_dir`); updated defaults documented.
- `src/server/planner/sources.ts`: plan-source refinements (id-less slug, file order, phase blocks on OPEN).
- `src/server/planner/store.ts`: schema migration for `superseded`, evidence fields on changes.
- `src/server/planner/routes.ts`: undo route.
- `src/shared/planner-types.ts`: `ProposalStatus` adds `superseded`.
- `docs/configuration.md#planner`: new keys documented.

### Data model

**Schema migration (new, after the latest existing version):**

```sql
-- Add superseded status (the CHECK constraint on status must be updated)
ALTER TABLE planner_proposals
  DROP CONSTRAINT IF EXISTS planner_proposals_status_check;
ALTER TABLE planner_proposals
  ADD CONSTRAINT planner_proposals_status_check
  CHECK (status IN ('pending', 'applied', 'rejected', 'declined', 'superseded'));

-- Add evidence fields to changes for undo
ALTER TABLE planner_changes ADD COLUMN verifier_verdict TEXT;
ALTER TABLE planner_changes ADD COLUMN verifier_reason TEXT;
ALTER TABLE planner_changes ADD COLUMN verifier_evidence TEXT;
ALTER TABLE planner_changes ADD COLUMN undone_by TEXT;  -- change id of the undo
ALTER TABLE planner_changes ADD COLUMN undone_at INTEGER;

-- Index for undo lookups
CREATE INDEX IF NOT EXISTS idx_planner_changes_undone ON planner_changes(project, undone_by) WHERE undone_by IS NOT NULL;
```

Rollback: drop the new columns and restore the old CHECK constraint.

**Proposal row changes:**
- `status` adds value `superseded` for proposals refused by the race guard.
- `would_auto_apply` field (boolean, nullable, set in observe mode when the proposal would auto-apply if mode were act).

**Change row changes:**
- `verifier_verdict`, `verifier_reason`, `verifier_evidence`: copied from the proposal at apply time.
- `undone_by`, `undone_at`: set when the change is undone.

### Interfaces

#### Config keys (planner block)

All existing keys unchanged. New keys:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `stay_ahead.enabled` | `boolean` | `false` | Keep N ready tasks per agent, not only on idle. |
| `stay_ahead.ready_tasks` | `number` | `1` | How many ready tasks to keep per agent. Range: 1–5. |
| `stay_ahead.trigger_on_done` | `boolean` | `true` | Trigger a planner run when an agent's task is marked done and they have fewer than N ready tasks. |
| `plan_source.phase_order` | `boolean` | `true` | Respect phase order: never propose a task from phase N+1 while an OPEN task exists in phase N or earlier (OPEN = not done, regardless of blocked/owner-only). |
| `plan_source.blocked_markers` | `string[]` | `["blocked", "hold", "owner-only", "owner only"]` | Whole-word markers (after the id, case-insensitive) that make a plan line unproposable. |
| `require_tier_and_gate` | `boolean` | `false` | Proposals for `add` must include explicit markers: `tier: <TIER>` and `gate: <scope>` (or `gate scope: <scope>`). |
| `brief_dir` | `string \| null` | `null` | Directory for overflow brief files (under an allowed root); null = no brief files, long lines are refused. |

**Note:** `verifier.auto_apply` default remains `[]` (off by default). `verifier.auto_reject` (already exists) default remains `[]`.

#### Events

| Event | Payload | When |
|-------|---------|------|
| `planner.proposal_superseded` | `{ project, runId, proposalId, task, op, reason }` | A proposal was refused by the race guard (task/assignment already exists). |
| `planner.would_auto_apply` | `{ project, runId, proposalId, task, op }` | In observe mode, a proposal would auto-apply if mode were act. |
| `planner.stay_ahead_triggered` | `{ project, agent, readyCount, target }` | Stay-ahead logic triggered a cycle because an agent has fewer than target ready tasks. |
| `planner.change_undone` | `{ project, changeId, task, op, undoneBy }` | An applied change was undone. |

Existing events unchanged: `planner.proposal_auto_applied` (already in main, not new).

#### Routes

**New route:**

```
POST /api/planner/{project}/changes/{id}/undo
Auth: owner-only
Request: (none)
Response 200: { id: string, task: string, op: string, restoredLine: string | null }
Response 400: { error: "change not found" | "already undone" | "line changed since apply" | "no prior line to restore" }
Response 403: { error: "owner-only" }
```

Restores the prior line (from `diff[0]`) if the current line matches `diff[1]`. For `add` ops, removes the added line if it still matches. Refuses if the line changed since apply (the owner must review the current state). Records `undone_by` and `undone_at` on the original change and adds a new change with `op: "undo"`.

### Flow

#### Auto-apply after verification (act mode) — existing + superseded

1. Verifier run completes with verdicts.
2. For each accepted proposal:
   a. If `verdict === "approve"` and `op in verifier.autoApply` and `mode === "act"` and `approval[op] === "never"`:
      - Call existing `this.apply([p], "lair:verifier", now)`.
      - `apply()` re-reads the tasks file, re-checks via `checkProposals`.
      - If the task now exists: **change from `rejected` to `superseded`** with `refusal: "task {task} was added between proposal and apply"`. Emit `planner.proposal_superseded`.
      - If the task is valid: apply the edit, `status: "applied"`, `decidedBy: "lair:verifier"`. Copy `verifier_verdict`, `verifier_reason`, `verifier_evidence` to the change row. Emit `planner.proposal_auto_applied` (existing event).
   b. If `verdict === "reject"` and `op in verifier.autoReject`:
      - Mark proposal `status: "declined"`, `decidedBy: "lair:verifier"` (existing behavior, unchanged).
   c. Else: proposal waits for owner (existing behavior).
3. Tests: AT-1–AT-7 cover existing auto-apply; AT-8–AT-10 cover superseded; AT-21–AT-23 cover undo.

#### Observe mode record

1. In `finishAfterVerification`, before deciding whether to auto-apply:
   a. If `mode !== "act"` (observe mode) and the proposal would auto-apply (same conditions as above):
      - Set `proposal.would_auto_apply = true` in the store.
      - Emit `planner.would_auto_apply { project, runId, proposalId, task, op }`.
      - Proposal continues to wait for owner (unchanged behavior).
2. The Planner view shows `would_auto_apply` proposals with a label so the owner can compare before promoting to act.
3. Test: AT-6a.

#### Race-condition guard (superseded status)

In `apply()`, when `checkProposals` returns a refusal because the task/assignment now exists:
- **Change:** instead of `status: "rejected"`, use `status: "superseded"`.
- `refusal` stays as `"no longer valid: <reason>"`.
- Emit `planner.proposal_superseded`.

This distinguishes race-guard refusals from owner rejections in history and metrics.

#### Undo operation

1. `POST /api/planner/{project}/changes/{id}/undo` (owner-only).
2. Find the change by id; 400 if not found or if `undone_by` is set.
3. For `add`: the added line is `diff[1]`. Re-read the tasks file; find the line matching `diff[1]`. If not found or changed, 400 "line changed since apply".
4. For `reword`: `diff[0]` is before, `diff[1]` is after. Re-read; find the line matching `diff[1]`. If not found or changed, 400.
5. For `add`: remove the line. For `reword`: restore `diff[0]`.
6. Set `undone_by` and `undone_at` on the original change.
7. Add a new change with `op: "undo"`, `task`, `diff: [current, restored]`, `reason: "undone by owner"`.
8. Emit `planner.change_undone`.
9. Return the restored line (or null for add).

Test: AT-21–AT-23.

#### Stay-ahead fill with fingerprint

1. On every cycle, after sources are read:
   a. For each allowlisted agent, count open tasks assigned to them (the running task counts).
   b. If `stay_ahead.enabled` and count < `stay_ahead.ready_tasks`:
      - Compute fingerprint: `sha256(sorted list of (agent, proposable task ids))`.
      - If fingerprint matches `this.state(STAY_AHEAD_FINGERPRINT)`: skip (no new trigger).
      - Else: add trigger `stay_ahead` with `{ agent, current: count, target: ready_tasks }`. Save fingerprint.
2. On deterministic mark-done (`trigger_on_done: true`):
   a. If the agent's ready count drops below target and fingerprint changed: add trigger immediately.
3. `max_runs_per_day` cap applies (existing; stops all triggers once reached).
4. Test: AT-11–AT-13, AT-24 (fingerprint dedupe), AT-25 (max_runs_per_day stops stay-ahead).

#### Plan source readiness (refinements)

1. **Id-less lines:** A plan line without an id (no match for `id_pattern`) gets a stable identity: `slug(line_text)` (first 64 chars of the text, lowercased, non-alphanum replaced with `-`, trimmed). The proposal's `task` field uses this slug. Duplicate detection and "already in the tasks file" use the slug. AT-26.
2. **File order within a phase:** Tasks within a phase are ordered by their line number in the plan file (existing behavior). The spec confirms it. AT-27 (already covered by AT-14 indirectly).
3. **Phase order blocks on OPEN tasks:** "OPEN" = not done (in the plan or the tasks file, regardless of blocked/owner-only markers). If phase 1 has any OPEN task (blocked, owner-only, or not), phase 2 tasks are not proposable. AT-28.
4. **Whole-word match for blocked markers:** Use `\b<marker>\b` (word boundary). "hold" does not match "household". AT-15 updated.
5. **Ticked lines (`[x]`) are never proposed:** Covered by the algorithm; add explicit AT-29.

#### Tier and gate scope validation (explicit markers)

1. In `checkProposals`, when `op === "add"` and `require_tier_and_gate: true`:
   a. Check `proposal.text` for tier marker: `/\btier:\s*(RED|YELLOW|GREEN|MIGRATIONS|AUTH|BILLING|PRIVACY)\b/i` (requires `tier:` prefix).
   b. Check `proposal.text` for gate marker: `/\bgate(?:\s+scope)?:\s*\S+/i`.
   c. If either is missing: refuse with `"add proposals must include tier: <TIER> (e.g. tier: GREEN) and gate: <scope> (e.g. gate: backend-targeted ClassName)"`.
2. "green tea" without `tier:` is refused. "author" or "red" without `tier:` is refused. AT-17 updated, AT-30.

#### Line-length handling

1. In `checkProposals`, for `add` proposals:
   a. Compose the full line: `{agent}|{task}|{text}`.
   b. If length > `MAX_TASK_LINE_CHARS` (2000):
      - If `brief_dir` is configured: write the text to a file under `brief_dir` (path: `{brief_dir}/{task}.txt`, atomically, max 50 KB). Replace `text` with `brief: {relative path}`. Re-check length.
      - If still over or `brief_dir` is null: refuse with `"the composed task line exceeds ${MAX_TASK_LINE_CHARS} characters; shorten the text or configure brief_dir"`.
   c. Refuse if the brief path escapes the allowed roots.
2. AT-31 (at limit accepted), AT-32 (over limit refused), AT-33 (long brief goes to file), AT-34 (path outside roots refused).

#### Interaction with `approval` config

Main's `approval.add` and `approval.reword` default to `never`. The auto-apply rule is:
```
approval[op] === "never" AND autoApply.includes(op) AND verdict === "approve"
```
`finish`, `reassign`, `unblock` default to `always`, so they wait even if in `autoApply`.

Test AT-35: `finish` in `auto_apply` still waits because `approval.finish === "always"` by default.

#### Unreadable or oversize tasks file

If the tasks file can't be read or is over `MAX_TASKS_FILE_BYTES` at apply time, `apply()` throws and proposals wait for the owner. The cycle error is recorded in `run.detail`. AT-36.

#### File changed between re-read and rename

Main's `commit()` writes atomically (rename). If the file changes between the re-read and the rename, the rename fails and `commit()` throws. Proposals wait for the owner. AT-37.

### Security and privacy

- **No new auth surfaces**: all routes remain owner-only. Undo is owner-only.
- **Tenant scoping**: per-project planner state, no cross-project access.
- **Secrets**: no secrets in proposals, tiers, or gate scopes (plain text identifiers only). Brief files contain task text only, no secrets.
- **Logging**: events log task ids and ops, never task descriptions or plan content. Ids (slugs) are allowed.
- **Injection**: proposal text is cleaned by existing `clean()` before any use; tier/gate patterns are anchored regexes, not user-provided. Brief paths are validated against allowed roots.

### Reliability

- **Timeouts**: existing cycle and run timeouts apply; race-guard re-read uses the same `MAX_TASKS_FILE_BYTES` limit.
- **Retries**: verifier retries are existing (`verifier.attempts`); auto-apply has no separate retry (a superseded proposal stays superseded).
- **Idempotency**: the race-condition guard makes auto-apply idempotent: a restart re-reads the file and re-checks. Undo is idempotent (returns "already undone" if undone_by is set).
- **Dependency down**: if the tasks file can't be read, the cycle fails and logs the error (existing behavior); proposals wait.

### Observability

- **Events**: `planner.proposal_superseded`, `planner.would_auto_apply`, `planner.stay_ahead_triggered`, `planner.change_undone` join existing events.
- **Metrics**: count of superseded proposals per project (existing metrics pattern).
- **Logs**: `[planner]` prefix, level info for auto-apply, warn for superseded, error for failures.
- **Dashboard**: Planner view shows superseded proposals with their reason; history tab shows auto-apply decisions as "lair:verifier"; would_auto_apply proposals labeled in observe mode.

## 5. Acceptance tests

Each test name is the function name in the test file. Status values are the real ones from main: `applied`, `rejected`, `declined`, `superseded`.

**Auto-apply (existing behavior, covered for completeness):**

- **AT-1 `autoAppliedAddDoesNotWait`:** Given a verifier-approved `add` proposal in act mode with `auto_apply: ["add"]` and `approval.add: "never"`, when `finishAfterVerification` runs, then the proposal is applied (task appears in tasks file) and `status === "applied"`, `decided_by === "lair:verifier"`, and event `planner.proposal_auto_applied` is emitted. The decision inbox has no item for this proposal.
- **AT-2 `autoAppliedRewordDoesNotWait`:** Given a verifier-approved `reword` proposal in act mode with `auto_apply: ["add", "reword"]` and `approval.reword: "never"`, when `finishAfterVerification` runs, then the task's description is updated and the decision inbox has no item.
- **AT-3 `rejectVerdictWaitsUnlessAutoReject`:** Given a verifier `reject` verdict on an `add` proposal, and `auto_reject: []`, when `finishAfterVerification` runs, then `status === "pending"` and the proposal waits for owner (decision inbox has an item).
- **AT-4 `rejectVerdictAutoRejectsWhenConfigured`:** Given a verifier `reject` verdict on a `reword` proposal, and `auto_reject: ["reword"]`, when `finishAfterVerification` runs, then `status === "declined"`, `decided_by === "lair:verifier"`, and no decision inbox item.
- **AT-5 `unsureVerdictAlwaysWaits`:** Given a verifier `unsure` verdict on an `add` proposal with `auto_apply: ["add"]`, when `finishAfterVerification` runs, then the proposal waits for owner.
- **AT-6 `observeModeNeverAutoApplies`:** Given a verifier-approved `add` proposal in observe mode, when `finishAfterVerification` runs, then the proposal waits for owner (observe mode ignores `auto_apply`).
- **AT-6a `observeModeRecordsWouldAutoApply`:** Given the same, then `proposal.would_auto_apply === true` and event `planner.would_auto_apply` is emitted.
- **AT-7 `dropNeverAutoApplies`:** Config validation refuses `auto_apply: ["drop"]` with error "drop can never be auto-applied".
- **AT-7a `finishStillWaitsWithDefaultApproval`:** Given `auto_apply: ["finish"]` but `approval.finish` is default `"always"`, when a verifier-approved `finish` proposal runs, then it waits for owner (approval takes precedence).

**Superseded status (new):**

- **AT-8 `raceGuardSupersededNotRejected`:** Given an `add` proposal for task `feat-x`, and between verification and apply another process adds `feat-x` to the tasks file, when `apply()` runs, then `status === "superseded"` (not `rejected`), `refusal` contains "was added between proposal and apply", and event `planner.proposal_superseded` is emitted.
- **AT-9 `raceGuardRefusesDoneTask`:** Given an `add` proposal for task `feat-y`, and the task is already `#done` in the tasks file, when `apply()` runs, then the proposal is superseded.
- **AT-10 `raceGuardAllowsFreshTask`:** Given an `add` proposal for task `feat-z` that does not exist in the tasks file, when `apply()` runs, then the task is added and `status === "applied"`.

**Stay-ahead fill:**

- **AT-11 `stayAheadTriggersWhenBelowTarget`:** Given `stay_ahead.enabled: true`, `ready_tasks: 2`, and agent `worker-a` has 1 open task, when `cycle()` runs, then a trigger `stay_ahead` is added for `worker-a`.
- **AT-12 `stayAheadDoesNotTriggerWhenAtTarget`:** Given `stay_ahead.enabled: true`, `ready_tasks: 2`, and agent `worker-a` has 2 open tasks, when `cycle()` runs, then no `stay_ahead` trigger is added.
- **AT-13 `stayAheadTriggersOnDone`:** Given `stay_ahead.enabled: true`, `ready_tasks: 2`, `trigger_on_done: true`, and agent `worker-a` has 2 open tasks, when one task is marked done (leaving 1), then a trigger is added immediately.
- **AT-24 `stayAheadFingerprintPreventsRepeatedTriggers`:** Given the same conditions as AT-11, when `cycle()` runs twice with no change to proposable tasks, then only one trigger is added (the second cycle sees the same fingerprint and skips).
- **AT-25 `maxRunsPerDayStopsStayAhead`:** Given `stay_ahead.enabled: true` and `max_runs_per_day` reached, when `cycle()` runs, then no stay_ahead trigger is added.

**Plan source:**

- **AT-14 `planSourceRespectsPhaseOrder`:** Given plan tasks in Phase 1 (task A, ready), Phase 2 (task B, ready), and `phase_order: true`, when the planner agent's context is built, then only task A is in `proposableTasks` (task B is filtered out).
- **AT-15 `planSourceIgnoresBlockedMarkersWholeWord`:** Given a plan line `- [ ] feat-blocked: text (owner-only)` with `blocked_markers: ["owner-only"]`, when sources are read, then `feat-blocked` is not in `proposableTasks`. Given a line `- [ ] feat-household: text`, then it IS proposable ("hold" does not match "household").
- **AT-16 `planSourceRespectsDependencies`:** Given plan task `feat-b` depends on `feat-a`, and `feat-a` is not done, when sources are read, then `feat-b` is not in `proposableTasks`.
- **AT-26 `idLessLineSlugged`:** Given a plan line `- [ ] implement the search page` without an id, when sources are read, then it gets slug `implement-the-search-page`, and if a task with that slug is already in the tasks file, the line is not proposable.
- **AT-27 `planSourceFileOrder`:** Given plan tasks in Phase 1 (task A at line 10, task B at line 5), when building context, then task B appears before task A in `proposableTasks` (file order).
- **AT-28 `phaseOrderBlocksOnOpenNotProposable`:** Given Phase 1 has task A (OPEN, blocked), Phase 2 has task B (OPEN, proposable), and `phase_order: true`, when building context, then task B is NOT proposable (phase 1 is not exhausted; A is still OPEN).
- **AT-29 `tickedLinesNeverProposed`:** Given a plan line `- [x] feat-done: completed task`, when sources are read, then `feat-done` is not in `proposableTasks`.
- **AT-20 `multiplePhasesInOrder`:** Given plan phases 1, 2, 3 with ready tasks in each, when building context with `phase_order: true`, then `proposableTasks` contains only phase 1 tasks; when phase 1 is exhausted (all done), then phase 2 tasks appear.

**Tier and gate scope:**

- **AT-17 `tierAndGateRequiredExplicitMarker`:** Given `require_tier_and_gate: true` and an `add` proposal with text "search page" (no tier:), when `checkProposals` runs, then the proposal is refused with "must include tier: <TIER> (e.g. tier: GREEN) and gate: <scope>".
- **AT-18 `tierAndGateAcceptedWhenPresent`:** Given `require_tier_and_gate: true` and an `add` proposal with text "search page. tier: GREEN. gate: backend-targeted SearchTest", when `checkProposals` runs, then the proposal is accepted.
- **AT-19 `tierAndGateNotRequiredWhenDisabled`:** Given `require_tier_and_gate: false` and an `add` proposal with text "search page" (no tier/gate), when `checkProposals` runs, then the proposal is accepted.
- **AT-30 `tierWithoutMarkerRefused`:** Given `require_tier_and_gate: true` and text "green tea" or "author notes" (tier word without `tier:` prefix), then refused. Given text "tier: GREEN" without gate, then refused.

**Undo:**

- **AT-21 `undoRestoresPriorLine`:** Given an applied `reword` change with `diff: ["old text", "new text"]`, when undo is called and the current line is "new text", then the line is restored to "old text", `undone_by` is set, and event `planner.change_undone` is emitted.
- **AT-22 `undoRefusesIfLineChanged`:** Given the same, when the current line is "different text" (changed since apply), then undo returns 400 "line changed since apply".
- **AT-23 `undoRemovesAddedLine`:** Given an applied `add` change, when undo is called, then the added line is removed (if it still matches).

**Line length:**

- **AT-31 `lineLengthAtLimitAccepted`:** Given an `add` proposal with composed line exactly `MAX_TASK_LINE_CHARS` (2000), then accepted.
- **AT-32 `lineLengthOverLimitRefused`:** Given an `add` proposal with composed line 2001 chars and no `brief_dir`, then refused with the length message.
- **AT-33 `longBriefGoesToFile`:** Given `brief_dir` configured and an `add` proposal with long text, then the text is written to `{brief_dir}/{task}.txt` and the proposal's text becomes `brief: {path}`, under the limit.
- **AT-34 `briefPathOutsideRootsRefused`:** Given a crafted task id that would make the path escape allowed roots, then refused.

**Evidence:**

- **AT-38 `changeRecordsVerifierEvidence`:** Given an auto-applied proposal with verifier verdict and reason, when the change is recorded, then `verifier_verdict`, `verifier_reason`, `verifier_evidence` are set on the change row.

**Error cases:**

- **AT-35 `finishWaitsEvenIfInAutoApply`:** Given `auto_apply: ["finish"]` but `approval.finish` is default `"always"`, then the proposal waits.
- **AT-36 `unreadableTasksFileProposalsWait`:** Given the tasks file is unreadable at apply time, then `apply()` throws and proposals wait.
- **AT-37 `fileChangedBetweenRereadAndRename`:** Given the file changes between re-read and rename, then `commit()` throws and proposals wait.

## 6. Rollout

1. **Config switches default off/false**: `stay_ahead.enabled: false`, `verifier.auto_apply: []` (existing default), `require_tier_and_gate: false`.
2. **Observe mode first**: deploy; monitor `planner.would_auto_apply` events for what would auto-apply.
3. **Enable stay-ahead**: set `stay_ahead.enabled: true` in one project; watch for trigger counts; tune `ready_tasks` if needed; fingerprint prevents storms.
4. **Enable auto-apply for add**: set `verifier.auto_apply: ["add"]` in act mode; monitor superseded events (should be rare).
5. **Enable tier/gate requirement**: set `require_tier_and_gate: true`; update planner agent prompt to include explicit markers; monitor refusals.
6. **Full act mode**: set `verifier.auto_apply: ["add", "reword"]` once stable.
7. **Rollback**: set `auto_apply: []` to return to decision-based flow; set `stay_ahead.enabled: false` to disable proactive filling.

## 7. PR split

1. **PR 1: Superseded status** (~150 lines): schema migration, `ProposalStatus` union update, change `rejected` to `superseded` in race-guard path, event, tests AT-8, AT-9, AT-10.
2. **PR 2: Evidence and undo** (~250 lines): evidence fields on changes, undo route, undo logic, tests AT-21 through AT-23, AT-38.
3. **PR 3: Observe mode record** (~100 lines): `would_auto_apply` field, event, test AT-6a. Wire into `finishAfterVerification`.
4. **PR 4: Stay-ahead with fingerprint** (~200 lines): config keys, fingerprint logic, trigger on done, tests AT-11 through AT-13, AT-24, AT-25.
5. **PR 5: Plan source refinements** (~200 lines): id-less slug, phase blocks on OPEN, whole-word blocked markers, tests AT-15 (updated), AT-26, AT-28, AT-29.
6. **PR 6: Tier/gate explicit marker + line length** (~150 lines): explicit marker validation, line-length check, brief-file overflow, tests AT-17 (updated), AT-30 through AT-34.

Each PR is independently mergeable and wired (config parsed, defaults safe, tests pass). Total ~1050 lines.

## 8. Open risks

- **Superseded cascades**: if many proposals race, all but one are superseded. Mitigation: record each with its reason; the owner sees patterns in history; consider debouncing applies.
- **Undo window**: undo refuses if the line changed since apply; the owner must review manually. Mitigation: document the limitation; a fast manual edit after auto-apply may block undo.
- **Brief file growth**: brief files accumulate. Mitigation: retention policy (future work, not in this spec).
- **Phase-order inflexibility**: strict phase order may leave agents idle if the owner hasn't ticked earlier phases. Mitigation: the owner can mark blocked items done or use a config override (future work).

---

**Follow-up noted (not in this spec):**
- N2 (docs/design/decision-policies.md): the stopped-under notice can lag by check_seconds.
- N3: a refused job waits its cool-down before moving back.
- Per-request sync IO in `/api/dragons` (Lair #198).
