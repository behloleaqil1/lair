# Decision brain v3: more rules, a real bench, abstain rules and a local-model shadow trial

- **Status:** design, docs only. Nothing here is built. The owner (or the orchestrator under the owner's delegation) approves this document before any code.
- **Base:** main `0debc32`. Every file:line below was re-checked there.
- **Related:** [decision-policies.md](decision-policies.md) (v1: classes C1-C14, tiers, promotion bars, approved 30 Oct 2026; §10-§12 describe what is built), [ai-spend.md](ai-spend.md) (the run classes behind "exited without done"), [planner.md](planner.md) (the blocked-line classifier), issues #211, #227, #228.

v1 built the machinery: structured evidence on decisions, a policy table, a rule proposer, a trace, an agreement view, a trainer and an outcome tracker. All of it is shadow only. A week of real use shows the built-in rules now answer almost nothing of what people actually answer. The classes that repeat today are not the ones the table covers, and the facts that decide them are not on the decision. This spec does five things:

1. **Tier-1 rules for today's repeating classes:** an agent that exited without reporting done, a PR held by the orchestrator, a block that needs the owner, and a gate that failed on infrastructure. Each class gets the facts that decide it, and a rule that abstains whenever a fact is missing.
2. **Bench v3:** score every proposer on all answered decisions, per class, from the decisions store, measured and never estimated.
3. **Abstain rules** shared by every proposer, so "I don't know" is the default answer.
4. **A shadow trial plan for a small local model:** a 90 % bar on the bench and in live shadow. A model below the bar never leaves shadow, and nothing in this design lets a model act.
5. **An outage is one decision, not a storm:** a fact that says the operator's machine is down, a rule that keeps tasks held while it is, and (only on the owner's yes) one decision per outage instead of one per task.

## 1. Problem, with evidence

