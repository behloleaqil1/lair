# Planner act mode and the ready backlog

- **Status:** §8 PRs 1 (act safety) and 2 (readiness report) are built; PRs 3-6 are design. [planner.md](planner.md)
  describes what is built.
- **Base:** main `8181543`. Every file:line below was checked on that commit (the cited files are the same as on
  `0debc32`). It includes AI spend G6 (#322, merged `99ba9209`) and the verifier's PR ownership check (#308, merged
  `4f62b7f`).
- **Issues:** #243 (act mode: verified proposals apply, stay ahead, race guard), #96 and #252 (act mode put back outside
  edits to the tasks file), #97 (the same proposal in consecutive runs), #298 (an owner request proposed again after
  its work merged), #166 (no agent idles while ready work exists), #294 (AI spend, whose guard G6 is the planner's
  guard set). #290 (the verifier accepted a DONE line naming another task's PR) is closed by #308.
- **Related:** [planner.md](planner.md) (what is built, including its "Guards" and "PR ownership of finish proposals"
  sections), [ai-spend.md §4.5 G6](ai-spend.md) (four planner guards), [work-store.md](work-store.md) (tasks move into
  Lair's database later; the rules here move with them). This spec replaces the earlier draft in PR #244, which closes
  when this spec merges. §10 lists what it keeps from that draft and what it drops.

The planner already keeps fill's tasks file in step with the plan, the queue and the owner's messages. Its model
proposes, Lair checks the proposals, a verifier reviews them, and the approval rules decide what applies. In practice
every project runs it in `observe`, where every proposal waits for the owner. This spec covers four things:

1. **A ready backlog.** The planner keeps enough ready task lines for the agents that can start now. It no longer
   waits for an agent to go idle before it plans.
2. **Specs first.** A new feature becomes a spec task first. Its build task is ready only after the spec's PR has
   merged.
3. **Guards that make act mode safe.** G6 (merged) plus three more, and an act-mode config rule. The 31 Oct failure,
   where act mode overwrote the tasks file, can't happen again, and a line the owner removed, undid or declined is not
   proposed again for 7 days and never comes back without the owner's approval.
4. **When to switch to act.** Lair collects the evidence for switching from `observe` to `act` and shows it. The
   switch stays a config change that the owner makes.

Every new part has a mode, `off`, `observe` or `act`. Each one ships as `off` and is turned on in `observe` first.

## 1. Why: what went wrong

### 1.1 Act mode overwrote the tasks file (31 Oct)

One deployment ran the planner in `act` mode while the operator, and an orchestrating agent working for them, kept
editing the same tasks file. That was before G6. What happened (#96, #252):

- In act mode Lair treated the content it last wrote as the true file. When the file changed while a planner run was
  active, Lair wrote its own version back over it. On main this restore path still exists and runs whenever
  `guards.recheck_on_change` is not `act` (`src/server/planner/service.ts:634-694`, the write at `:637`).
- The decision about it has the key `tamper:<run id>` (`service.ts:667`), so a run raises it only once. The owner was
  told about the first restore. Later edits during the same run, made minutes apart, were put back with no further
  notice.
- That decision also sets `cause_cleared: restored.ok` (`service.ts:689`), so it can close by itself once the file
  has been put back.
- **Eleven new task lines were lost.** Lines the owner had taken away from agents came back, along with stop notes
  that had been removed. Agents went back to work they had been told to stop.
- The run's proposals were refused as well. So the owner's edits were lost and the planner's run was wasted.

**The cause:** Lair's last-known text won over a newer edit by a person. The edit was safe from a lost-update race,
because writes compare the file's hash first (`src/server/planner/files.ts:147-150`). The restore path is what
overwrote it, and it did so on purpose. Act mode was also switched on without any evidence that the planner was ready
for it, and while another writer was active.

**Since then:** G6 `recheck_on_change: act` keeps the edit instead (`service.ts:604-633`): it records the edit with its
diff as an `external` change, raises one notice per run (`guardNotice("planner_recheck_on_change", "run:<id>")`,
`service.ts:620`), and checks each of the run's proposals against the file as it is when the run ends. What is still
missing is a rule that act mode can't run without it (§4.3), and a guard against the planner putting back a line the
owner removed between runs (§4.3, refusal window).

### 1.2 Observe mode is slow and mostly wasted

- **Waiting.** Owner directive, 31 Oct (#243): 36 % of proposals were applied in the end, only 11 % of changes to the
  tasks file came from the planner, and each proposal waited 10 to 50 minutes for an answer. Agents sat idle during
  that wait.
- **Refusals.** The 48 hours to 2 Nov ([ai-spend.md §1](ai-spend.md)): 19 planner runs, 45 proposals, 8 applied
  (18 %). The verifier declined 20, and Lair's rules refused 17.
- **Why they were refused.** Most of them proposed work that was already done: closed task ids, and an owner request
  that had been carried out days earlier (#298). G6 `prefilter_closed` and `handled_messages` now address this.
- **Whole runs lost.** 9 runs were refused whole because the tasks file changed while they ran. G6
  `recheck_on_change: act` now addresses this.
- **Duplicates.** Two runs 40 minutes apart proposed the same two `add`s, which left two identical pending decisions
  (#97). Nothing addresses this yet.
- **Wrong PR.** A `finish` was approved because the PR named in a DONE line existed and had merged, but it was another
  task's PR (#290). #308 now checks PR ownership (`src/server/planner/pr-ownership.ts:116-135`).

### 1.3 The planner reacts too late

- **It plans only after an agent is idle.** The `idle` trigger fires when an allowlisted agent has no active run and
  no open line (`service.ts:995-1007`). A planner run then needs `debounce_seconds` (`config.ts:138`), the run itself,
  the verifier and the approval before the agent gets a line. In observe mode that took tens of minutes.
- **Unassigned lines go unused.** Fill already treats these lines as ready work for any agent
  (`src/server/agents/fill.ts:987-1035`, `unassignedLine`) and raises a notice when an agent is idle while ready work
  exists (`fill.idle`, `src/server/agents/config.ts:158-169`). But nothing hands such a line to the idle agent.
- **It ignores phases and owner markers.** Nothing reads the plan's phase order or a plan line that is marked for the
  owner only. `orderTasks` (`src/server/planner/context.ts:43-48`) ranks tasks only by trigger and by `ready`.

## 2. What exists today

Found with `git grep -n` on main `8181543`, one path at a time, over `src/server/planner`, `src/server/agents`,
`src/shared` and `docs/design/planner.md`. Searched keywords: idle, ready, restore, tamper, recheck_on_change,
prefilter_closed, guardNotice, auto_apply, approval, unassigned, phase, spec, pending, declined, duplicate, undo,
mergedPrs, ownMergedPr, checkPrOwnership, nameOf, startable, readyPlanTasks.

| What | Where | What it does | What is missing |
|---|---|---|---|
| Planner modes | `src/server/planner/config.ts:196` `mode: observe \| act` | `observe` applies nothing by itself: each rules change is recorded once as `planned` (`docs/configuration.md:3189`; `service.ts:768`), and every proposal waits for the owner; one the owner approves is written (`service.ts:2378`, then `writeTasksFile` at `:575`). `act` also writes the rules' changes and auto-applied proposals (`writes`, `service.ts:340-342`) | One switch for everything. No evidence report, no per-part modes |
| Approval per op | `config.ts:215-225` | `add` and `reword` default to `never`. In act an op set to `never` applies by itself when there is no verifier, or when the verifier approved it and it is in `auto_apply`, or it is in `skip_ops` (`service.ts:2040-2060`). The other ops default to `always` | Kept as is |
| Verifier auto-apply | `config.ts:156` `verifier.auto_apply`; `config.ts:483-488` (`drop` never allowed) | Verifier-approved ops in this list apply in act mode | Kept as is |
| Compare-and-swap write | `src/server/planner/files.ts:147-150` `writeTasksFile(path, text, expectHash, maxBytes)` | Writes atomically, and only if the file still has the expected hash | Kept as is. Every write in this spec goes through it |
| G6 guards | `config.ts:172-191` `GuardsSchema` (`prefilter_closed`, `handled_messages`, `skip_unchanged`, `recheck_on_change`, each `off`/`observe`/`act`, default `off`); `config.ts:589-601` (a guard not `off` needs `agents.spend.enabled`); `docs/design/planner.md:319-357` | Merged (#322). Closed work leaves the context, a handled owner message is not proposed again, an unchanged run is skipped, an outside edit during a run is kept | Act mode does not require any of them (§4.3) |
| Outside edit during a run | `service.ts:595-709` `watchTasksFile`: kept at `:604-633` with `recheck_on_change: act`, restored at `:634-694` otherwise | With `act`: the edit is kept and recorded, one notice per run (`:620`). Otherwise: the edit is overwritten and the run's proposals are refused, one `tamper:<run>` decision per run (`:667`) | The restore still runs in act mode when the guard is `off` or `observe` (§4.3 closes this) |
| Guard notice | `service.ts:1519-1543` `guardNotice` | One `attention: notice` item of class `planner.guard_notice` per guard and streak, also after a restart | Kept as is. It is the one notice per run (D3) |
| Guard events | `service.ts:1509-1517` `guardEvent` (`guard_would` / `guard_did` through the agents module) | Written only when a guard fires | No record of a guard's mode over time (§4.4 adds one) |
| Closed work for the model | `src/server/planner/guards.ts:43` `MAX_CLOSED_LISTED = 200`, `:135-139` `contextClosed`; `context.ts:95-99` `closed.mergedPrs` | With `prefilter_closed: act` the context, and so the verifier's prompt (`src/server/planner/verifier.ts:135-158,192-195`), lists the newest 200 merged PRs | With `prefilter_closed` `off` or `observe` the verifier sees no merged PRs (#298) |
| Own-PR matcher (G6) | `guards.ts:103-112` `ownMergedPr` | A merged PR is a task's own when its head branch names the task id, or its READY/DONE line names it | Kept as is. Specs first uses it (§4.2) |
| PR ownership of finish (#308) | `src/server/planner/pr-ownership.ts:116-135` `checkPrOwnership`; `docs/design/planner.md:257-279` | Merged. A finish's PR must belong to the task: branch contains the id, branch maps to the agent, or the title/body names the id | Kept as is. Not used by specs first (§4.2 says why) |
| Idle trigger | `service.ts:995-1007`, `src/shared/planner-types.ts:67` `TriggerKind` | One trigger per new set of idle agents | Reactive only. It knows nothing about capacity or the number of ready lines |
| Plan tasks, ready flag | `service.ts:281-287` `withReadiness` (`ready = !done && waitingOn.length === 0`), `src/server/planner/sources.ts:89-152` (phase from `phase_pattern`) | Reads each plan task's dependencies and phase | Phase order isn't used, and there is no marker to skip a task |
| Context ordering | `context.ts:43-48` `orderTasks` | Tasks named by triggers come first, then ready tasks | No phase order, and no count of how many lines are wanted |
| Add rules | `src/server/planner/proposals.ts:113-114` (`add` needs an agent), `:127-128` (an existing line or a done id is refused) | Refuses a duplicate line or a reused id | An `add` can't make an unassigned line. Nothing compares a proposal with pending ones (#97), or with one the owner undid or declined |
| Proposal outcomes | `src/shared/planner-types.ts:118` `ProposalStatus` (`pending`, `applied`, `rejected`, `declined`); `service.ts:2401` (owner declines, `decidedBy` the owner), `:2079` (verifier declines, `decidedBy: "lair:verifier"`) | An owner decline is recorded on the proposal | Nothing reads it when a later run proposes the same thing (§4.3) |
| Line names | `service.ts:1719` `nameOf` (the agent's configured name, else the agent id); `proposals.ts:161` | Fills the `<name>` field of an `add` or `reassign` line | Kept as is. The assign rule uses it (§4.1) |
| Unassigned lines | `src/server/agents/fill.ts:726-736` (line format `<agent>\|<name>\|<task>\|<desc>`, an empty agent field is unassigned), `:987-1035` `unassignedLine` (claim check at `:1011-1015`) | Ready work for any agent while open. Fill never starts it | No rule assigns one to an idle agent |
| Idle notice | `src/server/agents/config.ts:158-169` `IDLE_READY_SOURCES = ["tasks_file"]`, `fill.idle.notice_minutes` (0 = off) | One notice per idle episode while ready work exists | Ready work comes only from the tasks file. The plan is not a source |
| Fill holds and capacity | `fill.ts:176` `OWNER_HOLDS`; `src/server/agents/config.ts:217` `fill.max_active`, `:199` and `:957` `capacity.heavy_work.max_active`, `:172` `AgentClass` (local agents held by load) | Fill decides inside `AgentsFill` (`fill.ts:1183`) whether it starts a line | No exported answer to "which agents would fill start now" (git grep `startable` in `src/server`: none) |
| Prompt files | `src/server/agents/config.ts:215` `prompt_files`; `:1013-1014` (placeholders `prompts_dir`, `agent`, `task`) | Builds the prompt for a run | No placeholder for the kind of task |
| Task types | `src/shared/server-types.ts:55` `TaskType` | This is the scheduler's job type (build, review, gate…), not a planner task kind | No planner task kind exists |
| Run caps | `config.ts:141` `agent.max_runs_per_day` (24), `:152` `verifier.max_runs_per_day` (48) | Hold any trigger kind's run once reached | Kept as is. They bound a new `backlog_low` trigger too |
| History and routes | `src/server/planner/store.ts:595` `addChange`, `:626` `listChanges`, `:26` `SCHEMA_VERSION = 2`; `src/server/planner/routes.ts:113` `GET /api/planner/history`; `src/server/human-auth/cors.ts:32` (`/api/planner` is owner-only) | Every change has a history row with its diff | No undo of an applied change |

## 3. Gaps

1. Act mode can run without G6 `recheck_on_change: act`, and then the restore path still overwrites an outside edit
   (#96, #252).
2. Act mode can be turned on with no evidence that it is safe, and while another writer is editing the file.
3. A line the owner undid or declined can be proposed again by the next run, and in act mode an `add` applies by
   itself.
4. The planner plans only after agents are idle. Nothing keeps a number of ready lines ahead of demand (#166, #243).
5. Unassigned ready lines are never given to an idle agent.
6. Phase order and owner-only or blocked markers in the plan are ignored.
7. A new feature has no spec step. Its build task can be proposed and started before anyone has written or approved a
   spec.
8. A proposal identical to a pending one is proposed again (#97).
9. With `prefilter_closed` not in `act`, the verifier sees no merged PRs (#298).
10. An applied change can be undone only by editing the file by hand.

## 4. Design

### 4.1 The ready backlog (`planner.backlog`)

**Definitions.** Lair computes these on every planner cycle. Capacity comes from fill itself, so that it can't drift
from what fill actually starts.

- **Fill's answer (new).** `AgentsFill` exports `capacityNow(): { startable: string[]; freeSlots: number }`, computed
  by the same code fill's tick uses to decide a start, with every hold fill applies: no active run or claim, not
  paused or held (`OWNER_HOLDS`), not cooling down after a failover or a quota error, `fill.max_active`,
  the load hold on `local` agents, spend budgets, and `fill.enabled`. The planner
  reads it through the agents module, as it already reads the agents store. With fill off it is
  `{ startable: [], freeSlots: 0 }`.
- **Startable agent:** an agent in `capacityNow().startable` that is not the planner or the verifier: fill would start
  it now if it had an open line that is not heavy work. Heavy work is judged per task (`fill.ts:3144` `isHeavyTask`,
  checked at `:3133`), so `capacityNow()` does not hold an agent back for `capacity.heavy_work.max_active`; a heavy
  line beyond that limit waits in fill as it does today.
- **Free slots:** `capacityNow().freeSlots`.
- **Idle capacity:** the smaller of free slots and the number of startable agents.
- **Ready line:** an open line in the tasks file that fill will start once its agent is free:
  - assigned to an allowlisted agent other than the planner or the verifier, with no active run or claim on its task,
    no hold, and not done (a line for a busy agent counts: it is the margin `ahead` keeps); or
  - unassigned and ready according to `unassignedLine`, **only while `backlog.assign` is `act`**. Otherwise no rule
    gives it to an agent, and counting it would let unassigned lines satisfy the deficit while every agent stays idle;
    or
  - a pending `add` (any source, any run) that would make such a line once approved. It counts until it is approved
    or declined, so a shortage that pending adds already cover does not start another paid run that proposes them
    again (#97), whatever `dedupe_pending`'s mode.
- **Target:** idle capacity plus `ahead`. `ahead` keeps a margin of lines for agents that are about to finish.
- **Room:** how many new lines can be written where fill will start them. Unlimited while `unassigned: true` (and so
  `assign` is on). Otherwise the allowlisted agents (not the planner or the verifier) that may take another line: all
  of them, or, when fill's patterns allow one line per agent (`onePerAgent`, `config.ts:659`), only those with no
  open line.
- **Deficit:** the smaller of (target minus ready lines, never below 0) and room. With no room the deficit is 0, so no
  trigger fires for lines nobody could start.

**Trigger.** A new trigger kind, `backlog_low` (added to `TriggerKind`), fires when the deficit is above 0. It is
deduplicated by a fingerprint of the deficit and the set of ready plan task ids. A cycle with the same shortage does
not trigger again, and an edit that leaves the same shortage is not a new reason to plan. The existing `idle` trigger
stays. Runs it starts are held by `agent.max_runs_per_day` like any other trigger.

**What the run is told.** The context gains `backlog: { idleCapacity, readyLines, target, want }`. `want` is the
deficit, capped at `max_adds_per_run`. One rule line in Lair's appended instructions says: "propose up to `want`
`add`s from ready plan tasks, in phase order". With `backlog.unassigned: false` it adds "each `add` names one of
these agents: <the agents that have room>", a list that is never empty while `want` is above 0.

**Phase order and markers.** The planner orders and filters plan tasks before it builds the context:

- **Phase order.** With `phase_order: strict`, a plan task is offered only when no earlier phase has an open task that
  is not marked skipped. Phase order is the order in which the phases first appear in the plan files. A plan task with
  no phase (no heading matched `phase_pattern`) is in no phase: phase order neither holds it back nor waits for it.
- **Skip markers.** A plan task whose text matches `skip_pattern` (default `\[(owner-only|blocked)\]`,
  case-insensitive; a bracketed marker, so that "no longer blocked" in a task's text does not match) is never offered
  or proposed. It doesn't hold back later phases.
- **Closed work.** G6 `prefilter_closed` removes closed work first.
- **Already in the file.** A plan task whose id has an open or done line in the tasks file is not offered (an `add`
  of it would be refused, `proposals.ts:127-128`).
- **Undone, declined or removed by the owner.** A plan task with a hold (§4.3, refusal window) is not offered.

The planner exposes the result as `readyPlanTasks(): PlanTaskView[]` (new; git grep finds no such name). Fill's idle
notice reads it (below). It is empty when the planner or `backlog` is off. (`planner.backlog` is this new block; it is
unrelated to the existing `backlog_file` plan source kind, `config.ts:87-89`.)

**Unassigned adds.** With `backlog.unassigned: true`, an `add` may omit `agent`. The line is then written in the
unassigned form that fill already parses. This keeps two jobs apart: the model decides **what** is next, and the rule
below decides **who** takes it. `backlog.unassigned: true` needs `backlog.assign` other than `off` (a load error
otherwise), because without the rule no agent ever starts such a line. `backlog.mode: act` with `unassigned: true`
needs `backlog.assign: act` (a load error otherwise): unassigned lines count as ready only when the rule assigns
them, so with `assign: observe` an add never reduces the deficit and `backlog_low` fires again.

**The assign rule (`backlog.assign`, deterministic, no model).** On each cycle:

1. Take each startable agent with no open line, in allowlist order.
2. Give it the first ready unassigned line, in file order, for which no refusal record of op `assign` names this agent
   (an owner's Undo of an assignment). Such a line goes to the next agent instead.
3. Write the agent and its name into that line. The name is `nameOf(agent)` (`service.ts:1719`): the agent's
   configured name, or the agent id when it has none.

Each assignment is one history row with source `rules`, op `assign`, and before and after lines. It is written through
the compare-and-swap write. A line that a run or claim holds is skipped (`unassignedLine`'s claim check). Before each
write the rule records an intent in `planner_state`; a restart finishes or drops it by re-reading the line, as the
planner's existing intent replay does (`service.ts:526`, `finishIntent`).

**The rules source (`backlog.source: rules`).** For projects whose plan is precise enough, Lair fills the deficit
without a model. It takes the first `want` tasks of `readyPlanTasks()` and appends them as unassigned lines (so it
needs `unassigned: true`, and with it `assign` on):

- the id is the plan id;
- the description is the plan text, cleaned and cut to 500 characters.

These lines go through the same checks as a model's `add`, including the refusal window (§4.3), as proposals with
source `rules`. The verifier is asked only when `backlog.verify_rules: true`. A rules `add` applies by itself only
when `planner.mode` and `backlog.mode` are both `act`, `approval.add` is `never`, no refusal record or hold names it,
and, with `verify_rules: true`, the verifier approved it (`add` need not be in `auto_apply`: a rules add is treated
like an op in `skip_ops`, `service.ts:2052`). Otherwise it waits for the owner.
With `source: model` (the default), the model proposes, as it does today.

**Bounds.** At most `max_adds_per_run` adds per run or rules cycle, and at most `max_adds_per_hour` **applied** adds
per project across both sources, in any rolling hour. `max_adds_per_run` is checked when a run's proposals come in:
adds past it are refused then, so a run never has more pending adds than the cap. `max_adds_per_hour` is checked when
an add would apply: at the end of the run for one that applies by itself, and at the owner's approval for one that
waits. An add beyond either limit is refused
with the reason; an owner approval of the 11th add in an hour returns that reason and leaves the proposal pending, so
the owner can approve it later. The existing caps still apply: 200 tasks and 256 KB.

**Observe.**

- **Writes nothing.** `backlog.mode: observe` writes nothing, and the assign rule only records `would_assign`.
- **Rules source:** records `would_add` with the task ids.
- **Once each.** A `would_add` is recorded once per task id, and a `would_assign` once per task id and agent, until
  that task gets a line (the keys are kept in `planner_state`, newest 1,000). A refusal by a cap (`max_adds_per_hour`,
  above) is recorded once per streak of cycles that hit the cap, not once per cycle.
- **Model source:** the trigger fires, and the `add`s of a run that a `backlog_low` trigger started always wait for the
  owner, even with `planner.mode: act` and `approval.add: never`. Only `backlog.mode: act` lets them apply by
  themselves.

**Fill's idle notice.** `IDLE_READY_SOURCES` (`src/server/agents/config.ts:159`) gains `plan`. With it, fill counts
`readyPlanTasks()` as ready work, so the notice says "idle while the plan has ready work". This closes #166 item 1 for
the plan source.

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
  Approved means that `X-spec`'s own PR has merged, found with G6's `ownMergedPr` (`guards.ts:103-112`): a merged PR
  whose head branch names `X-spec`, or the merged PR that `X-spec`'s READY or DONE line names. Merged means merged
  according to the review store. A DONE line without a merged PR does not count.
- **Why not `checkPrOwnership`.** #308's matcher (`pr-ownership.ts:116-135`) also accepts a PR whose title or body
  names the task id, or whose branch maps to the task's agent. A build PR whose body says "implements the spec from
  X-spec" would then count as the spec's merge. Specs first uses `ownMergedPr` only.
- **After the merge.** `X` becomes ready and is offered like any other task. Its context details gain the spec's path,
  so the build task points to the spec: the first `link_pattern` match in `X-spec`'s DONE line, else in `X`'s plan
  text. The review store keeps no changed files of a PR (`MergedPr` is `pr`, `branch`, `at`, `guards.ts:28-34`), so
  the path is not read from the PR. With no match the details say "spec merged in PR #<n>".
- **The prompt.** Fill gains a `{kind}` placeholder in `prompt_files` (added to the allowed placeholders at
  `src/server/agents/config.ts:1014`). It is `spec` when the task id ends in `spec_first.suffix` and `build` otherwise.
  A project can then add a file such as `{prompts_dir}/kinds/{kind}.md`. A file whose template contains `{kind}` and
  doesn't exist is skipped, so that projects without kind files keep working. Every other missing file still fails as
  today.
- **A stalled spec.** A spec task whose PR has been open for longer than `stall_hours` (default 48) raises one notice
  per task. The planner never skips the spec by itself.
- **Observe.** `spec_first.mode: observe` changes nothing. Each cycle it records `would_spec` for every plan task it
  would route through a spec. The record is once per task, kept in `planner_state`.

### 4.3 Guards that act mode requires

**G6 (merged, #322).** Not specified again here. The parts this spec relies on:

- `recheck_on_change: act` keeps an outside edit during a run, records it with its diff, raises one notice per run,
  and checks each proposal against the current file (`service.ts:604-633`). **This is the fix for §1.1**, once act
  mode requires it (below).
- `prefilter_closed` keeps closed work out of the context.
- `handled_messages` stops a carried-out owner request from coming back.
- `skip_unchanged` saves a run whose inputs haven't changed.

**New in this spec:**

- **Refusal window for undone, declined and removed changes** (`planner.act.refuse_undone_days`, default 7, 0 = off;
  D2). Lair records a refusal when:
  - the owner undoes an applied change (Undo, below);
  - an outside edit removes a task's open line, **whatever its age** (the edit's diff takes out the line and no line
    with that task id is left; a line turned into a done line is not a removal); or
  - an outside edit changes back a line the planner wrote: the task id stays, and the line's description or agent goes
    back to what it was before the planner's change (recorded as that change's op, `reword` or `reassign`, with the
    planner's text). Any other hand edit of a line is not recorded; or
  - the owner declines a proposal (status `declined`, `decidedBy` not starting with `lair:`, `service.ts:2401`; this
    includes the owner's "follow the verifier" answer, `service.ts:2398`).

  The record is `{op, task, textHash, planTextHash, at, why}`, keyed by op, task id and `sha256` of the cleaned text
  (the line description for `add` and `reword`, the agent id for `reassign` and `assign`, empty for the other ops; an
  outside removal is recorded as op `add` with the removed line's description). `planTextHash` is the `sha256` of the
  task's plan text at the time of the record (empty when the task is in no plan source); the hold below compares it,
  never `textHash`, because a line's description is rarely the plan's exact text. It is kept in `planner_state` under `refused`,
  newest 1,000 (like `handled_messages`, `service.ts:157-158`). It is written in the same `exclusive()` step as the
  change or decision that causes it; for a file write it is part of that write's intent, so the intent replay
  (`service.ts:526`, `finishIntent`) writes it after a restart. While a record is younger than the window:
  - a proposal with the same op, task and text hash is refused with the reason "the owner undid (or declined, or
    removed) this on <date>: not proposed again for N days", from every source (model, rules, assign rule);
  - a proposal with the same op and task but other text is not refused, but it never applies by itself: it waits for
    the owner, with the record named in its reason;
  - the refusals are counted in the readiness report (§4.4).

  **Hold.** Every record of op `add` (an undone add, a declined add, a line removed by hand) also puts a hold on its
  task that outlives the window: until the task's plan text changes (its `sha256` differs from the record's
  `planTextHash`), or the owner adds or approves a line for it again, `readyPlanTasks()` doesn't offer it, the context
  marks it "the owner undid (declined, removed) its line on <date>", and an `add` of it never applies by itself (it
  waits for the owner). So a line the owner removed, undid or declined never comes back without the owner's approval;
  for the window it isn't even proposed. A task in no plan source keeps its hold until the owner adds or approves a
  line for it.

  The records and holds are kept in `planner.mode: observe` as well, so a project that switches to act already has
  them. This closes the loop where an undo or a removal raises the deficit, `backlog_low` fires again, and the same
  `add` comes back (bounded until now only by `max_adds_per_hour` and `max_runs_per_day`). The window is a guard that
  only refuses or holds and never writes, so unlike the new parts it is on by default (D2); `0` turns it off.
- **Pending duplicates** (`guards.dedupe_pending`, #97). A proposal whose `op`, `task` and `agent` match a proposal
  still pending from an earlier run is refused with the reason "already pending as proposal <id> of run <run>". For a
  `reword`, the text is compared as well. In observe, it is recorded as `would_refuse` and kept.
- **Merged PRs for the verifier** (#298, second half). With `prefilter_closed: act` the verifier already gets the
  newest 200 merged PRs through the planner's context (`closed.mergedPrs`, `guards.ts:135-139`, embedded by
  `verifier.ts:192-195`). With `prefilter_closed: observe`, the verifier's context alone gains the same block, from
  the same source and with the same limit (`MAX_CLOSED_LISTED`). The planner's own context is unchanged. With
  `prefilter_closed: off` neither context has it: off is today's behaviour (§8, every part off by default; AT-20's
  verifier half is checked with `observe`). This is data only: the verifier still decides.

**Notices for outside edits (D3).** One notice per planner run, which is G6's existing `planner_recheck_on_change`
notice (`service.ts:620`, deduplicated per run by `guardNotice`). Each further edit in the same run raises no notice
but is kept and recorded as its own `external` history row with its diff, so nothing is lost silently: §1.1's silent
repeats were silent *overwrites*, and with the guard in act nothing is overwritten. No per-edit notice is added.

**Config rules for act mode.** These are checked at load and on reload, and each message names the keys:

- `planner.mode: act` requires `guards.recheck_on_change: act`. Without it the restore path can still overwrite an
  outside edit.
- `planner.mode: act` requires `guards.prefilter_closed` and `guards.dedupe_pending` to be at least `observe`.
- These two rules **warn** in the first release that has them (a load warning plus one `attention: notice` item of
  class `planner.act_rules` per project and config text, naming the keys to set; D1), and **refuse** from the next
  release. The switch between the two is one constant, changed in its own PR. Existing `act` installs keep working
  through one release.
- `backlog.mode: act`, `backlog.assign: act` or `spec_first.mode: act` while `planner.mode` is `observe` is refused at
  once (new keys, so no install has them). Observe writes nothing, so those settings would be a no-op that looks
  active.
- `backlog.unassigned: true` with `backlog.assign: off`, `backlog.mode: act` with `unassigned: true` and
  `backlog.assign` other than `act`, and `backlog.source: rules` with `unassigned: false`, are refused (§4.1).
- A new part set to anything other than `off` requires `agents.spend.enabled`, as G6 does (`config.ts:589-601`),
  because the evidence counts (§4.4) come from spend.

**Migration for an install already in `planner.mode: act`.** Set, in this order:

1. `agents.spend.enabled: true` (G6's guards need it);
2. `planner.guards.recheck_on_change: act`;
3. `planner.guards.prefilter_closed: observe` (or `act`) and `planner.guards.dedupe_pending: observe` (or `act`).

The release notes and the load warning name these keys. A project that doesn't set them before the following release
fails to load its planner with the same message.

**Undo.** `POST /api/planner/changes/:id/undo` (owner only: under `/api/planner`, `cors.ts:32`; body `confirm: true`)
reverses one applied change:

- `add`: removes the added line. `reword` and `reassign`: restores the `before` line. `finish` (`mark_done`, which
  prefixes the done marker, `tasks-file.ts:113-116`): restores the line without the marker. `assign`: makes the line
  unassigned again. `drop` and outside edits can't be undone here (409, "edit the file"). Neither can a change made by
  the deterministic rules (source `deterministic`, the queue's done lines, `service.ts:738-749`): the next cycle would
  mark the line done again from the same queue line (409, naming the queue line).
- Only when that line is still exactly as the change wrote it, through `writeTasksFile`.
- Not while the line's task has an active run or a claim (the same check as `fill.ts:1011-1015`), and not for an `add`
  whose task already has a done line: 409 with the reason, so an agent's run is never left without its line.
- It runs inside the planner's `exclusive()` step (as decisions do, `service.ts:2363`) and records an intent before
  the write, so the line, the `undo` history row that points to the change, and the refusal record (above) are all
  written, also across a restart (`finishIntent`).
- It is idempotent: undoing an undone change returns the earlier undo row.
- Otherwise it returns 409 with the reason.

The Planner view shows an Undo button on each applied change that can be undone.

### 4.4 The evidence to switch from observe to act

Turning a part to `act` stays a config change by the owner. Lair never switches a mode by itself. To support that
choice, Lair computes a readiness report for each part over the last `act_evidence.days` days (default 7). It reads
only `planner.db` and the spend events, and is shown by `GET /api/planner/readiness` (owner only) and in the Planner
view. Like every new part it is behind a switch, `act_evidence.enabled` (default `false`): off, Lair keeps no mode
history, the route answers 409 and nothing warns. Turn it on together with the parts' `observe`.

The `would_add`, `would_assign` and `would_spec` records the report counts are kept in `planner_state` under
`act_evidence` (the newest 2,000), each `{kind, task, agent, at, planText, specLink}`, written by the part that would
have acted (PRs 3-5). A `would_add` fails when its `planText` matches the skip marker or its task was done by `at`; a
`would_spec` fails when the part found a merged spec link (`specLink`).

**Mode history (new).** At the first cycle of every config load and reload, the planner appends `{at, planner.mode, each guard's mode,
each part's mode}` to `planner_state` under `mode_history`, only when it differs from the newest entry, newest 200.
The report reads it for criterion (5) and to find when a part was switched to act.

| Part | Ready when (all hold) |
|---|---|
| `planner.mode: act` | (1) at least `min_samples` (20) proposals in auto-applied ops were verified; (2) of those the verifier approved, the owner approved at least `min_agreement` (0.9); (3) no more than one `would_refuse` from `dedupe_pending` per day; (4) no more than one refusal-window refusal per day; (5) `mode_history` shows `recheck_on_change` in `observe` or `act` for the whole window |
| `backlog.mode: act` | At least `min_samples` `backlog_low` triggers (counted from PR 3, which adds the trigger) or `would_add` records, and at least `min_agreement` of the would-add task ids were later added by the owner or approved. None was a closed or skipped task |
| `backlog.assign: act` | At least `min_samples` `would_assign` records. At least `min_agreement` of them match the assignment that happened next (by the owner or by an approved proposal); a record with no later assignment is not counted either way |
| `spec_first.mode: act` | At least `min(5, min_samples)` `would_spec` records (marked tasks are few, so 20 could take months), and none of them for a task that already had a merged spec link (a false positive) |

**After the switch.** For a part whose newest `mode_history` entry is `act`, the report adds a check over the time
since that entry: no change the planner applied was undone by the owner or **edited back** within 24 hours. Edited
back means an outside edit whose diff removes the line the change wrote or changes it to something else. This check
can't hold anything in observe, where nothing is applied, so it is not a readiness criterion; when it fails, the row
says **switch back recommended** and lists the changes.

Each row shows its counts, the samples that failed, and **ready**, **not yet** or **switch back recommended**. A part
set to `act` whose row says **not yet** gets a load warning and one notice, but it is not refused. The owner may know
something the numbers don't. The report is read-only and has no side effects.

### 4.5 What the planner still can't do

- Apply `finish`, `reassign`, `drop` or `unblock` without the owner, unless the owner adds them. `drop` can never be
  added. Approval defaults are unchanged.
- Write over a newer file. Every write compares the hash, and in act mode the restore path is gone once the act rule
  refuses (§4.3).
- Propose again, for the refusal window, a change the owner undid, declined or removed, or apply by itself an `add` of
  a task whose line the owner undid, declined or removed until its plan text changes.
- Skip a spec, or start a build whose spec PR hasn't merged.
- Propose a task marked owner-only or blocked, or a later-phase task while `strict` holds.

## 5. Configuration

```yaml
planner:
  mode: observe                    # existing; act needs the rules in §4.3
  act:
    refuse_undone_days: 7          # 0-90; 0 = off. Refusal window for undone, declined or removed changes
  backlog:
    mode: off                      # off | observe | act
    ahead: 2                       # lines beyond idle capacity (0-20)
    source: model                  # model | rules (rules needs unassigned: true)
    unassigned: false              # an add may leave the agent empty; needs assign not off
    assign: off                    # off | observe | act: give idle agents the first ready unassigned line
    phase_order: strict            # strict | none
    skip_pattern: '\[(owner-only|blocked)\]'
    max_adds_per_run: 5            # 1-50
    max_adds_per_hour: 10          # 1-200, applied adds
    verify_rules: false            # ask the verifier for rules-sourced adds
  spec_first:
    mode: off                      # off | observe | act
    scope: marked                  # marked | all_new
    marker_pattern: '\[spec\]'
    link_pattern: 'docs/(design|specs)/[^\s)]+\.md'
    suffix: "-spec"
    stall_hours: 48                # 1-720
  guards:                          # G6 (config.ts:172-191) plus:
    dedupe_pending: off            # off | observe | act
  act_evidence:
    enabled: false                 # the mode history, the report and its load warning
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

## 6. Decisions

- **D1 (owner decision).** The act-mode load rules (`recheck_on_change: act`, `prefilter_closed` and
  `dedupe_pending` at least `observe`) **warn** on existing installs in the first release that has them, and
  **refuse** from the next release. Rules on new keys refuse at once.
- **D2 (owner decision).** An add the owner undid or declined is not proposed again or applied by itself for
  **7 days**, keyed by task id plus text hash (and op), config `planner.act.refuse_undone_days`. It is on by default,
  unlike the new parts, because it only refuses or holds. A task whose line the owner undid, declined or removed by
  hand also gets a hold
  (§4.3).
- **D3 (owner decision).** **One notice per planner run** for outside edits, which is G6's existing notice. Not
  one per edit.
- **D4.** Capacity is fill's own answer (`capacityNow()`), not a copy of fill's rules in the planner.
- **D5.** Specs first uses G6's `ownMergedPr`, not `checkPrOwnership` (§4.2).
- **D6.** PR #244 is superseded by this spec and closes when it merges.

## 7. Acceptance tests

Each test drives `PlannerService` through its real cycle, with the harness in `src/server/planner/testing/harness.ts`
(fake process table, spawner and clock only). The fake boundary named per test is the agent run (a fixed
`proposals.json`, written the way the agents module leaves it), plus the review store for merged PRs. Each test also
covers its negative cases.

| AT | Given | When | Then |
|---|---|---|---|
| AT-1 | `mode: act`, `recheck_on_change: act`, `prefilter_closed: observe`, `dedupe_pending: observe`, `agents.spend.enabled: true` (so no act-rule warning). Planner run R is active. The owner adds 3 lines; a cycle runs; 2 minutes later the owner removes one line; a cycle runs (the fake clock drives both cycles) | R ends with 2 proposals: `reword` of the task whose line the owner removed, and `add` of a new task `t9` | The file keeps both of the owner's edits, and nothing is written back. Exactly one inbox item of class `planner.guard_notice` for R, and two `external` history rows, each with its diff. The `reword` is refused with the reason that the task has no open line; the `add t9` applies on top of the edited file. A removal record and hold exist for the removed task |
| AT-2 | `mode: act`, `recheck_on_change: observe` | Config load, with the rule in warn mode, then with it in refuse mode | Warn mode: the planner loads, one load warning and one notice of class `planner.act_rules` naming `planner.mode` and `planner.guards.recheck_on_change`; a reload raises no second notice. Refuse mode: refused with the same keys |
| AT-3 | `backlog.mode: act`, `unassigned: false`, fill enabled with 4 allowlisted agents, `fill.max_active: 4`, 1 agent running (the harness's process table), 1 ready line for a busy agent, `ahead: 2` | A cycle | `capacityNow()` gives 3 startable agents and 3 free slots. One `backlog_low` trigger with `want = 4` (3 + 2 − 1). The next cycle with the same state gives no new trigger. A new ready line gives a new fingerprint. With `max_active: 2` (1 free slot), `want = 2`. With fill's patterns one line per agent and every agent holding an open line, room is 0: no trigger |
| AT-4 | The same as AT-3, but `max_adds_per_run: 2`, and the run returns 4 adds | The run ends | 2 apply, 2 are refused with the cap reason. Then with `max_adds_per_hour` reached, further rules cycles add nothing and record the reason once for the streak (10 cycles, one record), and an owner approval of a waiting add returns the reason and leaves it pending |
| AT-5 | `backlog.assign: act`, `unassigned: true`. 2 startable agents with no line, 3 unassigned ready lines, one of them claimed by a run | A cycle | The first two unclaimed lines are assigned, in allowlist order, with the agents' names, by compare-and-swap writes, with 2 `assign` history rows. A restart before the second write finishes it once: no line is assigned twice |
| AT-6 | `backlog.source: rules`, `unassigned: true`, `assign: act`, `phase_order: strict`. Plan: phase 1 has one open task marked `[owner-only]` and one open task `a`; phase 2 has task `b` | A cycle with deficit 2 | Only `a` is added. The `[owner-only]` task is never added, and `b` waits until `a` is done |
| AT-7 | The same as AT-6, with `a` done | A cycle | `b` is added. A plan task whose id is a done id (G6 `prefilter_closed`) is not added |
| AT-8 | `backlog.mode: observe`, `assign: observe`, `source: rules`; then `source: model` with `planner.mode: act` and `approval.add: never` | The inputs of AT-5 to AT-7; then a `backlog_low` run returning 2 adds | The tasks file is byte-for-byte unchanged. `would_add` and `would_assign` are recorded once each. The model run's 2 adds are pending for the owner, not applied |
| AT-9 | `spec_first.mode: act`. Plan task `x` marked `[spec]` | A run proposes `add x`, then `add x-spec` | `add x` is refused with "x needs its spec first (x-spec)". `x-spec` applies with kind `spec` |
| AT-10 | The same as AT-9. `x-spec` has a DONE line, but its PR is still open | A cycle | `x` is not ready (`waitingOn: ["x-spec"]`). After the review store records the PR (head branch contains `x-spec`) as merged, `x` is ready and its details name the spec file from `x-spec`'s DONE line; with no path there, they name the PR |
| AT-11 | The same as AT-10, but the DONE line names a merged PR of another task, and a merged build PR's body names `x-spec` | A cycle | `x` stays not ready, because neither PR is the spec task's own |
| AT-12 | Fill `prompt_files: ["{prompts_dir}/base.md", "{prompts_dir}/kinds/{kind}.md"]`, with only `kinds/spec.md` present | Fill starts `x-spec`, then `y` | `x-spec`'s prompt includes `spec.md`. `y`'s prompt is built without the missing `kinds/build.md`. A missing `base.md` still fails as today |
| AT-13 | `dedupe_pending: act`. Run 1 left `add t1 agent-a` pending | Run 2 proposes `add t1 agent-a` and `add t1 agent-b` | The first is refused as "already pending as proposal …", and the second is checked normally. In `observe`, both are kept and one `would_refuse` is recorded |
| AT-14 | Applied change C added line L | `POST /api/planner/changes/C/undo` with `confirm: true`, twice. Then the same for a change whose line the owner has since edited, for one whose task has an active run, and for a `drop` | The first call removes L and records an undo row and a refusal record. The second returns that same row and changes nothing. The edited, running and `drop` ones return 409 with their reasons. Without an owner session: 403. Without `confirm`: 400 |
| AT-15 | 7 days of planner rows: 25 verified auto-apply proposals, 24 approved by the owner; `mode_history` with `recheck_on_change: observe` from day 2. Also 20 `would_add` records (19 later added by the owner, 1 for a skipped task), 20 `would_assign` records (18 matching the next assignment, 2 with none), 5 `would_spec` records (1 for a task with a merged spec link) | `GET /api/planner/readiness` | `planner.mode` is **not yet**, naming criterion (5). With `observe` for the whole window it is **ready**. After a switch to act with one undo within 24 h, the row says **switch back recommended** and lists the change. `backlog.mode` is **not yet** (the skipped task). `backlog.assign` is **ready** (18 of 18 counted). `spec_first.mode` is **not yet** (the false positive). The route has no side effects, and returns 403 without an owner session |
| AT-16 | `fill.idle.ready_sources: [tasks_file, plan]`, `notice_minutes: 5`. No ready lines, one ready plan task, one agent idle for 6 minutes | Fill ticks | One idle notice that names the plan source. A second tick in the same episode raises nothing. With the planner off, no notice |
| AT-17 | Every new part `off`, `refuse_undone_days: 0`, `dedupe_pending: off`, and the act-rule warning excluded (it is AT-2's; it has its own class `planner.act_rules`, not `planner.guard_notice`) | The inputs of AT-1, AT-3 to AT-14, AT-18, AT-18b and AT-20 | Today's behaviour, unchanged: the same writes, history rows and decisions, and no new notice besides the act-rule warning. In AT-1 with G6 off, today's restore still happens; that is G6's own test, not this spec's |
| AT-18 | `mode: act`, `refuse_undone_days: 7`, no verifier, `approval.add: never`. Run N's `add t1` applied | The owner undoes it; run N+1 proposes `add t1` with the same text, then run N+2 with other text. Separately, the owner declines `add t2` in observe, and the project switches to act. Separately, the owner deletes a 3-day-old planner line `t3` by hand. The fake clock moves to day 8 | N+1's `add t1` is refused with the undo reason and counted. N+2's waits for the owner and names the record. `add t2` is refused in act within 7 days. `add t3` is refused for 7 days. On day 8 an `add` of `t1`, `t2` or `t3` waits for the owner (hold) instead of applying; after the plan rewords `t3`, its `add` is checked normally. A restart between the undo's write and its history row keeps the record exactly once |
| AT-18b | AT-18's records, plus `backlog.mode: act`, `source: rules`, `unassigned: true`, `assign: act` | The undo raises the deficit and `backlog_low` fires; a rules cycle runs; the owner undoes an assignment of line L to `agent-a`, then the assign rule runs | The rules source offers none of `t1`, `t2`, `t3` (on day 8 too, while held). The assign rule gives L to `agent-b`, not `agent-a` |
| AT-19 | Load rules, each alone: `mode: act` with `prefilter_closed: off`; with `dedupe_pending: off`; `backlog.mode: act` with `planner.mode: observe`; `spec_first.mode: act` with `planner.mode: observe`; `unassigned: true` with `assign: off`; `backlog.mode: act` with `unassigned: true` and `assign: observe`; `source: rules` with `unassigned: false`; `backlog.mode: observe` with `agents.spend.enabled: false`; `skip_pattern` of 501 characters | Config load | The first two warn (warn mode) or refuse (refuse mode), naming the keys; each of the others is refused, naming its keys. The defaults load with no warning |
| AT-20 | `spec_first.mode: act`, `stall_hours: 48`, `x-spec`'s PR open for 49 hours; separately `prefilter_closed: observe` with 3 merged PRs in the review store | A cycle; a verifier run | One stall notice for `x-spec`, none on the next cycle, and `x` stays waiting. The verifier's context has `closed.mergedPrs` with the 3 PRs and the planner's context has no `closed` block. With `prefilter_closed: act`, both have it once |

## 8. Build PRs, in order

Each PR is at most about 600 non-test lines and builds and merges on its own. Each one sits behind its switch with
`off` as the default, includes its `observe` and `act` paths, and updates `docs/configuration.md` (planner and fill)
and [planner.md](planner.md).

0. **Already merged, not part of this spec:** G6 (#322, `99ba9209`) and the verifier's PR ownership check (#308,
   `4f62b7f`).
1. **Act safety.**
   - The act-mode config rules (§4.3), in warn mode, and the migration text.
   - The refusal window and its records.
   - `dedupe_pending`.
   - The verifier's merged-PR context when `prefilter_closed` is not `act`.
   - The undo route and its button.
   - ATs 1, 2, 13, 14, 18, 19 (its act-rule part), the verifier half of AT-20, and AT-17 for these parts.
   - AT-18b is built with PR 4 (it needs the trigger, the rules source and the assign rule).
2. **Readiness report.** `mode_history`, `GET /api/planner/readiness`, the counts from `planner.db` and the spend
   events, the after-switch check, the Planner view panel, and the load warning. AT-15.
3. **Backlog: trigger and model source.**
   - Fill's `capacityNow()`.
   - Capacity and deficit, the `backlog_low` trigger kind.
   - The context's `backlog` block and its rule line.
   - Phase order and `skip_pattern` in context ordering, and `readyPlanTasks()`.
   - Unassigned adds and both caps.
   - ATs 3, 4, the model half of AT-8, AT-19's backlog rules, and AT-17.
4. **Backlog: assign rule and rules source.** `backlog.assign`, `source: rules`, `verify_rules`, and fill's `plan`
   ready source for the idle notice. ATs 5-8, 16, 18b.
5. **Specs first.** The `spec` kind, the waiting build task, the own-PR merge check (`ownMergedPr`), the stall notice,
   and fill's `{kind}` placeholder. ATs 9-12, the stall half of AT-20.
6. **Refuse mode for the act rules** (one release after PR 1 ships): flips the constant from warn to refuse. AT-2's
   refuse half.

PRs 3 to 5 depend on PR 1. PR 2 can be built in parallel with PR 3. If any PR needs a `planner.db` schema change, its
`SCHEMA_VERSION` (`store.ts:26`, now 2) is checked against main when it is built; `planner_state` keys need none. On
the operator's install:

1. Set the migration keys (§4.3).
2. Turn the parts on in `observe`, `planner.mode` first.
3. After a week, read the readiness report.
4. Switch each part that shows **ready**, one at a time, `planner.mode` before the backlog and spec parts. This is a
   config change, not a PR.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Act mode applies wrong work faster than an owner can see it | It needs G6 and dedupe active (warn, then refuse). Adds are capped per run and per hour. Every change has a history row and an Undo. The readiness report needs a week of agreement first, and recommends switching back when applied changes are undone |
| A line the owner removed comes back | The refusal window refuses the same change for 7 days and holds a changed one for the owner, from every source. A hold keeps an undone, declined or removed task out of the backlog until its plan text changes, and its `add` always waits for the owner |
| Outside writers and Lair race on the file | Every write compares the hash. A lost race is retried on the next cycle from a fresh read. An outside edit is kept and recorded, never overwritten |
| An upgrade stops an act install from planning | One release of warnings with the keys named before the rule refuses (D1) |
| The backlog counts capacity fill won't use | Capacity is fill's own `capacityNow()`, and unassigned lines count only while the assign rule is in act |
| The assign rule gives a task to an agent that is a poor fit | It assigns only unassigned lines, which the planner or owner left open for any agent. A line with an agent is never reassigned. Projects that need fit leave `assign: off` and let the model assign |
| Unassigned lines pile up and go stale when the plan changes | `drop_plan_done` (`config.ts:207`) drops ticked tasks. The target caps how many lines are added. `max_adds_per_hour` bounds growth |
| Strict phase order leaves agents idle behind one blocked task | Skip markers take owner-only or blocked tasks out of the order. The idle notice names the earlier phase's open task |
| A spec PR never merges, so its build never starts | One stall notice per task after `stall_hours`. The owner can merge, drop or reword. The planner never skips the spec |
| `all_new` asks for specs for small fixes | The default is `marked`. `would_spec` false positives count against readiness |
| The readiness numbers are gamed or misread | They come only from Lair's own stores. The switch stays manual, and a warning shows when act is set before **ready** |

## 10. Relation to the earlier draft (PR #244)

- **Kept:**
  - verified `add`s apply by themselves in act mode (already true by default, `config.ts:215-225`);
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
