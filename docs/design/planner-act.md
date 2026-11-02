# Planner act mode and the ready backlog

- **Status:** design, not built. Nothing here is code yet.
- **Base:** main `d2b3d8e`.
- **Issues:** #243 (act mode: verified proposals apply, stay ahead, race guard), #96 and #252 (act mode put back outside
  edits to the tasks file), #97 (the same proposal in consecutive runs), #298 (an owner request proposed again after
  its work merged), #290 (the verifier accepted a DONE line naming another task's PR), #166 (no agent idles while
  ready work exists), #294 (AI spend, whose guard G6 is the planner's guard set).
- **Related:** [planner.md](planner.md) (what is built), [ai-spend.md §4.5 G6](ai-spend.md) (four planner guards,
  build PR 8, open as #322), [work-store.md](work-store.md) (tasks move into Lair's database later; the rules here
  move with them). This spec replaces the earlier draft in PR #244. §9 lists what it keeps from that draft and what it
  drops.

The planner already keeps fill's tasks file in step with the plan, the queue and the owner's messages. Its model
proposes, Lair checks the proposals, a verifier reviews them, and the approval rules decide what applies. In practice
every project runs it in `observe`, where every proposal waits for the owner. This spec covers four things:

1. **A ready backlog.** The planner keeps enough ready task lines for the agents that can start now. It no longer
   waits for an agent to go idle before it plans.
2. **Specs first.** A new feature becomes a spec task first. Its build task is ready only after the spec's PR has
   merged.
3. **Guards that make act mode safe.** These are G6 from the AI spend spec, plus three more. The 31 Oct failure, where
   act mode overwrote the tasks file, can't happen again.
4. **When to switch to act.** Lair collects the evidence for switching from `observe` to `act` and shows it. The
   switch stays a config change that the owner makes.

Every new part has a mode, `off`, `observe` or `act`. Each one ships as `off` and is turned on in `observe` first.

## 1. Why: what went wrong

### 1.1 Act mode overwrote the tasks file (31 Oct)