The numbers come from one busy project (16 to 36 agents, one orchestrating session answering for the owner) over 27 Oct to 2 Nov 2026. They are a snapshot: read on 2 Nov from the decisions store, opened read-only (SQLite `mode=ro&immutable=1`; newest decision 2 Nov 19:59 UTC). Structured `class` and `evidence` started on 31 Oct 04:04 UTC. Once bench v3 exists (PR 2), its export (with the file's SHA-256 and the time it was taken) replaces these hand counts as the measurement of record.

| Fact | Count |
|---|---|
| Decisions raised | 706: 322 answered, 372 withdrawn, 12 open |
| Answered with two or more options (real choices, not acknowledgements) | 287 |
| Answered since 31 Oct 00:00 UTC | 157 (139 of them since structured evidence started at 04:04) |
| Answers equal to the option Lair recommended | 191 of 322 (59 %) |
| Answers the built-in rules (C1-C4, C11) would propose, replayed over the multi-option answers with their own guards | **14 (under 5 %)**, all 14 right, all C1 `wait` |
| Answers that carry a note saying why | 281 of 322 |

The rules are never wrong, but they almost never answer. Since 31 Oct, about half of the answered decisions (78 of the 155 answered when the class table below was read) fall into four repeating classes that have no rule at all:

| Class (today's id and code) | Answered | Answers given | Lair's recommendation right | What decided it (read from the answer notes) |
|---|---|---|---|---|
| **Exited without done**: `agents.gave_up` / `exit0_no_report` | 14 | `keep_held` 8, `start_again` 6 | 8 of 14 | Whose move it is. `keep_held` when the agent's part was finished and the PR waited on someone else (a review at the head, a gate in the queue, an approval). `start_again` when the agent had work to do at its head (changes requested, no gate submitted yet) |
| **Blocked**: `agents.gave_up` / `blocked_reported` | 12 | `keep_held` 5, `start_again` 7 | 5 of 12 | What the block waits on and whether that cleared: another PR's merge, an owner approval at a head, host load, the container engine being back |
| **Gave up on a provider limit or repeated failure**: `agents.gave_up` / `provider_limit`, `repeated_failure` | 41 | `release` 22, `fresh_session` 18, `start_again` 1 | 22 of 41 | Whether the task is still open. All 22 `release` answers say the task was finished, merged, closed, parked or taken over by another agent. 17 of the 18 `fresh_session` answers say the cause cleared (the limit reset, a tool fix landed) and the task was still open |
| **Held by the orchestrator**: `review-holds.hold` / `hold_open` | 3 (and 4 still open) | `keep` 3 | 3 of 3 | The hold's reason still stands (a review fix round in progress). `release` is `outward` and stays with a person |
| **Blocked, needs the owner**: `planner.unblock` / `needs_owner` | 3 | `keep` 3 | 3 of 3 | Nothing: a block that needs the owner is never unblocked by a machine |
| **Gate failed on infrastructure**: `triage.gate_failure` / `infra_other` | 5 (and 9 unstructured before 31 Oct, 8 of them `fix-environment`) | `fix-environment` 1, `rerun` 2, `ignore` 2 | 1 of 5 | Whether the infrastructure is back (`rerun`), still down (`fix-environment`), or a newer gate at a newer head already replaced this one (`ignore`) |

**An outage storm.** On 2 Nov 2026 between 19:05 and 19:54 UTC the operator's machine lost name resolution. Agent runs ended without reporting, and fill raised 8 `agents.gave_up` / `exit0_no_report` decisions in 50 minutes (3 later withdrawn, 5 still open at the snapshot), each through the paused-after-N-weak-waits path (`src/server/agents/fill.ts:1970-1979`, `holdNoDone` at `:1952`, `agents.fill.max_completions_without_done` 3 at `src/server/agents/config.ts:238`). None of them was the agents' fault, and none had a PR the facts below could read, so every rule of this design as first written abstained on all 8. A table should either answer them (`keep_held` until the network is back) or not raise them one by one. §4.1 adds the fact, §4.2 the rule and §4.7 the raise suppression.

Why no rule can answer them today:

- **The deciding facts are not on the decision.** Every `agents.gave_up` decision carries the same four facts: `agent`, `task`, `attempt_count`, `last_exit`. None of them says whether the task is still open, whose move it is, or what the block waits on. A hold carries only `ref`. A gate failure carries no infrastructure status and no "superseded" flag.
- **One class is not in the class table.** `review-holds.hold` is raised with `classKnown: false`, so the policy table refuses any rule that names it.
- **Facts are frozen at the raise.** Only `cause_cleared` and `linked_issue` can change later, and the trace writes one proposal per decision and table version. A block that clears an hour after the raise never gets a new proposal.
- **The bench does not measure what it reports.** It groups results by `kind`, not by class (`src/server/brain-bench/run.ts:64` `runBench`). Its rule model (`src/server/brain-bench/models.ts:179` `ruleModel`) reads its own `when`-equality rule format, not the policy table. No bench run covers the four classes above. The operator's local bench file (111 cases, all from before structured evidence) and its last report are not in this repository; that report estimated the model's numbers from an earlier run instead of measuring them.
- **Model confidence cannot be used to abstain.** In that local report (unverified here: no cases file or report is tracked, so bench v3 re-measures it before anyone relies on it), a 4B instruct model used as-is was right 77.5 % of the time on the 111 cases, and every one of its 25 wrong answers had confidence 0.7 or higher. If bench v3 confirms it, self-reported confidence is not a signal, which is why §4.4 abstains on calibrated confidence only.

## 2. What exists today

Found with `git grep` on `github/main` over policy, proposer, evidence, bench, trainer, shadow, abstain, confidence, outcome, hold, blocked and gave_up in `src/server/decisions`, `src/server/agents`, `src/server/brain-*`, `src/server/outcomes`, `src/server/planner`, `src/server/triage`, `src/cli` and `docs/configuration.md`.

| What | Where | What it does | What is missing for v3 |
|---|---|---|---|
| Class table | `src/server/decisions/structure.ts:23-46` `KNOWN_DECISION_CLASSES` | 15 classes (C1-C15; C15 `planner.guard_notice`) with their evidence codes (`{ policy, codes }` only); the policy table accepts only these | No `review-holds.hold` or `delivery.hold`; no tier, no never-list, no list of which facts a class may update after the raise |
| Rule proposer | `src/server/decisions/policies/rules.ts:41` `RuleProposer`, `:19` `holds` | Matches class and code, checks `when` / `unless` over facts. Its abstain codes today: `tier_3` (tier 3 or a kind in `NEVER_DEFAULT_KINDS`, `:61-63`), `policy_expired`, `option_not_offered`, `effect_not_reversible` (`:65-76`), `conditions_not_met`, `guard` (`:78-86`). A missing fact makes `holds` return `null` (`:21`), which lands in `conditions_not_met` or `guard` | Nothing; v3 reuses it unchanged and keeps its codes |
| Policy table and built-in rules | `src/server/decisions/policies/table.ts` `parsePolicyTable`, `:42` `max_tier` (a property of each policy row), `:85-87` unknown-class and unknown-code refusal, `DEFAULT_POLICIES_YAML` (C1, C2, C3, C4, C11) | Validated, fail-closed, hashed into a version | No rule for the classes of §1; no tier or never-list per class, so nothing stops a row from giving a tier-2 class a tier-1 rule or proposing a forbidden option |
| Policy states | `src/server/decisions/policies/types.ts:9` `POLICY_STATES = ["off", "shadow"]` | `suggest` and `act` are refused | Stays so in v3 |
| Trace and agreement | `src/server/decisions/policies/shadow.ts:38` `PolicyShadow`, `:30` `CatchUpOptions`, `:89` `catchUp` (at start, every open decision without a row for the current version), `shadow.ts:11-16` `ShadowSource` (four members: `get`, `openPage`, `recordPolicyTrace`, `hasPolicyTrace`); `agreement.ts:11` `agreementRows`; `policies/index.ts:144` `GET /api/owner/decision-policies` (owner only); `store.ts:98-108` `policy_trace` with primary key (decision, proposer, version), `:588` `addTrace` (`INSERT OR IGNORE`), `:599` `hasTrace` | One trace row per decision, proposer and version, written at the raise and at start; a written row is never changed; agreement counted in SQL | One proposal per version: a later evidence change is never re-proposed; the row keeps only the final option, not what the proposer would have said before an abstain |
| Evidence updates | `src/server/decisions/service.ts:283` `updateEvidence`, `types.ts:124-137` | The raising module may change `cause_cleared` and `linked_issue` of an open decision, audited | No other fact can change |
| Store | `src/server/decisions/store.ts:37` `SCHEMA_VERSION = 6` | Decisions, outcomes (v5), `policy_trace` (v6) | No evidence revision on the decision or the trace row |
| Exited without done / blocked raisers | `src/server/agents/fill.ts:1114` (codes), `:1939-1950` `blocked_reported`, `:1952-1969` `exit0_no_report` (`holdNoDone`), `:1970-1979` weak waits counted toward it; `config.ts:238` `max_completions_without_done` (3) | Hold the task and raise one decision with `agent`, `task`, `attempt_count`, `last_exit` | No task state, PR, review or gate state at the head, block target; an outage counts toward the N weak waits like the agent's own failure |
| Gave-up raiser | `src/server/agents/service.ts:2430-2434` `escalate` (`repeated_failure`, `dead_on_start`, `provider_limit`); `agents/decisions.ts:178` the only `updateEvidence` caller (C1 `cause_cleared`), `:191` `withdraw` | Same four facts | No task state, no reset-passed fact |
| Fill's withdraw sweep | `src/server/agents/fill.ts:2420-2451` `withdrawLifted`, `:158` `LINE_GONE_CHECKS = 3`, `:1200` `lineGone` | Withdraws fill's own hold decision when its line is done, held for another reason, started, or gone for 3 checks in a row (a tasks file mid-rewrite looks gone for one check). An `escalation:` decision of the agents module is withdrawn only when its line is `done` (`:2434`) | Nothing for a task that is gone, reassigned, merged or parked while its line is not `done`: those are the 22 `release` answers of §1 |
| Hold raiser | `src/server/decisions/holds.ts:110-135`; used by `src/server/review/service.ts:231` (module `review-holds`, `:67`) and `src/server/delivery/service.ts:57` (module `delivery`, `:26`) | Class `<module>.hold` (so `review-holds.hold` and `delivery.hold`), code `hold_open`, facts `{ref}`, options `release` (outward) and `keep` (reversible), recommends `keep` | Neither class is known (`store.ts:755` flags them `classKnown: false`); no holder role, PR state or hold age |
| Planner block raiser | `src/server/planner/service.ts:852` `classifyBlocked`, `:913-914` | `needs_owner` or `infra`, facts `task`, `agent`, `block_class`, `rule` | `cause_cleared` for `infra` is never re-evaluated (decision-policies §11) |
| Gate failure raisers | `src/server/triage/gate-recheck.ts:685-686`, `src/server/triage/service.ts:1093-1094` | `infra_download` / `infra_other` / `same_failure_again`, facts `gate`, `sha`, `recheck_count`, `same_commit`, `network` | No infrastructure status now, no "superseded" |
| Host load | `src/server/agents/fill.ts:3054-3094` | Fill's start probe reads load and CPU count | Not a decision fact |
| Infra monitor | `src/server/infra-monitor/config.ts:34` machines with argv probes, `:41` lanes (each on a machine), `:55` `down_threshold_seconds` (120), `:56` `probe_timeout_seconds`; `types.ts:18-31` `MachineView` (`up`: true, false or null when not probed yet; `downSince`; `upSince`); `types.ts:113-132` `InfraMonitorStatus` (`stale` when no tick finished for three intervals) | Probes each configured machine on an interval and says whether it is up; off by default | Not read by any decision raiser |
| Brain bench | `src/server/brain-bench/types.ts`, `cases.ts` (`parseCase`, with `at`, `recommended`, `outcome`), `models.ts:179` `ruleModel`, `:24` `answerSchema`, `:150` `ollamaModel` and an OpenAI-compatible model, `run.ts:5` `DEFAULT_THRESHOLD = 0.5`, `run.ts:64` `runBench`; CLI `src/cli/brain-bench.ts` | Scores models on a JSONL cases file, by `kind`: accuracy, abstain, wrong-but-confident, latency | No export from the store, no per-class report, no policy-table model, no recommended-option baseline, no split, no provenance in the report |
| Brain trainer | `src/server/brain-trainer/config.ts:42` (`confidence_floor` 0.7), `split.ts:21` `timeSplit`, `examples.ts:9` `classKeyOf`, `shadow.ts:60-95` (veto of answers that turned out bad, abstain) | Nightly classifier in a container, shadow file, never answers | Its own trace file and its own floor; not a `Proposer` |
| Outcome tracker | `src/server/outcomes/rules.ts:39-147` (restart, hold, release, planner, merge) | good / bad / unknown after an answer | Nothing for v3 beyond reading it |
| Configuration | `docs/configuration.md` §Brain bench, §Decision policies, §Brain trainer, §Outcome tracker | `decision_policies.enabled` (default `false`) | New keys of §4.6 |

## 3. Gaps

1. The facts that decide the four classes (§1) are not on their decisions, and nothing on a decision says the machine was down when it was raised.
2. `review-holds.hold` and `delivery.hold` are not known classes, and a class has no tier or never-list in the data model (only policy rows have `max_tier`).
3. Facts cannot change after the raise (other than two), and a change never makes a new proposal.
4. No rule exists for the four classes.
5. The bench cannot read the store, does not report per class, does not run the live policy table, and has no baseline or provenance.
6. Abstaining is spread over three places with different rules (the rule proposer, the trainer's floor, the bench threshold of 0.5), and nothing abstains on stale facts, a class that is drifting, or two proposers that disagree.
7. No path takes a local language model from the bench to live shadow, and no single bar applies to it.
8. An outage makes every agent's run look like its own failure: one decision per held task, none of them answerable.

## 4. Design

### 4.1 Evidence v3: the deciding facts

Each raiser adds these facts at the raise. Facts hold codes, ids, numbers, booleans and times, never prose (as v1 §4). A fact the module cannot read is `null`, and a rule that needs it abstains.

| Class / code | New facts | Source |
|---|---|---|
| `agents.gave_up` (all codes) | `task_state`: `open`, `closed` (done, merged, retired, parked, or gone from the tasks file for `LINE_GONE_CHECKS` checks in a row) or `reassigned` (another agent's line names it); `pr`: number or null (from the run's last report line); `next_move`: `agent`, `other` or `null` (below); `fresh_sessions`: count for this task | The tasks file fill already reads each check. A line missing for fewer than `LINE_GONE_CHECKS` (3, `fill.ts:158`) checks keeps the last value, so a tasks file mid-rewrite never reads as `closed`. Fill's own decisions reuse `withdrawLifted`'s counter (`fill.ts:2435-2438`). The agents module's `escalation:` decisions never reach that counter (`fill.ts:2434` skips them unless the line is `done`), so PR 1 gives the re-read its own counter per decision key, with the same constant and the same reset when the line is back. The bus report; review and gate state |
| `exit0_no_report`, `blocked_reported` | `infra_up`: boolean or null, for the machine named in `decision_policies.outage.machine` (the operator's own host, given a probe such as a name lookup), by the one function `infraUp` below; `null` while `outage.mode` is `off`, whatever `outage.machine` names (AT-21 `off`) | Infra monitor (`infra-monitor/types.ts:18-31`) |
| `exit0_no_report` | `review_at_head`: `approve`, `request_changes`, `none` or null; `gate_at_head`: `pass`, `fail`, `queued`, `none` or null; `hold_on_pr`: the open hold's `holder_role` (`owner`, `orchestrator`, `policy`, `agent`), `none`, or null | Review store, review holds and gate results for `pr` at its current head |
| `blocked_reported` | `block_class`: the planner's existing classifier (`src/server/planner/blocked.ts:15` `classifyBlocked`, the same patterns) on the BLOCKED line: `owner`, `environment` or `task`; `block_target`: `pr`, `host_load`, `environment` or `unknown`, from a new fixed pattern list (a PR reference, a load reference) applied after it; `blocked_on_pr`: number or null; `blocker_cleared`: boolean or null | `pr`: that PR merged or closed. `host_load`: fill's probe load per CPU below its start limit. `environment`: the infra monitor's probe for the lane is up. `block_class` `owner` or target `unknown`: always `null` (only a person clears it) |
| `provider_limit` | `limit_reset_passed`: boolean or null | The reset time the agents module already parses (decision-policies §11) |
| `repeated_failure`, `dead_on_start` | `cause_cleared` (exists), `last_exit` (exists) | Unchanged |
| `review-holds.hold`, `delivery.hold` (new known classes, C16) | `holder_role`: `owner`, `orchestrator`, `policy` or `agent` (a role, never a name); `pr_state`: `open`, `merged` or `closed`; `hold_age_minutes`; `head_changed_since_hold`: boolean | The hold record and the PR |
| `planner.unblock` | `cause_cleared` for `infra` re-evaluated (closes the decision-policies §11 gap) | The infra monitor |
| `triage.gate_failure` (infra codes) | `infra_up`: boolean or null, `infraUp` of the machine the gate's lane runs on (`infra-monitor/config.ts:41`); `superseded`: boolean, true when a newer gate on the same branch at a newer head exists, or the PR is closed | Infra monitor; gate queue and results |

`infraUp(machine)` reads the monitor's `MachineView` and is the only place either fact is computed. Today `up` turns `false` on the first failed probe round, and a probe timeout sets it `false` too (`infra-monitor/service.ts:137`, `:146-151`); the down threshold is applied only by the `machine_down` detector (`detectors.ts:60-62`). So PR 3 adds `timedOut` (the last round failed by a timeout) to `MachineView`, and `infraUp` returns:

- `true` when `up` is `true`;
- `false` only when `up` is `false`, `timedOut` is `false`, and `now - downSince` is at least `down_threshold_seconds` (the same test as the detector, so one failed round is not an outage);
- `null` in every other case: the key is empty, the monitor is off or `stale`, the machine is not probed yet, its last round timed out, or it is down for less than the threshold. A timeout is never "up" and never "down".

`next_move` is computed by one function, in this order:

1. `null` when `pr` is null, `gate_at_head` is `fail`, `hold_on_pr` is `owner`, or `hold_on_pr` is null (the hold state could not be read, so a hold may stand). That is v1 C5's approved guard in full ("a task with a failing gate or a human-set hold goes to the owner", decision-policies.md:36): no rule answers either case, and no answered case of §1 starts an agent on a failing gate.
2. `other` when `gate_at_head` is `queued`, `hold_on_pr` is `orchestrator`, `policy` or `agent`, or `review_at_head` is `approve` and `gate_at_head` is `pass`.
3. `agent` when `review_at_head` is `request_changes` or `gate_at_head` is `none`.
4. `null` otherwise (any input `null` that the steps above needed; a null `hold_on_pr` already stopped at step 1).

**Live facts.** Each known class gets a `live` list in `KNOWN_DECISION_CLASSES`: the facts its module re-reads at every check while the decision is open (`task_state`, `next_move`, `review_at_head`, `gate_at_head`, `blocker_cleared`, `limit_reset_passed`, `pr_state`, `infra_up`, `superseded`). `cause_cleared` and `linked_issue` stay updatable as today, by event (`agents/decisions.ts:178`), and are not in any `live` list. `updateEvidence` accepts a fact only if it is one of those two or in its class's `live` list. It stays limited to the raising module and open decisions. A value equal to the current one changes nothing, and each real change is audited as `evidence_updated` and bumps the decision's `evidence_rev`.

**Store.** Two new columns on `decisions`: `evidence_rev` (integer, 0 at the raise) and `facts_at` (one time per decision, null until the first re-read). A raiser's re-read of a decision's `live` facts is one `updateEvidence` call carrying all of them; it sets `facts_at` to the time of the read even when no value changed (then without an audit row or a new `evidence_rev`). `facts_at` is never set at the raise, and a decision that was never re-read has `facts_at` null: "never re-read" is not stale (§4.4 A5). `policy_trace` gains `evidence_rev` in its primary key and a `proposed_option` column (§4.4). The store goes to the next free schema version (7 on main today, `store.ts:37`); files of versions 1 to 6 gain the columns on open (`evidence_rev` 0, `facts_at` null, trace rows `evidence_rev` 0 with `proposed_option` equal to `option`), with a test per version.

**Closed tasks and fill's sweep.** Fill already withdraws its own hold decisions when the line is gone for `LINE_GONE_CHECKS` checks, and the agents module's `escalation:` decisions only when the line is `done` (`fill.ts:2434`). The 22 `release` answers of §1 are the cases that sweep leaves open (merged, parked, reassigned, or gone while not `done`). PR 1 does **not** widen the sweep: withdrawing more decisions is a behaviour change, and this design is observe first. Those decisions stay open and r3-closed-release answers them in shadow, so they stay in the bench corpus (a withdrawn decision is never compared). Whether the sweep should later withdraw them instead is owner question 5; if it does, r3-closed-release's cases leave the corpus and the rule is kept only for a task closed between two sweeps.

### 4.2 Tier-1 rules v3 (all `shadow`, `max_tier: 1` unless said)

Added to the built-in table, and kept to options that are `reversible` or `frees_task`. The column "On the data" is the answer the rule gives on the answered decisions of §1, labelled by hand from the answer notes. Bench v3 (§4.3) measures it for real once PR 1 records the facts.

| Id | Class / codes | When | Unless | Answer | On the data |
|---|---|---|---|---|---|
| r3-outage-keep | `agents.gave_up` / `exit0_no_report`, `blocked_reported` | `infra_up` eq false | none | `keep_held` | No answered case: the 8 decisions of the outage hour (§1) were withdrawn or left open. Measured by AT-21 and bench v3's storm slice (§4.3) |
| r3-closed-release | `agents.gave_up` / `provider_limit`, `dead_on_start` | `task_state` in `closed`, `reassigned` | none | `release` | 22 of 22 together with the next row |
| r3-closed-release-rf (`max_tier: 2`) | `agents.gave_up` / `repeated_failure` | `task_state` in `closed`, `reassigned` | none | `release` | (in the 22 above; a separate row because `repeated_failure` is tier 2, §4.2 class tiers) |
| r3-reset-fresh | `agents.gave_up` / `provider_limit` | `task_state` eq `open`, `limit_reset_passed` eq true | `fresh_sessions` gte 3 | `fresh_session` | 12 of 12 |
| r3-cleared-fresh (`max_tier: 2`) | `agents.gave_up` / `repeated_failure` | `task_state` eq `open`, `cause_cleared` eq true | `fresh_sessions` gte 3 | `fresh_session` | 5 of 5 (the sixth names no cleared cause and abstains) |
| r3-other-move-keep | `agents.gave_up` / `exit0_no_report` | `next_move` eq `other` | `task_state` ne `open` | `keep_held` | 8 of 8 |
| r3-agent-move-start | `agents.gave_up` / `exit0_no_report` | `next_move` eq `agent`, `task_state` eq `open` | `attempt_count` gte 5; `gate_at_head` eq `fail` (belt and braces: `next_move` is already `null` then; a `null` gate state also blocks, as every guard that cannot be evaluated does, `rules.ts:83`) | `start_again` | 6 of 6 (all "changes requested" or "no gate submitted yet") |
| r3-blocked-keep | `agents.gave_up` / `blocked_reported` | `blocker_cleared` eq false | none | `keep_held` | 5 of 5 |
| r3-blocked-start | `agents.gave_up` / `blocked_reported` | `blocker_cleared` eq true, `task_state` eq `open` | `block_class` eq `owner` | `start_again` | 5 of 7 (2 were "not really blocked" corrections that no fact shows; those abstain) |
| r3-hold-keep, r3-delivery-hold-keep | `review-holds.hold`, `delivery.hold` / `hold_open` | `pr_state` eq `open` | `head_changed_since_hold` eq true | `keep` | 3 of 3 |
| r3-owner-block-keep | `planner.unblock` / `needs_owner` | none | none | `keep` | 3 of 3 |
| r3-infra-unblock | `planner.unblock` / `infra` | `cause_cleared` eq true | none | `unblock` | (v1 C7) |
| r3-infra-rerun | `triage.gate_failure` / `infra_other`, `infra_download` | `infra_up` eq true, `superseded` eq false | `recheck_count` gte 3 | `rerun` | 2 of 2 |
| r3-infra-fix | `triage.gate_failure` / `infra_other`, `infra_download` | `infra_up` eq false | none | `fix-environment` | 1 of 1, and 8 of 9 before 31 Oct |

**Order matters.** The rule proposer returns the first row whose `when` all hold and whose `unless` all fail (`rules.ts:58-88`), in table order. r3-outage-keep is the first `agents.gave_up` row, so while the outage machine is down it wins over every row that would start the agent again; while `infra_up` is `true` or `null` (the default, with no outage machine configured) it does not match and the rows below it decide as if it were absent.

Never a rule, whatever the data says: `release` of a hold (`outward`), `unblock` of an owner block, `ignore` of a gate failure (v1 C8 keeps it with a person; the 2 superseded cases abstain; see owner question 1), `review_it_yourself` of a stuck review (v1 C9), `stop`, anything merge-adjacent. These go into each class's `never` list (below). The table refuses at load any policy row whose `answer` is on its class's `never` list for any code the row matches, naming the list; the other rows of the file still load, as an unknown class is refused today (`table.ts:85-87`). An option whose effect is `outward` or `irreversible` is still refused at propose time as today (`rules.ts:74-77`), because effects belong to the raised decision, not to the table. A hold whose head changed abstains, because the reason for the hold may be gone.

**Class tiers and never-lists.** Each `KNOWN_DECISION_CLASSES` entry gains `tier` (1, 2 or 3), an optional `code_tiers` map for codes whose tier differs, and `never`: a list of `{ option, codes? }` (no `codes`: every code of the class). A code's tier is `code_tiers[code]` or else `tier`. Two checks use it: (1) at load, a policy row whose `max_tier` is below the tier of a code it matches (all codes of the class when the row lists none) is refused, so a table file cannot give a tier-2 code a tier-1 rule without a reviewed change to the class table; (2) the model trial (§4.5) is eligible only for codes of tier 2. A row's own `max_tier` keeps its meaning (`max_tier: 3` abstains, `rules.ts:61`).

| Class (policy) | `tier` | `code_tiers` | `never` |
|---|---|---|---|
| `agents.provider_limit` (C1), `supervisor.check_failing` (C2), `watchdog.idle_capacity` (C3), `watchdog.orphan_claim` (C4), `agents.cannot_start` (C11) | 1 | none | none |
| `agents.gave_up` (C5) | 1 | `repeated_failure`: 2 | none |
| `planner.proposal` (C6) | 2 | `verifier_rejected`: 1 (v1's `reject_all` direction) | none |
| `planner.unblock` (C7) | 1 | `waiting_on_gate`: 2 | `unblock` for `needs_owner` |
| `triage.gate_failure` (C8) | 2 | `infra_download`, `docker_down`, `infra_other`: 1 | `ignore` |
| `review.stuck` (C9) | 2 | none | `review_it_yourself` |
| `review.merge_failed` (C10), `host-services.service_down` (C12), `pr_health.notice` (C13), `agents.spend_notice` (C14), `planner.guard_notice` (C15) | 3 | none | none |
| `review-holds.hold`, `delivery.hold` (C16, new) | 1 | none | `release` |
| `decision_brain.notice` (C17, new: §4.4 and §4.5 notices) | 3 | none | none |

C10 is merge-adjacent and C12-C15 are notices with no policy in v1, which v1 §3 puts in Tier 3 ("any new class with no policy").

**Re-tiering, said plainly.** v1 lists C5, C7 and C8 as Tier 2 (decision-policies.md:64-66). This design moves `agents.gave_up` codes other than `repeated_failure`, `planner.unblock` `infra` and `needs_owner`, and `triage.gate_failure`'s infra codes to Tier 1. Why: v1 put them in Tier 2 because the answer depended on facts not on the decision ("whether a gate is failing, what the last output says"). §4.1 puts those facts on the decision, and §1 shows each answer then follows from one or two of them, the definition of Tier 1 in v1 §3. `repeated_failure` stays Tier 2 (whether "the cause cleared" is judgement), as do C6 approval, C7 `waiting_on_gate`, C8's non-infra codes and C9. Every Tier-1 row here is still `shadow`; promotion still needs v1 §5's bars and the owner. Approving this document approves this re-tiering (owner question 3).

Replayed by hand on §1, these rules would propose on about 72 of the 78 answered decisions of the four classes (and C1 keeps its 14), and abstain on the rest. No hand-labelled case disagrees. That is the claim bench v3 must confirm on recorded facts before anyone relies on it.

### 4.3 Bench v3

**Corpus: every answered decision.** A new read-only export, `lair brain-bench export --store <decisions.db> --out <cases.jsonl> [--since <iso>]`, opens the store read-only (SQLite `mode=ro`) and writes one case per answered decision with two or more options: `id`, `at` (raised), `class` (or the trainer's `classKeyOf` key when it has none), `kind`, `module`, `evidence` (as stored at the answer, so the facts the person saw), options with `effect`, `label` (the answer), `recommended`, `outcome`. One-option decisions are counted as `notices` and left out. The answer note is never exported. The export is deterministic (ordered by `at`, then `id`), so the same store gives the same file and the same SHA-256.

**Proposers scored**, all through the same `runBench`:

- `policy:<table file or built-in>`: the live `RuleProposer` over the live table, not a separate rule format;
- `recommended`: Lair's own recommended option (the baseline every proposer must beat);
- `trainer:<best.json>`: the trainer's model;
- `ollama:<model>` / `openai:<model>`: a local model, through the existing models.

**Split.** Rules and `recommended` are scored on every case (they learn nothing). Trained models and calibration use a time split: train before `--cutoff`, test at or after it. A case raised before the cutoff and answered after it is left out of both (the trainer's `lateAnswers` rule).

**Report**, per class and overall: `n`, `proposed`, `coverage`, `answeredAccuracy`, `accuracy`, `abstain`, `wrongConfident` (wrong with calibrated confidence at or above the floor), `unsafe` (a proposal of an `irreversible` or `outward` option that was not the answer), the 95 % Wilson lower bound of `answeredAccuracy`, and latency p50 / p95. It carries provenance: the cases file's SHA-256, the store path's schema version, each proposer's id and version (table hash, model name and digest), the threshold, the cutoff, the Lair commit and the time. The CLI writes only measured numbers: there is no input for an estimate, and a report without provenance is refused by the view.

**Storm slice.** `--include-open --between <iso>/<iso>` adds a second, unlabelled file for one window (open and withdrawn decisions too, still without notes). The report gives only `n`, `proposed`, `coverage` and the options proposed for it: there is no label to score against. PR 2 runs it on the outage hour of §1 (2 Nov 2026 19:00-20:00 UTC) as a named slice, and PR 4's description reruns it with `infra_up` recorded.

**Bench v3 is the measurement of record.** The first bench v3 report is part of PR 2's description: every class of §1, rules v3 against `recommended`.

### 4.4 Abstain rules (every proposer)

One function, `mustAbstain(decision, proposal, context)`, runs after every proposer, the rules included, before the proposer's trace row is written. Any reason makes the row's `option` `null` and records the reason code. The row also keeps `proposed_option`: what the proposer said before `mustAbstain` (null when the proposer itself abstained). Coverage and agreement count `option` only; A7 alone reads `proposed_option`, so a class it silences keeps being measured. In order:

| # | Reason code | When | Exists today? |
|---|---|---|---|
| A1 | none (no row) | No `class` or no `evidence`: no proposer is called and no row is written | No row, as today (`shadow.ts:57`: no proposal or no class, no row). New: the view counts these decisions from the store under the label `no_structure` (no such code exists today) |
| A2 | `tier_3` | The row's `max_tier` is 3 or the code's class tier (§4.2) is 3, or the kind is in `NEVER_DEFAULT_KINDS` (spend, pricing, legal, account, credentials, go/no-go, security) | Exists in the rule proposer (`rules.ts:61-63`), which keeps it; `mustAbstain` applies the same code to model proposals. No new code |
| A3 | `policy_expired`, `option_not_offered`, `effect_not_reversible` | An expired row; the option is not offered; or it is `irreversible`, `outward` or has no effect | Exists in the rule proposer (`rules.ts:65-77`), which keeps it; `mustAbstain` applies the last two to model proposals. No new code |
| A4 | `conditions_not_met`, `guard` | A `when` fact is missing, null or false; an `unless` fact holds or cannot be evaluated | Exists in the rule proposer (`rules.ts:19-21`, `:78-86`) and stays there; there is no separate "fact missing" code. Models report no facts they used, so A4 does not apply to them |
| A5 | `facts_stale` (deferral, no row) | `decision_policies.live_facts` is on, the class has a `live` list, `facts_at` is not null, and `facts_at` is older than `max_fact_age_minutes` | New. **A5 writes no trace row.** It defers: the view counts the decision as `facts_stale`, and the raiser's next re-read (which stamps `facts_at`, §4.1) calls `propose` again for the same `evidence_rev`. It never applies while `live_facts` is off, to a decision never re-read (`facts_at` null), or to `cause_cleared` / `linked_issue`, which are updated by event and are in no `live` list. So the start-up catch-up (`shadow.ts:89`) with the defaults proposes on old decisions exactly as today: a 2-hour-old C1 decision still traces `wait` |
| A6 | `vetoed` | The same class, code and option was answered on another decision that was later marked `bad`, with the same facts signature: SHA-256 of the code and the sorted facts, with the class's id facts removed (`agent`, `task`, `pr`, `blocked_on_pr`, `gate`, `sha`, `ref`). The bad decision's signature is taken from its evidence at the answer (evidence is frozen once a decision is answered, `service.ts:283` takes open decisions only); the proposal's from the `evidence_rev` being proposed | In the trainer only (`brain-trainer/shadow.ts:60-95`); moved here |
| A7 | `class_drifting` | Once the class has at least `class_guard.window` compared decisions where this proposer had a non-null `proposed_option` (a shorter history never trips A7), over the last `class_guard.window` of them, agreement of `proposed_option` with the answer is below `class_guard.min_agreement` | New. Because it reads `proposed_option`, the window keeps moving while the class is silenced, and the class recovers by itself once enough agreeing decisions push the disagreements out. Entering A7 raises one `decision_brain.notice` / `class_drifting` decision (`noted` only, attention `notice`), as v1 §5's demotion raises a decision (decision-policies.md:147). Its key is (class, proposer, version, id of the first decision in the window that tripped it), all read from the store, so a restart raises no second one. Recovery withdraws it with "agreement is back at or above the bar"; a later drift raises a new one |
| A8 | `proposers_disagree` (view only) | Two proposers at `shadow` traced different non-null `option`s for the same decision and `evidence_rev` | New, **computed in the agreement SQL, never written into a trace row.** Rows are written one per proposer and never changed (`store.ts:588` `INSERT OR IGNORE`), so a row cannot learn about a proposer that runs after it. The view counts both as abstains with this reason for coverage and agreement |
| A9 | `below_floor` | A model's calibrated confidence is below `confidence_floor` | New in this form; the trainer's raw floor stays for its own file |
| A10 | `uncalibrated` | A model without a calibration from bench v3 for this class | New |
| A11 | `repeat_loop` | The same task had the same class and code answered with the same option within the last 24 h, and it came back | New |
| A12 | `timeout`, `invalid_output`, `queue_full` | A model call exceeded `timeout_seconds`; it returned an option outside the offered ids or invalid JSON; or the bounded queue was full and the call was dropped before it was made | New codes. Today the bench counts a thrown `BenchModelError` (`brain-bench/types.ts:49`) as an abstain with `error: true` and no reason (`brain-bench/run.ts:56-59`); live use is new too |

The agreement view counts each reason. An abstain is never a wrong answer, and it never counts toward coverage.

### 4.5 Shadow trial plan for a small local model

**Candidate.** A permissive-licence (Apache-2.0 or MIT) instruct model of 3 to 8 B parameters, quantised, served on the operator's machine by an Ollama or OpenAI-compatible endpoint, with JSON output constrained to `{option, reason_code, confidence}` and `option` an enum of the offered ids (`answerSchema` exists). The licence is read from the model card on the day of choice and recorded with the bench result. The bench picks the model, not a leaderboard.

**What the model sees:** `class`, `kind`, `module`, `evidence.code`, `evidence.facts`, the options (id, label, effect). It never sees the title, the context, an answer note, the recommended option, `outcome`, or anything from another decision. The data goes between fences and is treated as data (the bench's prompt today).

**Classes in the trial:** only class codes of tier 2 in the class table (§4.2: `tier`, `code_tiers`), listed in `decision_brain.model.classes` as `<class>` (all its tier-2 codes) or `<class>/<code>`. Tier-1 codes stay with rules, and tier 3 is never asked.

**Stages:**

| Stage | What runs | Gate to the next stage |
|---|---|---|
| T0 bench | Bench v3 test split, per class | For each class: `n` ≥ `bar.min_compared` (30), `answeredAccuracy` ≥ `bar.min_agreement` (0.90), `unsafe` = 0, `coverage` ≥ `bar.min_coverage` (0.60), `wrongConfident` ≤ `bar.max_wrong_confident` (0.02), and better than `recommended` on the same cases. A calibration (confidence bins to observed accuracy, fitted on the train split) is written with the result. A class that misses stays out of T1 |
| T1 live shadow | The model is a `Proposer` (`id: model:<name>@<digest>`), called on `decision.raised` and on each `evidence_rev` change for its classes, writing trace rows. Nothing is shown with the decision | For each class: the T0 bars again on live trace rows, over at least `bar.min_days` (14) days and `bar.min_compared` compared decisions, with no A12 rate above 5 %. The view then shows the class as **eligible** |
| T2 | Not in this design. A later design may add `suggest` for an eligible class, and only on the owner's recorded approval (decision-policies §9) | — |

**Never act below the bar.** `suggest` and `act` stay refused by the table and by the model config. Eligibility is computed, never set by hand. A class that falls below any bar over its last `bar.min_compared` rows loses eligibility at once and raises one notice decision (class `decision_brain.notice`, code `eligibility_lost`, `noted` only, keyed by class and model digest). A model or calibration change (a new digest) restarts both T0 and T1 for every class.

**Running it safely.** Calls go off the event loop, one at a time, through a bounded queue of `max_pending` waiting calls (the call in flight is not counted). When the queue is full, the oldest waiting call is dropped and traced `queue_full`. Each call has `timeout_seconds`; a timeout is traced `timeout`. A timeout or an error is an abstain, never an answer. The endpoint must be a loopback address unless `allow_remote_endpoint` is true; there is no allow-list: loopback only, or any host once `allow_remote_endpoint` is true. The request holds no secrets: evidence holds only codes and ids. The model proposer gets the same four-member reader the rule shadow has (`shadow.ts:11-16`: `get`, `openPage`, `recordPolicyTrace`, `hasPolicyTrace`), with no means to answer, withdraw or raise. `hasPolicyTrace` gains an `evidence_rev` argument with the trace key (PR 1); the reader keeps exactly four members.

### 4.6 Configuration (observe first)

Everything is off by default. Turned on, everything writes only evidence and trace rows. Nothing answers.

```yaml
decision_policies:
  enabled: false                # exists
  live_facts: false             # raisers re-evaluate the `live` facts of their open decisions (evidence only)
  repropose_on_update: true     # a new evidence_rev gets a new trace row (needs live_facts)
  max_fact_age_minutes: 30      # A5, only while live_facts is on; 1-1440
  class_guard:
    window: 20                  # A7; 5-500
    min_agreement: 0.95         # A7; 0.5-1
  outage:
    machine: ""                 # an infra-monitor machine id (the operator's own host); empty: infra_up is null
    mode: off                   # off | observe | act (§4.7)
decision_brain:
  model:
    enabled: false
    api: ollama                 # ollama | openai
    endpoint: ""                # required when enabled; loopback only unless allow_remote_endpoint
    allow_remote_endpoint: false
    model: ""                   # required when enabled
    digest: ""                  # required when enabled: the served model's content digest
    calibration_file: ""        # required when enabled: written by the T0 bench run
    classes: []                 # explicit list of <class> or <class>/<code>; tier 2 in the class table (§4.2)
    state: shadow               # the only value accepted
    confidence_floor: 0.8       # A9, on calibrated confidence; 0.5-1
    timeout_seconds: 20         # 1-120; a timeout is an abstain
    max_pending: 20             # 1-200
  bar:
    min_compared: 30            # 30-10000; lower needs the owner (decision-policies §5)
    min_agreement: 0.90         # 0.90-1; the floor cannot be lowered
    max_unsafe: 0               # 0 only
    min_coverage: 0.60          # 0-1
    max_wrong_confident: 0.02   # 0-0.2
    min_days: 14                # 1-90
```

A section with an unknown key, a value out of range, a `state` other than `shadow`, a class or code that is not tier 2 in the class table, an `outage.machine` that is not a machine of the infra monitor's config, or `enabled: true` with a required key empty is refused: that part stays off, and the reason is logged and shown in the view (as `brain_trainer` does). Read once at start.

Routes: `GET /api/owner/decision-policies` (exists, owner only) gains per-proposer rows, abstain reasons, eligibility per class and the latest bench report's provenance. No new mutating route: bench reports are written by the CLI to `data/brain/bench/` and read by the route.

### 4.7 Outage: one decision, not one per task

While the outage machine is down, a run that ends without reporting is not the agent's failure, and holding every task with its own decision is the storm of §1.

**Next to the provider outage.** The agents module already knows a *provider* outage: a `transient` event per provider (`agents/service.ts:227` `Outage`, `:3250` `outage`), one decision per provider, and `fleetFailure` (`:2579`) keeps such runs out of the no-result cap. [provider-limits.md](provider-limits.md) §4.3 extends it to a burst of `dead_on_start` runs. That path covers runs that *die*, matched per provider. This section covers runs that *exit 0 without reporting*, which go through fill's weak-wait count (`fill.ts:1970-1979`) instead, and it reads the operator's own host from the infra monitor, not a provider. The two do not overlap: a run that ends in an open provider outage is already not counted, and §4.7 changes nothing for it.

- **When it applies.** `outage.mode` is `observe` or `act`, `outage.machine` names a monitored machine, the monitor is not `stale`, and `infraUp(machine)` (§4.1) is `false`: `up` is `false`, the last round did not time out, and the machine has been down for at least `down_threshold_seconds`. `MachineView.up` alone is not enough: it turns `false` on the first failed round and on a timeout. A probe timeout, `null` or a stale monitor is never "down": fill then does exactly what it does today (fail closed means "raise as today", never "suppress").
- **`observe`.** Fill raises every decision as today, with `infra_up` false on it, and adds a `would_suppress` count per (machine, outage) to the view. Nothing else changes.
- **`act`.** For a run that ended while the machine was down (`endedAt` at or after the outage's start, below), fill does not count the run toward `max_completions_without_done` (`fill.ts:1975-1979`), so no per-task `exit0_no_report` decision is raised for it, and it does not start that task again while the machine stays down (the task is held with the hold reason `outage`, which spends nothing).
  - **One decision per outage.** Class `agents.gave_up`, new code `infra_down` (added to the class's codes, tier 1, no rule), facts `machine`, `down_since`, `held_tasks` (a count), options `keep_held` (reversible, recommended: "wait for the machine") and `start_again` (reversible: lift the `outage` holds now). Its key is `outage:<project>:<machine>`, and the raiser reuses an open decision with that key.
  - **Restarts.** The outage's start is the decision's `down_since` fact, written once at the raise from the monitor's `downSince` and never moved. A restart during the outage (the monitor's `downSince` restarts, every machine starting at `up: null`, `infra-monitor/service.ts:93`) neither raises a second decision nor counts again the runs that ended since the first `down_since`.
  - **Lifting.** The `outage` holds are lifted and the decision withdrawn as soon as `infraUp` is no longer `false`: the machine is up ("the machine is back"), or the monitor is off, `stale`, restarted and not yet probed, or timing out ("the outage can no longer be seen"). Holding needs positive evidence of an outage at every check; losing that evidence never leaves a task held. A task that then fails again on its own is counted and raised as today.
  - `blocked_reported` is unchanged: an agent that says it is blocked is heard.
- **Rule.** r3-outage-keep (§4.2) answers the per-task decisions that `observe` (and, in `act`, `blocked_reported`) still raises. The `infra_down` decision itself has no rule: it is rare, and a person decides whether to wait.

`act` changes what fill raises, so it is a behaviour change: it is off by default, needs `observe` first, and turning it on is the owner's call (owner question 4).

## 5. Acceptance tests

Each test drives the real entry point (the raiser's check, `decision.raised`, `updateEvidence`, the CLI's `main`, the route). It feeds payloads copied from the emitters on main (`fill.ts`, `holds.ts`, `gate-recheck.ts`, `planner/service.ts`) and fakes only one named boundary: the clock, the model endpoint (an HTTP fake), or the tasks file contents.

| # | Name | Given / when | Then |
|---|---|---|---|
| AT-1 | `gaveUpCarriesTaskState` | A task held for `provider_limit`; its line in the tasks file is open; gone for one check, then back; marked done; gone for 3 checks in a row; claimed by another agent | `task_state` is `open`; still `open` after the one-check gap (no `evidence_rev` change); `closed`; `closed` only at the third check; `reassigned`. With `live_facts: false` it stays as raised |
| AT-2 | `exit0NextMove` | `exit0_no_report` with a PR whose head has: an approve review and a passing gate; a queued gate; changes requested; no gate; a failing gate with no hold; changes requested and a failing gate; changes requested and an owner's hold; an orchestrator's hold; no PR | `next_move` `other`, `other`, `agent`, `agent`, `null`, `null`, `null`, `other`, `null`; r3-agent-move-start proposes `start_again` only for the third and fourth |
| AT-3 | `blockedFacts` | BLOCKED lines naming: another PR (open, then merged); an owner approval; host load (above, then below the start limit); an unparseable reason | `block_target` / `blocker_cleared`: `pr`/false then true; (`block_class` `owner`)/null; `host_load`/false then true; `unknown`/null |
| AT-4 | `holdIsKnownClass` | A hold raised by the review module and one by the delivery module | `classKnown: true` for both; facts `holder_role`, `pr_state`, `hold_age_minutes`, `head_changed_since_hold`; policies naming `review-holds.hold` and `delivery.hold` load |
| AT-5 | `gateInfraFacts` | An `infra_other` failure; the lane's machine probe up; failing for longer than `down_threshold_seconds`; failing for one round only; timing out; the monitor `stale`; a newer gate on the same branch at a newer head | `infra_up` true, false, null, null (a probe timeout is never "up" or "down"), null; `superseded` true |
| AT-6 | `liveFactsOnlyListed` | `updateEvidence` from the raising module with a listed fact, an unlisted fact, the same value again, and from another module | Applied and audited with `evidence_rev` +1 and `facts_at` set; refused; `facts_at` set, no other change and no audit; refused |
| AT-7 | `schemaV7Migration` | Real store files of versions 1 to 6 | Open with `evidence_rev` 0 and `facts_at` null on every decision; v6 trace rows get `evidence_rev` 0 and `proposed_option` equal to `option`; no row lost; a restart that catches up writes no second row for an old trace row |
| AT-8 | `rulesV3Shadow` | One decision per row of §4.2, with the facts that match, and the same with each `when` fact missing, each `when` fact false, and each `unless` holding or null | Each traces its answer with confidence 1; each `when` variant abstains with `conditions_not_met`, each `unless` variant with `guard` (the existing codes, `rules.ts:78-86`); with `infra_up` false, every `exit0_no_report` / `blocked_reported` case traces r3-outage-keep `keep_held`; with `infra_up` null the others decide unchanged; no decision is answered (the decision is unchanged and has no answer) |
| AT-9 | `neverRuleOptions` | A table that proposes `release` for a hold, `unblock` for `needs_owner`, `ignore` for a gate failure, `review_it_yourself` for a stuck review, a `max_tier: 1` row for `agents.gave_up` / `repeated_failure`, a `max_tier: 1` row for `planner.proposal` with no codes, and `unblock` for `infra` | The first four are refused at load, each naming the class's `never` list; the fifth and sixth are refused naming the code's tier (2); the others in the file still load; the last loads |
| AT-10 | `reproposeOnUpdate` | A `blocked_reported` decision raised with `blocker_cleared` false, later true | Two trace rows (rev 0 `keep_held`, rev 1 `start_again`); a restart writes neither again; agreement uses the last row before the answer |
| AT-11 | `abstainOrder` | One decision per abstain reason A1-A12 (a vetoed signature; a model with confidence below the floor; a model without calibration; a repeat within 24 h; a model endpoint that hangs past its timeout, one that returns an id not offered, and a full queue) | Each traces `option: null` with its reason code and the proposer's answer in `proposed_option` where it had one; A1 writes no row and is counted as `no_structure`; the view counts each reason; none counts toward coverage |
| AT-11a | `staleFactsDefer` | (1) `live_facts: false`, a C1 decision raised 2 hours ago, a restart (the catch-up runs). (2) `live_facts: true`, an `exit0_no_report` decision whose `facts_at` is 2 hours old at a restart, then the raiser's first check re-reads it with no value change | (1) The catch-up traces `wait`, not `facts_stale`. (2) The catch-up writes no row and the view counts one `facts_stale`; the re-read stamps `facts_at` without a new `evidence_rev` or audit row, and `propose` then writes the row for rev 0 |
| AT-11b | `classDriftRecovers` | Rule rows for a class: 18 agreeing compared decisions, then 2 disagreeing (0.90 < 0.95), then 19 more answered as the rule would say, a restart in the middle | After the 2nd disagreement, rows trace `option: null`, `class_drifting`, with `proposed_option` set, and one `decision_brain.notice` / `class_drifting` decision is raised; the restart raises no second one; at the 19th agreeing decision the window holds one disagreement (0.95), rows trace the option again and the notice is withdrawn |
| AT-11c | `disagreeInView` | Two shadow proposers trace different non-null options for one decision at rev 0, and the same option at rev 1 | Both trace rows are unchanged (no row is updated); the view counts rev 0 as `proposers_disagree` for both and not toward coverage, and rev 1 as compared |
| AT-12 | `benchExportReadOnly` | A store with answered, withdrawn, open and one-option decisions, and an answer note holding a marker string | Only answered multi-option decisions are exported; notices counted; the marker is absent from the file; the store's bytes and mtime are unchanged; two exports give the same SHA-256 |
| AT-13 | `benchPerClassWithProvenance` | The exported file; proposers `policy:built-in`, `recommended`, and a fake endpoint model | Per-class rows with every metric of §4.3; the report holds the file hash, table version, model name and digest, cutoff and commit; a hand-edited report without provenance is refused by the route |
| AT-14 | `benchSplitNoLeak` | Cases before, after and across a cutoff | Rules on all; the model trained and calibrated only before; cases answered across the cutoff in neither |
| AT-15 | `modelConfigRefused` | `decision_brain.model` with `state: act`; a remote endpoint without `allow_remote_endpoint`; `classes: [agents.provider_limit]` (tier 1 in the class table); `classes: [triage.gate_failure/infra_other]` (a tier-1 code of a tier-2 class); `bar.min_agreement: 0.8`; enabled with no digest; `outage.machine` not in the infra monitor's config | Each refused with its key named; that part stays off; the server starts. `classes: [triage.gate_failure]` is accepted and means its tier-2 codes only |
| AT-16 | `modelShadowOnly` | Model on in shadow for one class; the fake endpoint answers | A trace row with the calibrated confidence; the decision is unchanged; the proposer's reader has exactly four members; the request body holds no title, context or answer note |
| AT-17 | `modelQueueBounded` | 50 decisions raised at once with `max_pending: 20` and an endpoint that sleeps past `timeout_seconds` | At most one call in flight; 29 traced `queue_full` (50 minus the one in flight minus 20 waiting); the 21 others called one at a time and traced `timeout`; the event-loop lag check stays green |
| AT-18 | `eligibilityNeverBelowBar` | Trace rows for a class at 29 compared / 0.95; 30 / 0.89; 30 / 0.93 over 13 days; 30 / 0.93 over 14 days with one unsafe; 30 / 0.93 over 14 days clean; then 5 wrong in a row | Not eligible, not eligible, not eligible, not eligible, eligible, then not eligible again with one `eligibility_lost` notice (a restart raises no second one) |
| AT-19 | `digestChangeResets` | An eligible class, then a new model digest | Not eligible; T0 needed again |
| AT-20 | `offWritesNothing` | All switches at their defaults, every raiser and the CLI export run | No trace row, no `evidence_rev` or `facts_at` change, no model call, no `outage` hold; the route shows everything off |
| AT-21 | `outageStorm` | The 2 Nov outage hour replayed: 8 agent runs end without reporting, each after `max_completions_without_done` weak waits, while the infra monitor's fake probe of `outage.machine` fails; then the probe passes. Run once per `outage.mode` (`off`, `observe`, `act`), once with the probe timing out instead of failing, and once in `act` with a restart in the middle | `off`: 8 `exit0_no_report` decisions as today, `infra_up` null. `observe`: the same 8 with `infra_up` false, r3-outage-keep traces `keep_held` on all 8, the view shows `would_suppress` 8. `act`: no `exit0_no_report` decision, one `infra_down` decision with `held_tasks` 8, no run started while down; when the probe passes the holds lift and the decision is withdrawn. Probe timeout, or one failed round shorter than `down_threshold_seconds`: as `off` (never suppressed). Restart mid-outage: still one `infra_down` decision, its `down_since` unchanged, and runs that ended before the restart are not counted. Monitor `stale` mid-outage in `act`: the `outage` holds lift and the decision is withdrawn |

## 6. Security and privacy

- **No new mutating route.** The only route change adds fields to an owner-only GET.
- **Nothing answers.** Every proposer gets the four-member reader, and AT-8, AT-16 and AT-20 check that the decision is unchanged.
- **No shell.** The CLI reads a file and the store; the model call is an HTTP request with a timeout. No command is built from data.
- **No secrets or names.** Facts hold codes, ids, numbers and roles (`holder_role`, never a person). The export drops answer notes, titles and context. The model request is built from the same fields, and AT-16 scans its body.
- **Fail closed.** An unknown fact, a timeout, invalid output, an unparseable block reason or a missing calibration is an abstain; stale facts defer (A5). A probe timeout is `null`, never "up", and a `null` or stale outage probe never suppresses a raise (§4.7).
- **Idempotent.** One trace row per decision, proposer, version and `evidence_rev`, never updated (A8 lives in the view); one `eligibility_lost` notice per loss (keyed by class and model digest); one `class_drifting` notice per drift (keyed by class, proposer, version and the window's first decision); one `infra_down` decision per machine while it is open; an evidence update with the same value writes nothing.
- **Outward actions.** None in `observe`. `outage.mode: act` holds and lifts fill's own holds (reversible, audited as today's holds are) and raises or withdraws one decision; it is off by default and is the owner's call.

## 7. Build PRs, in order

Each PR is separate, at most about 600 changed non-test lines, wired behind its switch, with docs in `docs/configuration.md`, and merges on its own.

1. **Evidence v3 for agents**, built as two PRs. **1a:** the store (version 7), the `live` lists, the `updateEvidence` allow-list, `decision_policies.live_facts`, and the facts the agents module reads itself (`task_state`, `pr`, `fresh_sessions`, the block facts, `blocker_cleared` for `host_load`, `limit_reset_passed`); ATs 1, 3 (but the PR case), 6, 7, 20. **1b:** the facts read at a PR's head (`review_at_head`, `gate_at_head`, `hold_on_pr`, `next_move`, `blocker_cleared` for a PR); AT-2 and AT-3's PR case. In full: the `agents.gave_up` facts (`task_state` with the `LINE_GONE_CHECKS` debounce, `pr`, `review_at_head`, `gate_at_head`, `next_move`, `fresh_sessions`, `block_class`, `block_target`, `blocked_on_pr`, `blocker_cleared`, `limit_reset_passed`) at the raise. The `live` list per class, the `updateEvidence` allow-list, `evidence_rev`, `facts_at`, `policy_trace.evidence_rev` and `proposed_option` (store version 7 with migration tests), and `decision_policies.live_facts`. ATs 1-3, 6, 7, 20.
2. **Bench v3.** `brain-bench export` (with the storm slice), the `policy:` and `recommended` proposers, the per-class report with the Wilson bound and provenance, the split. The PR description holds the first bench v3 report, its cases file's SHA-256 and the time of the export. ATs 12-14.
3. **Holds, planner, triage and outage facts.** `review-holds.hold` and `delivery.hold` as known classes (C16) with their facts; planner `infra` `cause_cleared` re-evaluation; triage `infra_up` and `superseded`; `infra_up` on `exit0_no_report` / `blocked_reported` from `outage.machine`, and `outage.mode: observe`. ATs 4, 5, and AT-21's `off`, `observe` and probe-timeout cases.
4. **Class tiers and rules v3.** `tier`, `code_tiers` and `never` in the class table with their load checks; the §4.2 rows in the built-in table (shadow), r3-outage-keep first; `repropose_on_update`. ATs 8-10.
5. **Abstain rules.** `mustAbstain` with A1-A12 (A9, A10 and A12 have no effect until PR 6), A5 deferral, A7 over `proposed_option` with its notice (class `decision_brain.notice`, C17), A8 in the agreement SQL, `max_fact_age_minutes`, `class_guard`, reason counts in the view. ATs 11, 11a-11c.
6. **Model shadow (T1) and eligibility.** The `decision_brain` section, the model `Proposer` on the existing bench models, calibration from the T0 bench run, the bounded queue, eligibility and its notice, the view's eligibility column. ATs 15-19.
7. **Outage act.** `outage.mode: act`: weak waits during an outage not counted, the `outage` hold, the one `infra_down` decision per machine and its withdrawal. AT-21's `act` and restart cases. Built only after `observe` has run and the owner says yes (owner question 4).

PR 1 is needed by PRs 3-7; PR 3 by PRs 4 and 7; PR 2 can go in parallel with PR 1 and is rerun after each later PR.

## 8. Risks

- **The hand labels flatter the rules.** §4.2's "on the data" column is read from notes by hand. Bench v3 on recorded facts is the real check, and a rule that misses 95 % there stays `off` in the built-in table.
- **Facts become prose by another name.** `block_class` and `block_target` come from regex patterns over a BLOCKED line. `unknown` must stay common rather than guessed, and AT-3 covers the unparseable case.
- **Live facts add load.** Re-reading review and gate state for every open decision each check could be slow on a busy store. Each fact is read at most once per check from data fill already loads, and the event-loop lag self-check is the alarm.
- **Labels are one person's habits.** The orchestrating session's answers are labels (decision-policies §9). A habit that later turns out wrong shows up as `bad` outcomes, and A6 and A7 stop proposing it.
- **Small classes never reach 30.** Holds, owner blocks and gate infrastructure see a few a day, so they may take weeks to reach the bar. That is intended: the bar does not drop for low volume without the owner (decision-policies §5).
- **One abstain reason hides another.** When no row of a class answers, the rule proposer keeps the first row's abstain (`blocked ??=`, `rules.ts:57`, `:62-84`). With r3-outage-keep first, most `agents.gave_up` abstains are traced as r3-outage-keep / `conditions_not_met`. Bench v3 scores every row on its own, so the per-row reason is still measured there; the trace's reason for that class is read as "no row matched".
- **The outage machine probe is a proxy.** `infra_up` says the operator's host failed its probe, not that this run failed because of it. That is why `act` only defers counting and holds (reversible), never releases or answers, and why a `null` probe changes nothing.
- **A model drifts silently after an endpoint update.** The digest is required, and a changed digest resets eligibility (AT-19). An endpoint that serves another model under the same name is caught only if the digest is checked, so the proposer reads the digest from the endpoint at start and refuses on a mismatch.

## 9. Owner questions

1. May `ignore` of a gate failure become a rule when `superseded` is true (2 of 2 in the data)? v1 keeps `ignore` with a person, and this design keeps it so until you say otherwise. Default: no.
2. Should the bar also require the 95 % Wilson lower bound to be at or above 0.90 (it needs about 90 compared decisions per class at 97 % agreement), or is the point estimate at 30 enough, as in v1? Default: the point estimate at 30, as v1.
3. Do you approve moving C5 (all codes but `repeated_failure`), C7 `infra` / `needs_owner` and C8's infra codes from Tier 2 to Tier 1 (§4.2, "Re-tiering")? Default: approving this document approves it; every rule stays `shadow` either way.
4. May `outage.mode: act` (§4.7) be built and turned on after `observe` has shown its counts? Default: no; PR 7 waits for your yes, and `observe` is the most the other PRs do.
5. Should fill's sweep also withdraw an agents-module decision whose task is closed or reassigned (§4.1, "Closed tasks")? Default: no; those stay open and r3-closed-release answers them in shadow.