One deployment ran the planner in `act` mode while the operator, and an orchestrating agent working for them, kept
editing the same tasks file. What happened (#96, #252):

- In act mode Lair treats the content it last wrote as the true file. When the file changes while a planner run is
  active, Lair writes its own version back over it (`src/server/planner/service.ts:477-545`, the write at `:486`).
- The decision about this has the key `tamper:<run id>` (`service.ts:516`), so a run raises it only once. The owner
  was told about the first restore. Later edits during the same run, made minutes apart, were put back with no
  further notice.
- That decision also sets `cause_cleared: true` (`service.ts:538`) once the file has been put back, so it can close
  by itself.
- **Eleven new task lines were lost.** Lines the owner had taken away from agents came back, along with stop notes
  that had been removed. Agents went back to work they had been told to stop.
- The run's proposals were refused as well. So the owner's edits were lost and the planner's run was wasted.

**The cause:** Lair's last-known text won over a newer edit by a person. The edit was safe from a lost-update race,
because writes compare the file's hash first (`src/server/planner/files.ts:147`). The restore path is what overwrote
it, and it did so on purpose. Act mode was also switched on without any evidence that the planner was ready for it,
and while another writer was active.

### 1.2 Observe mode is slow and mostly wasted

- **Waiting.** Owner directive, 31 Oct (#243): 36 % of proposals were applied in the end, only 11 % of changes to the
  tasks file came from the planner, and each proposal waited 10 to 50 minutes for an answer. Agents sat idle during
  that wait.
- **Refusals.** The 48 hours to 2 Nov ([ai-spend.md §1](ai-spend.md)): 19 planner runs, 45 proposals, 8 applied
  (18 %). The verifier declined 20, and Lair's rules refused 17.
- **Why they were refused.** Most of them proposed work that was already done: closed task ids, and an owner request
  that had been carried out days earlier (#298).
- **Whole runs lost.** 9 runs were refused whole because the tasks file changed while they ran.
- **Duplicates.** Two runs 40 minutes apart proposed the same two `add`s, which left two identical pending decisions
  (#97).
- **Wrong PR.** A `finish` was approved because the PR named in a DONE line existed and had merged, but it was another
  task's PR (#290).

### 1.3 The planner reacts too late

- **It plans only after an agent is idle.** The `idle` trigger fires when an allowlisted agent has no active run and
  no open line (`service.ts:844-855`). A planner run then needs `debounce_seconds`, the run itself, the verifier and
  the approval before the agent gets a line. In observe mode that took tens of minutes.
- **Unassigned lines go unused.** Fill already treats these lines as ready work for any agent
  (`src/server/agents/fill.ts:979-1035`) and raises a notice when an agent is idle while ready work exists
  (`fill.idle`, `src/server/agents/config.ts:158-169`). But nothing hands such a line to the idle agent.
- **It ignores phases and owner markers.** Nothing reads the plan's phase order or a plan line that is marked for the
  owner only. `orderTasks` (`src/server/planner/context.ts:41-45`) ranks tasks only by trigger and by `ready`.

## 2. What exists today

The rows below were found with `git grep` on main over the planner module, fill and the agents config. Searched
keywords: idle, ready, restore, tamper, auto_apply, approval, unassigned, phase, spec, pending, duplicate.

| What | Where | What it does | What is missing |
|---|---|---|---|
| Planner modes | `src/server/planner/config.ts:167` `mode: observe \| act` | `observe` writes nothing. `act` writes the tasks file | One switch for everything. No evidence report, no per-part modes |
| Approval per op | `config.ts:186-196` | `add` and `reword` apply by themselves in act mode. The other ops wait for the owner | Kept as is |
| Verifier auto-apply | `config.ts:154` `verifier.auto_apply`; `config.ts:451-456` (`drop` never allowed) | Verifier-approved ops in this list apply in act mode | Kept as is |
| Compare-and-swap write | `src/server/planner/files.ts:147` `writeTasksFile(path, text, expectHash, …)` | Writes atomically, and only if the file still has the expected hash | Kept as is. Every write in this spec goes through it |
| Restore during a run | `service.ts:477-545` | In act mode, an outside edit during a run is overwritten, and the run's proposals are refused | The 31 Oct failure. G6 `recheck_on_change` replaces it (§4.3) |
| Idle trigger | `service.ts:844-855`, `src/shared/planner-types.ts:67` `TriggerKind` | One trigger per new set of idle agents | Reactive only. It knows nothing about capacity or the number of ready lines |
| Plan tasks, ready flag | `service.ts:175` (`ready = !done && waitingOn.length === 0`), `src/server/planner/sources.ts:89-152` (phase from `phase_pattern`) | Reads each plan task's dependencies and phase | Phase order isn't used, and there is no marker to skip a task |
| Context ordering | `src/server/planner/context.ts:41-45` `orderTasks` | Tasks named by triggers come first, then ready tasks | No phase order, and no count of how many lines are wanted |
| Add rules | `src/server/planner/proposals.ts:98` (`add` needs an agent), `:112-113` (an existing line or a done id is refused) | Refuses a duplicate line or a reused id | An `add` can't make an unassigned line. Nothing compares a proposal with pending ones (#97) |
| Unassigned lines | `src/server/agents/fill.ts:721-722`, `:979-1035` `unassignedLine` | `\|<name>\|<task>\|<desc>` is ready work for any agent. Fill never starts it | No rule assigns one to an idle agent |
| Idle notice | `src/server/agents/config.ts:158-169` `fill.idle.notice_minutes` (0 = off), `ready_sources: ["tasks_file"]` | Raises one notice per idle episode while ready work exists | Ready work comes only from the tasks file. The plan is not a source |
| Fill holds | `src/server/agents/fill.ts:176` `OWNER_HOLDS` | Shows the reason fill won't start a line | The planner doesn't count held lines as "not ready" |
| Prompt files | `src/server/agents/config.ts:214` `prompt_files` with `{prompts_dir}`, `{agent}`, `{task}` | Builds the prompt for a run | No placeholder for the kind of task, so a spec task gets the same prompt as a build task |
| Task types | `src/shared/server-types.ts:55` `TaskType` | This is the scheduler's job type (build, review, gate…), not a planner task kind | No planner task kind exists |
| G6 guards | [ai-spend.md §4.5](ai-spend.md), PR #322 (open) | `prefilter_closed`, `handled_messages`, `skip_unchanged`, `recheck_on_change`, each `off`/`observe`/`act` | Specified and being built. This spec depends on them and does not specify them again |
| Verifier PR ownership | PR #308 (open), #290 | Checks that the PR a DONE line names belongs to the task | Being built. A prerequisite for `finish` in act mode |

## 3. Gaps

1. In act mode, Lair overwrites an outside edit made during a run (#96, #252).
2. Act mode can be turned on with no evidence that it is safe, and while another writer is editing the file.
3. The planner plans only after agents are idle. Nothing keeps a number of ready lines ahead of demand (#166, #243).
4. Unassigned ready lines are never given to an idle agent.
5. Phase order and owner-only or blocked markers in the plan are ignored.
6. A new feature has no spec step. Its build task can be proposed and started before anyone has written or approved a
   spec.
7. A proposal identical to a pending one is proposed again (#97).
8. An applied change can be undone only by editing the file by hand.

## 4. Design

### 4.1 The ready backlog (`planner.backlog`)

**Definitions.** Lair computes these on every planner cycle, from data it already has: the agents store, fill's holds
and the tasks file.

- **Startable agent:** an agent in `agents.fill.agents` that is not the planner or the verifier, has no active run,
  and is not cooling down after a failover.
- **Free slots:** `fill.max_active` minus the number of active runs fill started, never below 0.
- **Idle capacity:** the smaller of free slots and the number of startable agents.
- **Ready line:** an open line in the tasks file that fill would start now:
  - assigned to a startable agent, with no hold from `OWNER_HOLDS`, and not done; or
  - unassigned, and ready according to `unassignedLine`.
- **Target:** idle capacity plus `ahead`. `ahead` keeps a margin of lines for agents that are about to finish.
- **Deficit:** target minus ready lines, never below 0.

**Trigger.** A new trigger kind, `backlog_low`, fires when the deficit is above 0. It is deduplicated by a fingerprint
of the deficit and the set of ready plan task ids. A cycle with the same shortage does not trigger again, and an edit
that leaves the same shortage is not a new reason to plan. The existing `idle` trigger stays.

**What the run is told.** The context gains `backlog: { idleCapacity, readyLines, target, want }`. `want` is the
deficit, capped at `max_adds_per_run`. One rule line in Lair's appended instructions says: "propose up to `want`
`add`s from ready plan tasks, in phase order".

**Phase order and markers.** The planner orders and filters plan tasks before it builds the context:

- **Phase order.** With `phase_order: strict`, a plan task is offered only when no earlier phase has an open task that
  is not marked skipped. Phase order is the order in which the phases first appear in the plan files.
- **Skip markers.** A plan task whose text matches `skip_pattern` (default `\b(owner-only|blocked)\b`, matched
  whole-word, case-insensitive) is never offered or proposed. It doesn't hold back later phases.
- **Closed work.** G6 `prefilter_closed` removes closed work first.

**Unassigned adds.** With `backlog.unassigned: true`, an `add` may omit `agent`. The line is then written in the
unassigned form that fill already parses. This keeps two jobs apart:

- the model decides **what** is next;
- the rule below decides **who** takes it.

**The assign rule (`backlog.assign`, deterministic, no model).** On each cycle:

1. Take each startable agent with no open line, in allowlist order.
2. Give it the first ready unassigned line, in file order.
3. Write the agent and its name into that line.

Each assignment is one history row with source `rules`, op `assign`, and before and after lines. It is written through
the compare-and-swap write. A line that a run or claim holds is skipped.

**The rules source (`backlog.source: rules`).** For projects whose plan is precise enough, Lair fills the deficit
without a model. It takes the next ready plan tasks in phase order, after the filters above, and appends them as
unassigned lines:

- the id is the plan id;
- the description is the plan text, cleaned and cut to 500 characters.

These lines go through the same checks as a model's `add`, as proposals with source `rules`. They then follow the
approval rules. The verifier is asked only when `backlog.verify_rules: true`. With `source: model` (the default), the
model proposes, as it does today.

**Bounds.** At most `max_adds_per_run` adds per run or rules cycle, and at most `max_adds_per_hour` adds per project
across both sources. Adds beyond either limit are refused with the reason. The existing caps still apply: 200 tasks
and 256 KB.

**Observe.**

- **Writes nothing.** `backlog.mode: observe` writes nothing, and the assign rule only records `would_assign`.
- **Rules source:** records `would_add` with the task ids.
- **Model source:** the trigger fires, and the run's adds wait for the owner as they do today.

**Fill's idle notice.** `fill.idle.ready_sources` gains `plan`. With it, a ready plan task that the backlog filters
would offer also counts as ready work, so the notice says "idle while the plan has ready work". This closes #166
item 1 for the plan source.

### 4.2 Specs as a planner task kind (`planner.spec_first`)

A plan task can need a spec before it is built. It needs one when:

- its text or details match `marker_pattern` (default `\[spec\]`); or
- with `scope: all_new`, it has no link that matches `link_pattern` (default
  `docs/(design|specs)/[^\s)]+\.md`) to a file that exists on the default branch.

**What happens:**

- **The spec task.** For a plan task `X` that needs a spec, the only task offered is `X` + `suffix` (default
  `X-spec`). Its kind is `spec`. Both the model and the rules source see it with `kind: "spec"`, and the model's
  `add` may carry `kind: "spec"`. Lair checks that the id of a `spec` add ends in `suffix` and names an open plan task
  that needs a spec. An `add` of `X` itself is refused with the reason "X needs its spec first (X-spec)".
- **The build task waits.** `X` gets `waitingOn: ["X-spec"]`, so it isn't ready until `X-spec` is **approved**.
  Approved means that `X-spec`'s own PR has merged. Its own PR is found with G6's matcher: a head branch that
  contains the task id, or the PR named in the task's DONE line. Merged means merged according to the review store. A
  DONE line without a merged PR does not count.
- **After the merge.** `X` becomes ready and is offered like any other task. Its context details gain the spec's path
  from the merged PR's changed files, so the build task points to the spec.
- **The prompt.** Fill gains a `{kind}` placeholder in `prompt_files`. It is `spec` when the task id ends in
  `spec_first.suffix` and `build` otherwise. A project can then add a file such as
  `{prompts_dir}/kinds/{kind}.md`. A placeholder file that doesn't exist is skipped for `{kind}` only, so that
  projects without kind files keep working. Every other missing file still fails as today.
- **A stalled spec.** A spec task whose PR has been open for longer than `stall_hours` (default 48) raises one notice
  per task. The planner never skips the spec by itself.
- **Observe.** `spec_first.mode: observe` changes nothing. Each cycle it records `would_spec` for every plan task it
  would route through a spec. The record is once per task, kept in `planner_state`.

### 4.3 Guards that act mode requires

**G6 (built by ai-spend PR 8, #322).** Not specified again here. The parts this spec relies on:

- `recheck_on_change` replaces the restore. An outside edit during a run is kept, recorded with its diff, and
  announced in one notice that names the run. Each proposal is then checked against the current file. **This is the
  fix for §1.1.**
- `prefilter_closed` keeps closed work out of the context.
- `handled_messages` stops a carried-out owner request from coming back.
- `skip_unchanged` saves a run whose inputs haven't changed.

**New in this spec:**

- **Pending duplicates** (`guards.dedupe_pending`, #97). A proposal whose `op`, `task` and `agent` match a proposal
  still pending from an earlier run is refused with the reason "already pending as proposal <id> of run <run>". For a
  `reword`, the text is compared as well. In observe, it is recorded as `would_refuse` and kept.
- **Merged PRs for the verifier** (#298, second half). The verifier's context gains the merged PRs of the last 14
  days from the review store: number, title, head branch, at most 200. A verifier that searched only open PRs approved
  closed work. This is data only: the verifier still decides.
- **One notice per outside edit while act mode is on.** Every outside edit in act mode raises an `attention: notice`
  item, with the diff and the run if one was active. The item's key is the edit's hash, so one edit gives one notice
  and a second edit gives a second notice. This fixes the silent repeats in §1.1 even with `recheck_on_change` on.

**Config rules for act mode.** These are checked at load, and each error names the keys:

- `planner.mode: act` requires `guards.recheck_on_change: act`. Otherwise act mode could still overwrite an outside
  edit. Without that guard, act mode is refused.
- `planner.mode: act` requires `guards.prefilter_closed` and `guards.dedupe_pending` to be at least `observe`.
- `backlog.mode: act`, `backlog.assign: act` or `spec_first.mode: act` while `planner.mode` is `observe` is refused.
  Observe writes nothing, so those settings would be a no-op that looks active.
- A part set to anything other than `off` requires `agents.spend.enabled`, as G6 does, because the evidence counts
  (§4.4) come from spend.

**Undo.** `POST /api/planner/changes/:id/undo` (owner only, under `/api/planner`, `confirm: true`) reverses one
applied change:

- it restores the change's `before` line, or removes an added line;
- only when that line is still exactly as the change wrote it, using a per-line compare-and-swap through
  `writeTasksFile`;
- it records an `undo` history row that points to the change;
- it is idempotent: undoing an undone change returns the earlier undo row;
- otherwise it returns 409 with the reason.

The Planner view shows an Undo button on each applied change.

### 4.4 The evidence to switch from observe to act

Turning a part to `act` stays a config change by the owner. Lair never switches a mode by itself. To support that
choice, Lair computes a readiness report for each part over the last `act_evidence.days` days (default 7). It reads
only `planner.db` and the spend events, and is shown by `GET /api/planner/readiness` (owner only) and in the Planner
view.

| Part | Ready when (all hold) |
|---|---|
| `planner.mode: act` | All of these: (1) at least `min_samples` (20) proposals in auto-applied ops were verified; (2) of those the verifier approved, the owner approved at least `min_agreement` (0.9); (3) none of the owner-approved ones were undone or edited back by the owner within 24 h; (4) no more than one `would_refuse` from `dedupe_pending` per day; (5) G6 `recheck_on_change` has been in `observe` or `act` for the whole window |
| `backlog.mode: act` | At least `min_samples` `backlog_low` triggers or `would_add` records, and at least `min_agreement` of the would-add task ids were later added by the owner or approved. None was a closed or skipped task |
| `backlog.assign: act` | At least `min_samples` `would_assign` records. At least `min_agreement` of them match the assignment that happened next (by the owner or by an approved proposal) or have no conflicting assignment |
| `spec_first.mode: act` | At least 5 `would_spec` records, and none of them for a task that already had a merged spec link (a false positive) |

Each row shows its counts, the samples that failed, and **ready** or **not yet**. A part set to `act` whose row says
**not yet** gets a load warning and one notice, but it is not refused. The owner may know something the numbers
don't. The report is read-only and has no side effects.

### 4.5 What the planner still can't do

- Apply `finish`, `reassign`, `drop` or `unblock` without the owner, unless the owner adds them. `drop` can never be
  added. Approval defaults are unchanged.
- Write over a newer file. Every write compares the hash, and the restore path is gone in act mode.
- Skip a spec, or start a build whose spec PR hasn't merged.
- Propose a task marked owner-only or blocked, or a later-phase task while `strict` holds.

## 5. Configuration

```yaml
planner:
  mode: observe                    # existing; act needs the rules in §4.3
  backlog:
    mode: off                      # off | observe | act
    ahead: 2                       # lines beyond idle capacity (0-20)
    source: model                  # model | rules
    unassigned: true               # an add may leave the agent empty
    assign: off                    # off | observe | act: give idle agents the first ready unassigned line
    phase_order: strict            # strict | none
    skip_pattern: '\b(owner-only|blocked)\b'
    max_adds_per_run: 5            # 1-50
    max_adds_per_hour: 10          # 1-200
    verify_rules: false            # ask the verifier for rules-sourced adds
  spec_first:
    mode: off                      # off | observe | act
    scope: marked                  # marked | all_new
    marker_pattern: '\[spec\]'
    link_pattern: 'docs/(design|specs)/[^\s)]+\.md'
    suffix: "-spec"
    stall_hours: 48
  guards:                          # G6 (ai-spend.md) plus:
    dedupe_pending: off            # off | observe | act
  act_evidence:
    days: 7                        # 1-60
    min_samples: 20                # 1-1000
    min_agreement: 0.9             # (0, 1]
agents:
  fill:
    idle:
      ready_sources: [tasks_file]  # gains "plan"
```

Load checks:

- Every pattern compiles and is at most 500 characters. Matching uses the planner's existing bounded matcher, with
  lines cut at 2,000 characters.
- `suffix` matches `^-[a-z0-9-]{1,20}$`.
- The cross-key rules in §4.3 apply.
- An unknown key is refused, because the schemas are strict.

## 6. Acceptance tests

Each test drives `PlannerService` through its real cycle, with the harness in `src/server/planner/testing/harness.ts`.
The fake boundary is the agent run (a fixed `proposals.json`, written the way the agents module leaves it), plus the
review store for merged PRs. Each test also covers its negative cases.

| AT | Given | When | Then |
|---|---|---|---|
| AT-1 | `mode: act`, `recheck_on_change: act`. Planner run R is active. The owner adds 3 lines, then 2 minutes later removes one line | R ends with 2 proposals, one for a task the owner removed | The file keeps both of the owner's edits, and nothing is written back. Two notices, one per edit, each with its diff. The proposal for the removed task is refused with a reason, and the other one applies on top of the edited file |
| AT-2 | `mode: act`, `recheck_on_change: observe` | Config load | Refused, naming `planner.mode` and `planner.guards.recheck_on_change` |
| AT-3 | `backlog.mode: act`, `fill.max_active: 4`, 4 allowlisted agents, 1 running, 1 ready line, `ahead: 2` | A cycle | One `backlog_low` trigger with `want = 4` (3 + 2 − 1). The next cycle with the same state gives no new trigger. A new ready line gives a new fingerprint |
| AT-4 | The same as AT-3, but `max_adds_per_run: 2`, and the run returns 4 adds | The run ends | 2 apply, 2 are refused with the cap reason. Then `max_adds_per_hour` is reached: a further rules cycle adds nothing and records the reason |
| AT-5 | `backlog.assign: act`. 2 idle agents with no line, 3 unassigned ready lines, one of them claimed by a run | A cycle | The first two unclaimed lines are assigned, in allowlist order, by compare-and-swap writes, with 2 `assign` history rows. A restart before the second write finishes it once: no line is assigned twice |
| AT-6 | `backlog.source: rules`, `phase_order: strict`. Plan: phase 1 has one open task marked `owner-only` and one open task `a`; phase 2 has task `b` | A cycle with deficit 2 | Only `a` is added. The `owner-only` task is never added, and `b` waits until `a` is done |
| AT-7 | The same as AT-6, with `a` done | A cycle | `b` is added. A plan task whose id is a done id (G6 `prefilter_closed`) is not added |
| AT-8 | `backlog.mode: observe`, `assign: observe`, `source: rules` | The inputs of AT-5 to AT-7 | The tasks file is byte-for-byte unchanged. `would_add` and `would_assign` are recorded once each |
| AT-9 | `spec_first.mode: act`. Plan task `x` marked `[spec]` | A run proposes `add x`, then `add x-spec` | `add x` is refused with "x needs its spec first (x-spec)". `x-spec` applies with kind `spec` |
| AT-10 | The same as AT-9. `x-spec` has a DONE line, but its PR is still open | A cycle | `x` is not ready (`waitingOn: ["x-spec"]`). After the review store records the PR (head branch contains `x-spec`) as merged, `x` is ready and its details name the spec file |
| AT-11 | The same as AT-10, but the DONE line names a merged PR of another task | A cycle | `x` stays not ready, because the PR is not the spec task's own |
| AT-12 | Fill `prompt_files: ["{prompts_dir}/base.md", "{prompts_dir}/kinds/{kind}.md"]`, with only `kinds/spec.md` present | Fill starts `x-spec`, then `y` | `x-spec`'s prompt includes `spec.md`. `y`'s prompt is built without the missing `kinds/build.md`. A missing `base.md` still fails as today |
| AT-13 | `dedupe_pending: act`. Run 1 left `add t1 agent-a` pending | Run 2 proposes `add t1 agent-a` and `add t1 agent-b` | The first is refused as "already pending as proposal …", and the second is checked normally. In `observe`, both are kept and one `would_refuse` is recorded |
| AT-14 | Applied change C added line L | `POST /api/planner/changes/C/undo` with `confirm: true`, twice. Then the same for a change whose line the owner has since edited | The first call removes L and records an undo row. The second returns that same row and changes nothing. The edited one returns 409. Without an owner session: 401. Without `confirm`: 400 |
| AT-15 | 7 days of planner rows: 25 verified auto-apply proposals, 24 approved by the owner, 1 undone within 24 h | `GET /api/planner/readiness` | `planner.mode` is **not yet**, and the undone sample is listed. With no undo it is **ready**. The route has no side effects, and returns 401 without an owner session |
| AT-16 | `fill.idle.ready_sources: [tasks_file, plan]`, `notice_minutes: 5`. No ready lines, one ready plan task, one agent idle for 6 minutes | Fill ticks | One idle notice that names the plan source. A second tick in the same episode raises nothing |
| AT-17 | Every new part `off` | The inputs of AT-1 and AT-3 to AT-13 | Today's behaviour, unchanged. In AT-1 with G6 off, today's restore still happens; that is G6's own test, not this spec's |

## 7. Build PRs, in order

Each PR is at most about 600 non-test lines and builds and merges on its own. Each one sits behind its switch with
`off` as the default, includes its `observe` and `act` paths, and updates `docs/configuration.md` (planner and fill)
and [planner.md](planner.md).

0. **Prerequisites, not part of this spec:** ai-spend PR 8, G6 (#322), and the verifier's PR ownership check (#308).
1. **Act safety.**
   - The act-mode config rules (§4.3).
   - `dedupe_pending`.
   - One notice per outside edit.
   - The verifier's merged-PR context.
   - The undo route and its button.
   - ATs 1, 2, 13, 14, and AT-17 for these parts.
2. **Readiness report.** `GET /api/planner/readiness`, the counts from `planner.db` and the spend events, the Planner
   view panel, and the load warning. AT-15.
3. **Backlog: trigger and model source.**
   - Capacity and deficit.
   - The `backlog_low` trigger kind.
   - The context's `backlog` block and its rule line.
   - Phase order and `skip_pattern` in context ordering.
   - Unassigned adds and both caps.
   - ATs 3, 4, and AT-17.
4. **Backlog: assign rule and rules source.** `backlog.assign`, `source: rules`, `verify_rules`, and fill's `plan`
   ready source for the idle notice. ATs 5-8, 16.
5. **Specs first.** The `spec` kind, the waiting build task, the own-PR merge check (reusing G6's matcher), the stall
   notice, and fill's `{kind}` placeholder. ATs 9-12.

PRs 3 to 5 depend on PR 1. PR 2 can be built in parallel with PR 3. On the operator's install:

1. Turn the parts on in `observe`.
2. After a week, read the readiness report.
3. Switch each part that shows **ready**, one at a time. This is a config change, not a PR.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Act mode applies wrong work faster than an owner can see it | It can be turned on only with G6 and dedupe active. Adds are capped per run and per hour. Every change has a history row and an Undo. The readiness report needs a week of agreement first |
| Outside writers and Lair race on the file | Every write compares the hash. A lost race is retried on the next cycle from a fresh read. An outside edit is kept and announced, never overwritten |
| The assign rule gives a task to an agent that is a poor fit | It assigns only unassigned lines, which the planner or owner left open for any agent. A line with an agent is never reassigned. Projects that need fit leave `assign: off` and let the model assign |
| Unassigned lines pile up and go stale when the plan changes | `drop_plan_done` drops ticked tasks. The target caps how many lines are added. `max_adds_per_hour` bounds growth |
| Strict phase order leaves agents idle behind one blocked task | Skip markers take owner-only or blocked tasks out of the order. The idle notice names the earlier phase's open task |
| A spec PR never merges, so its build never starts | One stall notice per task after `stall_hours`. The owner can merge, drop or reword. The planner never skips the spec |
| `all_new` asks for specs for small fixes | The default is `marked`. `would_spec` false positives count against readiness |
| The readiness numbers are gamed or misread | They come only from Lair's own stores. The switch stays manual, and a warning shows when act is set before **ready** |

## 9. Relation to the earlier draft (PR #244)

- **Kept:**
  - verified `add`s apply by themselves in act mode (already true by default, `config.ts:186-196`);
  - a plan file as the source of ready work, in phase order;
  - owner-only and blocked markers;
  - keeping lines ahead of idle agents.
- **Replaced:**
  - the race guard and its `superseded` status become G6 `recheck_on_change`, plus refusal reasons per proposal (the
    status stays `rejected`, decided by `lair`);
  - "N ready tasks per agent" becomes idle capacity plus `ahead`, which also works when the project allows one line
    per agent.
- **Dropped:** requiring tier and gate fields on every `add`. That is a project's prompt convention, not something the
  planner should require.
