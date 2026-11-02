# Decision brain v3: more rules, a real bench, abstain rules and a local-model shadow trial

- **Status:** design, docs only. Nothing here is built. The owner (or the orchestrator under the owner's delegation) approves this document before any code.
- **Base:** main `d2b3d8e`.
- **Related:** [decision-policies.md](decision-policies.md) (v1: classes C1-C14, tiers, promotion bars, approved 30 Oct 2026; §10-§12 describe what is built), [ai-spend.md](ai-spend.md) (the run classes behind "exited without done"), [planner.md](planner.md) (the blocked-line classifier), issues #211, #227, #228.

v1 built the machinery: structured evidence on decisions, a policy table, a rule proposer, a trace, an agreement view, a trainer and an outcome tracker. All of it is shadow only. A week of real use shows the built-in rules now answer almost nothing of what people actually answer. The classes that repeat today are not the ones the table covers, and the facts that decide them are not on the decision. This spec does four things:

1. **Tier-1 rules for today's repeating classes:** an agent that exited without reporting done, a PR held by the orchestrator, a block that needs the owner, and a gate that failed on infrastructure. Each class gets the facts that decide it, and a rule that abstains whenever a fact is missing.
2. **Bench v3:** score every proposer on all answered decisions, per class, from the decisions store, measured and never estimated.
3. **Abstain rules** shared by every proposer, so "I don't know" is the default answer.
4. **A shadow trial plan for a small local model:** a 90 % bar on the bench and in live shadow. A model below the bar never leaves shadow, and nothing in this design lets a model act.

## 1. Problem, with evidence

The numbers come from one busy project (16 to 36 agents, one orchestrating session answering for the owner) over 27 Oct to 2 Nov 2026. They are read from the Decision Inbox (`GET /api/decisions?status=...`). Structured `class` and `evidence` started on 31 Oct 04:04 UTC.

| Fact | Count |
|---|---|
| Decisions raised | 693: 320 answered, 368 withdrawn, 5 open |
| Answered with two or more options (real choices, not acknowledgements) | 285 |
| Answered since structured evidence started (31 Oct) | 155 |
| Answers equal to the option Lair recommended | 189 of 320 (59 %) |
| Answers the built-in rules (C1-C4, C11) would propose, replayed over the 285 with their own guards | **14 (4.9 %)**, all 14 right, all C1 `wait` |
| Answers that carry a note saying why | 279 of 320 |

The rules are never wrong, but they almost never answer. Since 31 Oct, half of the answered decisions (78 of 155) fall into four repeating classes that have no rule at all:

| Class (today's id and code) | Answered | Answers given | Lair's recommendation right | What decided it (read from the answer notes) |
|---|---|---|---|---|
| **Exited without done**: `agents.gave_up` / `exit0_no_report` | 14 | `keep_held` 8, `start_again` 6 | 8 of 14 | Whose move it is. `keep_held` when the agent's part was finished and the PR waited on someone else (a review at the head, a gate in the queue, an approval). `start_again` when the agent had work to do at its head (changes requested, no gate submitted yet) |
| **Blocked**: `agents.gave_up` / `blocked_reported` | 12 | `keep_held` 5, `start_again` 7 | 5 of 12 | What the block waits on and whether that cleared: another PR's merge, an owner approval at a head, host load, the container engine being back |
| **Gave up on a provider limit or repeated failure**: `agents.gave_up` / `provider_limit`, `repeated_failure` | 41 | `release` 22, `fresh_session` 18, `start_again` 1 | 22 of 41 | Whether the task is still open. All 22 `release` answers say the task was finished, merged, closed, parked or taken over by another agent. 17 of the 18 `fresh_session` answers say the cause cleared (the limit reset, a tool fix landed) and the task was still open |
| **Held by the orchestrator**: `review-holds.hold` / `hold_open` | 3 (and 4 still open) | `keep` 3 | 3 of 3 | The hold's reason still stands (a review fix round in progress). `release` is `outward` and stays with a person |
| **Blocked, needs the owner**: `planner.unblock` / `needs_owner` | 3 | `keep` 3 | 3 of 3 | Nothing: a block that needs the owner is never unblocked by a machine |
| **Gate failed on infrastructure**: `triage.gate_failure` / `infra_other` | 5 (and 9 unstructured before 31 Oct, 8 of them `fix-environment`) | `fix-environment` 1, `rerun` 2, `ignore` 2 | 1 of 5 | Whether the infrastructure is back (`rerun`), still down (`fix-environment`), or a newer gate at a newer head already replaced this one (`ignore`) |

Why no rule can answer them today:

- **The deciding facts are not on the decision.** Every `agents.gave_up` decision carries the same four facts: `agent`, `task`, `attempt_count`, `last_exit`. None of them says whether the task is still open, whose move it is, or what the block waits on. A hold carries only `ref`. A gate failure carries no infrastructure status and no "superseded" flag.
- **One class is not in the class table.** `review-holds.hold` is raised with `classKnown: false`, so the policy table refuses any rule that names it.
- **Facts are frozen at the raise.** Only `cause_cleared` and `linked_issue` can change later, and the trace writes one proposal per decision and table version. A block that clears an hour after the raise never gets a new proposal.
- **The bench does not measure what it reports.** The bench file in use has 111 cases from before structured evidence. It groups results by `kind`, not by class. Its rule model reads its own title-based rule format, not the policy table. The latest report estimated the model's numbers from the earlier run instead of measuring them. No bench run covers the four classes above.
- **Model confidence cannot be used to abstain.** On the 111-case bench, a 4B instruct model used as-is was right 77.5 % of the time. Every one of its 25 wrong answers had confidence 0.7 or higher (22.5 % wrong but confident). Its self-reported confidence is not a signal.

## 2. What exists today

Found with `git grep` on `github/main` over policy, proposer, evidence, bench, trainer, shadow, abstain, confidence, outcome, hold, blocked and gave_up in `src/server/decisions`, `src/server/agents`, `src/server/brain-*`, `src/server/outcomes`, `src/server/planner`, `src/server/triage`, `src/cli` and `docs/configuration.md`.

| What | Where | What it does | What is missing for v3 |
|---|---|---|---|
| Class table | `src/server/decisions/structure.ts:23-43` `KNOWN_DECISION_CLASSES` | 14 classes with their evidence codes; the policy table accepts only these | No `review-holds.hold` (or the other module holds), no list of which facts a class may update after the raise |
| Rule proposer | `src/server/decisions/policies/rules.ts:41` `RuleProposer`, `:19` `holds` | Matches class and code, checks `when` / `unless` over facts; a missing fact, tier 3, a never-default kind, an expired rule, an option not offered or not reversible all abstain | Nothing; v3 reuses it unchanged |
| Policy table and built-in rules | `src/server/decisions/policies/table.ts` `parsePolicyTable`, `DEFAULT_POLICIES_YAML` (C1, C2, C3, C4, C11) | Validated, fail-closed, hashed into a version | No rule for the classes of §1 |
| Policy states | `src/server/decisions/policies/types.ts:9` `POLICY_STATES = ["off", "shadow"]` | `suggest` and `act` are refused | Stays so in v3 |
| Trace and agreement | `src/server/decisions/policies/shadow.ts:38` `PolicyShadow`, `agreement.ts:11` `agreementRows`, `policies/index.ts:144` `GET /api/owner/decision-policies` (owner only) | One trace row per decision, proposer and version, written at the raise and at start; agreement counted in SQL | One proposal per version: a later evidence change is never re-proposed |
| Evidence updates | `src/server/decisions/service.ts:283` `updateEvidence`, `types.ts:124-137` | The raising module may change `cause_cleared` and `linked_issue` of an open decision, audited | No other fact can change |
| Store | `src/server/decisions/store.ts:37` `SCHEMA_VERSION = 6` | Decisions, outcomes (v5), `policy_trace` (v6) | No evidence revision on the decision or the trace row |
| Exited without done / blocked raisers | `src/server/agents/fill.ts:1077` (codes), `:1880-1893` `blocked_reported`, `:1895-1911` `exit0_no_report`; `:1158` `lineGone` (a held line gone from the tasks file); `config.ts:230` `max_completions_without_done` (3) | Hold the task and raise one decision with `agent`, `task`, `attempt_count`, `last_exit` | No task state, PR, review or gate state at the head, block target |
| Gave-up raiser | `src/server/agents/service.ts:2414` (`repeated_failure`, `dead_on_start`, `provider_limit`) | Same four facts | No task state, no reset-passed fact |
| Hold raiser | `src/server/decisions/holds.ts:110-135` | Class `<module>.hold`, code `hold_open`, facts `{ref}`, options `release` (outward) and `keep` (reversible), recommends `keep` | Class not known; no holder role, PR state or hold age |
| Planner block raiser | `src/server/planner/service.ts:701` `classifyBlocked`, `:762-763` | `needs_owner` or `infra`, facts `task`, `agent`, `block_class`, `rule` | `cause_cleared` for `infra` is never re-evaluated (decision-policies §11) |
| Gate failure raisers | `src/server/triage/gate-recheck.ts:685-686`, `src/server/triage/service.ts:1093-1094` | `infra_download` / `infra_other` / `same_failure_again`, facts `gate`, `sha`, `recheck_count`, `same_commit`, `network` | No infrastructure status now, no "superseded" |
| Host load | `src/server/agents/fill.ts:2830-2850` | Fill's start probe reads load and CPU count | Not a decision fact |
| Brain bench | `src/server/brain-bench/types.ts`, `cases.ts` (`parseCase`, with `at`, `recommended`, `outcome`), `models.ts:20` `ruleModel`, `:150` `ollamaModel` and an OpenAI-compatible model, `run.ts:5` `DEFAULT_THRESHOLD = 0.5`, `run.ts:64` `runBench`; CLI `src/cli/brain-bench.ts` | Scores models on a JSONL cases file, by `kind`: accuracy, abstain, wrong-but-confident, latency | No export from the store, no per-class report, no policy-table model, no recommended-option baseline, no split, no provenance in the report |
| Brain trainer | `src/server/brain-trainer/config.ts:42` (`confidence_floor` 0.7), `split.ts:21` `timeSplit`, `examples.ts:9` `classKeyOf`, `shadow.ts:60-95` (veto of answers that turned out bad, abstain) | Nightly classifier in a container, shadow file, never answers | Its own trace file and its own floor; not a `Proposer` |
| Outcome tracker | `src/server/outcomes/rules.ts:39-147` (restart, hold, release, planner, merge) | good / bad / unknown after an answer | Nothing for v3 beyond reading it |
| Configuration | `docs/configuration.md` §Brain bench, §Decision policies, §Brain trainer, §Outcome tracker | `decision_policies.enabled` (default `false`) | New keys of §4.6 |

## 3. Gaps

1. The facts that decide the four classes (§1) are not on their decisions.
2. `review-holds.hold` is not a known class.
3. Facts cannot change after the raise (other than two), and a change never makes a new proposal.
4. No rule exists for the four classes.
5. The bench cannot read the store, does not report per class, does not run the live policy table, and has no baseline or provenance.
6. Abstaining is spread over three places with different rules (the rule proposer, the trainer's floor, the bench threshold of 0.5), and nothing abstains on stale facts, a class that is drifting, or two proposers that disagree.
7. No path takes a local language model from the bench to live shadow, and no single bar applies to it.

## 4. Design

### 4.1 Evidence v3: the deciding facts

Each raiser adds these facts at the raise. Facts hold codes, ids, numbers, booleans and times, never prose (as v1 §4). A fact the module cannot read is `null`, and a rule that needs it abstains.

| Class / code | New facts | Source |
|---|---|---|
| `agents.gave_up` (all codes) | `task_state`: `open`, `closed` (done, merged, retired, parked or gone from the tasks file) or `reassigned` (another agent's line names it); `pr`: number or null (from the run's last report line); `next_move`: `agent`, `other` or `null` (below); `fresh_sessions`: count for this task | The tasks file fill already reads each check; the bus report; review and gate state |
| `exit0_no_report` | `review_at_head`: `approve`, `request_changes`, `none` or null; `gate_at_head`: `pass`, `fail`, `queued`, `none` or null; `hold_on_pr`: boolean | Review store and gate results for `pr` at its current head |
| `blocked_reported` | `block_class`: the planner's existing classifier (`src/server/planner/blocked.ts:15` `classifyBlocked`, the same patterns) on the BLOCKED line: `owner`, `environment` or `task`; `block_target`: `pr`, `host_load`, `environment` or `unknown`, from a new fixed pattern list (a PR reference, a load reference) applied after it; `blocked_on_pr`: number or null; `blocker_cleared`: boolean or null | `pr`: that PR merged or closed. `host_load`: fill's probe load per CPU below its start limit. `environment`: the infra monitor's probe for the lane is up. `block_class` `owner` or target `unknown`: always `null` (only a person clears it) |
| `provider_limit` | `limit_reset_passed`: boolean or null | The reset time the agents module already parses (decision-policies §11) |
| `repeated_failure`, `dead_on_start` | `cause_cleared` (exists), `last_exit` (exists) | Unchanged |
| `review-holds.hold` (new known class) | `holder_role`: `owner`, `orchestrator`, `policy` or `agent` (a role, never a name); `pr_state`: `open`, `merged` or `closed`; `hold_age_minutes`; `head_changed_since_hold`: boolean | The hold record and the PR |
| `planner.unblock` | `cause_cleared` for `infra` re-evaluated (closes the decision-policies §11 gap) | The infra monitor |
| `triage.gate_failure` (infra codes) | `infra_up`: boolean or null, from the infra monitor's probe of the gate's lane; `superseded`: boolean, true when a newer gate on the same branch at a newer head exists, or the PR is closed | Infra monitor; gate queue and results |

`next_move` is computed by one function: `other` when `gate_at_head` is `queued`, `hold_on_pr` is true, or `review_at_head` is `approve` with a passing gate; `agent` when `review_at_head` is `request_changes`, or `gate_at_head` is `none` or `fail` with no hold; `null` otherwise, including when `pr` is null.

**Live facts.** Each known class gets a `live` list in `KNOWN_DECISION_CLASSES`: the facts its module re-evaluates at every check while the decision is open (`task_state`, `next_move`, `review_at_head`, `gate_at_head`, `blocker_cleared`, `limit_reset_passed`, `pr_state`, `infra_up`, `superseded`, plus the existing two). `updateEvidence` accepts a fact only if it is in its class's `live` list. It stays limited to the raising module and open decisions, a value equal to the current one changes nothing, and each real change is audited as `evidence_updated` and bumps the decision's `evidence_rev` (new column; the store goes to the next free schema version, 7 on main today, and files of versions 1 to 6 gain it on open, with a test per version). Every fact update stamps `facts_at` with the time it was read.

### 4.2 Tier-1 rules v3 (all `shadow`, `max_tier: 1` unless said)

Added to the built-in table, and kept to options that are `reversible` or `frees_task`. The column "On the data" is the answer the rule gives on the answered decisions of §1, labelled by hand from the answer notes. Bench v3 (§4.3) measures it for real once PR 1 records the facts.

| Id | Class / codes | When | Unless | Answer | On the data |
|---|---|---|---|---|---|
| r3-closed-release | `agents.gave_up` / `provider_limit`, `repeated_failure`, `dead_on_start` | `task_state` in `closed`, `reassigned` | none | `release` | 22 of 22 |
| r3-reset-fresh | `agents.gave_up` / `provider_limit` | `task_state` eq `open`, `limit_reset_passed` eq true | `fresh_sessions` gte 3 | `fresh_session` | 12 of 12 |
| r3-cleared-fresh (`max_tier: 2`) | `agents.gave_up` / `repeated_failure` | `task_state` eq `open`, `cause_cleared` eq true | `fresh_sessions` gte 3 | `fresh_session` | 5 of 5 (the sixth names no cleared cause and abstains) |
| r3-other-move-keep | `agents.gave_up` / `exit0_no_report` | `next_move` eq `other` | `task_state` ne `open` | `keep_held` | 8 of 8 |
| r3-agent-move-start | `agents.gave_up` / `exit0_no_report` | `next_move` eq `agent`, `task_state` eq `open` | `attempt_count` gte 5 | `start_again` | 6 of 6 |
| r3-blocked-keep | `agents.gave_up` / `blocked_reported` | `blocker_cleared` eq false | none | `keep_held` | 5 of 5 |
| r3-blocked-start | `agents.gave_up` / `blocked_reported` | `blocker_cleared` eq true, `task_state` eq `open` | `block_class` eq `owner` | `start_again` | 5 of 7 (2 were "not really blocked" corrections that no fact shows; those abstain) |
| r3-hold-keep | `review-holds.hold` / `hold_open` | `pr_state` eq `open` | `head_changed_since_hold` eq true | `keep` | 3 of 3 |
| r3-owner-block-keep | `planner.unblock` / `needs_owner` | none | none | `keep` | 3 of 3 |
| r3-infra-unblock | `planner.unblock` / `infra` | `cause_cleared` eq true | none | `unblock` | (v1 C7) |
| r3-infra-rerun | `triage.gate_failure` / `infra_other`, `infra_download` | `infra_up` eq true, `superseded` eq false | `recheck_count` gte 3 | `rerun` | 2 of 2 |
| r3-infra-fix | `triage.gate_failure` / `infra_other`, `infra_download` | `infra_up` eq false | none | `fix-environment` | 1 of 1, and 8 of 9 before 31 Oct |

Never a rule, whatever the data says: `release` of a hold (`outward`), `unblock` of an owner block, `ignore` of a gate failure (v1 C8 keeps it with a person; the 2 superseded cases abstain; see owner question 1), `stop`, anything merge-adjacent. Each class in `KNOWN_DECISION_CLASSES` gets a `never` list of option ids (`planner.unblock`: `unblock` for code `needs_owner`; `triage.gate_failure`: `ignore`; every hold: `release`), and the table refuses at load any policy that proposes one, as it refuses an `outward` option today. A hold whose head changed abstains, because the reason for the hold may be gone.

Replayed by hand on §1, these rules would propose on about 73 of the 78 answered decisions of the four classes (and C1 keeps its 14), and abstain on the rest. No hand-labelled case disagrees. That is the claim bench v3 must confirm on recorded facts before anyone relies on it.

### 4.3 Bench v3

**Corpus: every answered decision.** A new read-only export, `lair brain-bench export --store <decisions.db> --out <cases.jsonl> [--since <iso>]`, opens the store read-only (SQLite `mode=ro`) and writes one case per answered decision with two or more options: `id`, `at` (raised), `class` (or the trainer's `classKeyOf` key when it has none), `kind`, `module`, `evidence` (as stored at the answer, so the facts the person saw), options with `effect`, `label` (the answer), `recommended`, `outcome`. One-option decisions are counted as `notices` and left out. The answer note is never exported. The export is deterministic (ordered by `at`, then `id`), so the same store gives the same file and the same SHA-256.

**Proposers scored**, all through the same `runBench`:

- `policy:<table file or built-in>`: the live `RuleProposer` over the live table, not a separate rule format;
- `recommended`: Lair's own recommended option (the baseline every proposer must beat);
- `trainer:<best.json>`: the trainer's model;
- `ollama:<model>` / `openai:<model>`: a local model, through the existing models.

**Split.** Rules and `recommended` are scored on every case (they learn nothing). Trained models and calibration use a time split: train before `--cutoff`, test at or after it. A case raised before the cutoff and answered after it is left out of both (the trainer's `lateAnswers` rule).

**Report**, per class and overall: `n`, `proposed`, `coverage`, `answeredAccuracy`, `accuracy`, `abstain`, `wrongConfident` (wrong with calibrated confidence at or above the floor), `unsafe` (a proposal of an `irreversible` or `outward` option that was not the answer), the 95 % Wilson lower bound of `answeredAccuracy`, and latency p50 / p95. It carries provenance: the cases file's SHA-256, the store path's schema version, each proposer's id and version (table hash, model name and digest), the threshold, the cutoff, the Lair commit and the time. The CLI writes only measured numbers: there is no input for an estimate, and a report without provenance is refused by the view.

**Bench v3 is the measurement of record.** The first bench v3 report is part of PR 2's description: every class of §1, rules v3 against `recommended`.

### 4.4 Abstain rules (every proposer)

One function, `mustAbstain(decision, proposal, context)`, runs after every proposer, the rules included, before a trace row is written. Any reason makes the trace row's option `null` and records the reason code. In order:

| # | Reason code | When | Exists today? |
|---|---|---|---|
| A1 | `no_structure` | No `class` or no `evidence` | In the rule proposer; moved here |
| A2 | `tier_3` / `never_default_kind` | The class's `max_tier` is 3, or the kind is in `NEVER_DEFAULT_KINDS` (spend, pricing, legal, account, credentials, go/no-go, security) | In the rule proposer; moved here |
| A3 | `option_not_safe` | The option is not offered, or is `irreversible`, `outward` or has no effect | In the rule proposer; moved here |
| A4 | `fact_missing` | A fact the proposal used is missing or null | In the rule proposer (stays there; models report the facts they used as none, so A4 does not apply to them) |
| A5 | `facts_stale` | A `live` fact of the class was last read more than `max_fact_age_minutes` ago | New |
| A6 | `vetoed` | The same class, code and option was answered and later marked `bad` with the same facts signature (hash of code + sorted facts, ids removed) | In the trainer only; moved here |
| A7 | `class_drifting` | Over the last `class_guard.window` compared decisions of the class, this proposer's agreement is below `class_guard.min_agreement` | New |
| A8 | `proposers_disagree` | Another proposer at `shadow` traced a different non-null option for the same decision and evidence revision; both rows get the reason | New |
| A9 | `below_floor` | A model's calibrated confidence is below `confidence_floor` | New in this form; the trainer's raw floor stays for its own file |
| A10 | `uncalibrated` | A model without a calibration from bench v3 for this class | New |
| A11 | `repeat_loop` | The same task had the same class and code answered with the same option within the last 24 h, and it came back | New |
| A12 | `timeout` / `invalid_output` | A model call exceeded its timeout, or returned an option outside the offered ids or invalid JSON | In the bench (`BenchModelError`); live is new |

The agreement view counts each reason. An abstain is never a wrong answer, and it never counts toward coverage.

### 4.5 Shadow trial plan for a small local model

**Candidate.** A permissive-licence (Apache-2.0 or MIT) instruct model of 3 to 8 B parameters, quantised, served on the operator's machine by an Ollama or OpenAI-compatible endpoint, with JSON output constrained to `{option, reason_code, confidence}` and `option` an enum of the offered ids (`answerSchema` exists). The licence is read from the model card on the day of choice and recorded with the bench result. The bench picks the model, not a leaderboard.

**What the model sees:** `class`, `kind`, `module`, `evidence.code`, `evidence.facts`, the options (id, label, effect). It never sees the title, the context, an answer note, the recommended option, `outcome`, or anything from another decision. The data goes between fences and is treated as data (the bench's prompt today).

**Classes in the trial:** only classes with `max_tier: 2`, listed by name in `decision_brain.model.classes`. Tier-1 classes stay with rules, and tier 3 is never asked.

**Stages:**

| Stage | What runs | Gate to the next stage |
|---|---|---|
| T0 bench | Bench v3 test split, per class | For each class: `n` ≥ `bar.min_compared` (30), `answeredAccuracy` ≥ `bar.min_agreement` (0.90), `unsafe` = 0, `coverage` ≥ `bar.min_coverage` (0.60), `wrongConfident` ≤ `bar.max_wrong_confident` (0.02), and better than `recommended` on the same cases. A calibration (confidence bins to observed accuracy, fitted on the train split) is written with the result. A class that misses stays out of T1 |
| T1 live shadow | The model is a `Proposer` (`id: model:<name>@<digest>`), called on `decision.raised` and on each `evidence_rev` change for its classes, writing trace rows. Nothing is shown with the decision | For each class: the T0 bars again on live trace rows, over at least `bar.min_days` (14) days and `bar.min_compared` compared decisions, with no A12 rate above 5 %. The view then shows the class as **eligible** |
| T2 | Not in this design. A later design may add `suggest` for an eligible class, and only on the owner's recorded approval (decision-policies §9) | — |

**Never act below the bar.** `suggest` and `act` stay refused by the table and by the model config. Eligibility is computed, never set by hand. A class that falls below any bar over its last `bar.min_compared` rows loses eligibility at once and raises one notice decision (`decision_brain.eligibility_lost`, `noted` only). A model or calibration change (a new digest) restarts both T0 and T1 for every class.

**Running it safely.** Calls go off the event loop, one at a time, through a bounded queue (`max_pending`; when it is full, the oldest call is dropped and traced as `timeout`), each with `timeout_seconds`. A timeout or an error is an abstain, never an answer. The endpoint must be a loopback address unless `allow_remote_endpoint` is true, and with no host allow-list. The request holds no secrets: evidence holds only codes and ids. The model proposer gets the same four-member reader the rule shadow has (get, list open, record trace), with no means to answer, withdraw or raise.

### 4.6 Configuration (observe first)

Everything is off by default. Turned on, everything writes only evidence and trace rows. Nothing answers.

```yaml
decision_policies:
  enabled: false                # exists
  live_facts: false             # raisers re-evaluate the `live` facts of their open decisions (evidence only)
  repropose_on_update: true     # a new evidence_rev gets a new trace row (needs live_facts)
  max_fact_age_minutes: 30      # A5; 1-1440
  class_guard:
    window: 20                  # A7; 5-500
    min_agreement: 0.95         # A7; 0.5-1
decision_brain:
  model:
    enabled: false
    api: ollama                 # ollama | openai
    endpoint: ""                # required when enabled; loopback only unless allow_remote_endpoint
    allow_remote_endpoint: false
    model: ""                   # required when enabled
    digest: ""                  # required when enabled: the served model's content digest
    calibration_file: ""        # required when enabled: written by the T0 bench run
    classes: []                 # explicit list; each must have max_tier 2 in the table
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

A section with an unknown key, a value out of range, a `state` other than `shadow`, a class with `max_tier` other than 2, or `enabled: true` with a required key empty is refused: that part stays off, and the reason is logged and shown in the view (as `brain_trainer` does). Read once at start.

Routes: `GET /api/owner/decision-policies` (exists, owner only) gains per-proposer rows, abstain reasons, eligibility per class and the latest bench report's provenance. No new mutating route: bench reports are written by the CLI to `data/brain/bench/` and read by the route.

## 5. Acceptance tests

Each test drives the real entry point (the raiser's check, `decision.raised`, `updateEvidence`, the CLI's `main`, the route). It feeds payloads copied from the emitters on main (`fill.ts`, `holds.ts`, `gate-recheck.ts`, `planner/service.ts`) and fakes only one named boundary: the clock, the model endpoint (an HTTP fake), or the tasks file contents.

| # | Name | Given / when | Then |
|---|---|---|---|
| AT-1 | `gaveUpCarriesTaskState` | A task held for `provider_limit`; its line in the tasks file is open, then marked done, then gone, then claimed by another agent | `task_state` is `open`, `closed`, `closed`, `reassigned`; with `live_facts: false` it stays as raised |
| AT-2 | `exit0NextMove` | `exit0_no_report` with a PR whose head has: an approve review and a passing gate; a queued gate; changes requested; no gate; no PR | `next_move` `other`, `other`, `agent`, `agent`, `null` |
| AT-3 | `blockedFacts` | BLOCKED lines naming: another PR (open, then merged); an owner approval; host load (above, then below the start limit); an unparseable reason | `block_target` / `blocker_cleared`: `pr`/false then true; (`block_class` `owner`)/null; `host_load`/false then true; `unknown`/null |
| AT-4 | `holdIsKnownClass` | A hold raised by the review module | `classKnown: true`; facts `holder_role`, `pr_state`, `hold_age_minutes`, `head_changed_since_hold`; a policy naming `review-holds.hold` loads |
| AT-5 | `gateInfraFacts` | An `infra_other` failure; the lane probe up, down, timing out; a newer gate on the same branch at a newer head | `infra_up` true, false, null (a probe timeout is never "up"); `superseded` true |
| AT-6 | `liveFactsOnlyListed` | `updateEvidence` from the raising module with a listed fact, an unlisted fact, the same value again, and from another module | Applied and audited with `evidence_rev` +1; refused; no change and no audit; refused |
| AT-7 | `schemaV7Migration` | Real store files of versions 1 to 6 | Open with `evidence_rev` 0, no row lost |
| AT-8 | `rulesV3Shadow` | One decision per row of §4.2, with the facts that match, and the same with each `when` fact missing and each `unless` holding | Each traces its answer with confidence 1; each variant abstains with `conditions_not_met`, `fact_missing` or `guard`; no decision is answered (the decision is unchanged and has no answer) |
| AT-9 | `neverRuleOptions` | A table that proposes `release` for a hold, `unblock` for `needs_owner`, `ignore` for a gate failure, and `unblock` for `infra` | The first three are refused at load, each naming the class's `never` list (the others in the file still load); the last loads |
| AT-10 | `reproposeOnUpdate` | A `blocked_reported` decision raised with `blocker_cleared` false, later true | Two trace rows (rev 0 `keep_held`, rev 1 `start_again`); a restart writes neither again; agreement uses the last row before the answer |
| AT-11 | `abstainOrder` | One decision per abstain reason A1-A12 (stale facts by the fake clock; a vetoed signature; a class with 20 compared decisions at 0.90; two proposers with different options; a model with confidence below the floor; a model without calibration; a repeat within 24 h; a model endpoint that hangs past its timeout and one that returns an id not offered) | Each traces `option: null` with its reason code; the view counts each reason; none counts toward coverage |
| AT-12 | `benchExportReadOnly` | A store with answered, withdrawn, open and one-option decisions, and an answer note holding a marker string | Only answered multi-option decisions are exported; notices counted; the marker is absent from the file; the store's bytes and mtime are unchanged; two exports give the same SHA-256 |
| AT-13 | `benchPerClassWithProvenance` | The exported file; proposers `policy:built-in`, `recommended`, and a fake endpoint model | Per-class rows with every metric of §4.3; the report holds the file hash, table version, model name and digest, cutoff and commit; a hand-edited report without provenance is refused by the route |
| AT-14 | `benchSplitNoLeak` | Cases before, after and across a cutoff | Rules on all; the model trained and calibrated only before; cases answered across the cutoff in neither |
| AT-15 | `modelConfigRefused` | `decision_brain.model` with `state: act`; a remote endpoint without `allow_remote_endpoint`; a class with `max_tier: 1`; `bar.min_agreement: 0.8`; enabled with no digest | Each refused with its key named; the model stays off; the server starts |
| AT-16 | `modelShadowOnly` | Model on in shadow for one class; the fake endpoint answers | A trace row with the calibrated confidence; the decision is unchanged; the proposer's reader has exactly four members; the request body holds no title, context or answer note |
| AT-17 | `modelQueueBounded` | 50 decisions raised at once with `max_pending: 20` and an endpoint that sleeps | At most one call in flight, 30 traced as `timeout`, the event loop lag check stays green |
| AT-18 | `eligibilityNeverBelowBar` | Trace rows for a class at 29 compared / 0.95; 30 / 0.89; 30 / 0.93 over 13 days; 30 / 0.93 over 14 days with one unsafe; 30 / 0.93 over 14 days clean; then 5 wrong in a row | Not eligible, not eligible, not eligible, not eligible, eligible, then not eligible again with one `eligibility_lost` notice (a restart raises no second one) |
| AT-19 | `digestChangeResets` | An eligible class, then a new model digest | Not eligible; T0 needed again |
| AT-20 | `offWritesNothing` | All switches at their defaults, every raiser and the CLI export run | No trace row, no `evidence_rev` change, no model call; the route shows everything off |

## 6. Security and privacy

- **No new mutating route.** The only route change adds fields to an owner-only GET.
- **Nothing answers.** Every proposer gets the four-member reader, and AT-8, AT-16 and AT-20 check that the decision is unchanged.
- **No shell.** The CLI reads a file and the store; the model call is an HTTP request with a timeout. No command is built from data.
- **No secrets or names.** Facts hold codes, ids, numbers and roles (`holder_role`, never a person). The export drops answer notes, titles and context. The model request is built from the same fields, and AT-16 scans its body.
- **Fail closed.** An unknown fact, a stale fact, a timeout, invalid output, an unparseable block reason or a missing calibration is an abstain. A probe timeout is `null`, never "up".
- **Idempotent.** One trace row per decision, proposer, version and `evidence_rev`; one `eligibility_lost` notice per loss (keyed by class and model digest); an evidence update with the same value writes nothing.

## 7. Build PRs, in order

Each PR is separate, at most about 600 changed non-test lines, wired behind its switch, with docs in `docs/configuration.md`, and merges on its own.

1. **Evidence v3 for agents.** The `agents.gave_up` facts (`task_state`, `pr`, `review_at_head`, `gate_at_head`, `next_move`, `fresh_sessions`, `block_class`, `block_target`, `blocked_on_pr`, `blocker_cleared`, `limit_reset_passed`) at the raise. The `live` list per class, the `updateEvidence` allow-list, `evidence_rev` and `facts_at` (store version 7 with migration tests), and `decision_policies.live_facts`. ATs 1-3, 6, 7, 20.
2. **Bench v3.** `brain-bench export`, the `policy:` and `recommended` proposers, the per-class report with the Wilson bound and provenance, the split. The PR description holds the first bench v3 report. ATs 12-14.
3. **Holds, planner and triage facts.** `review-holds.hold` (and the delivery module's hold) as known classes with their facts; planner `infra` `cause_cleared` re-evaluation; triage `infra_up` and `superseded`. ATs 4, 5.
4. **Rules v3 and re-proposal.** The §4.2 rows in the built-in table (shadow), and `repropose_on_update`. ATs 8-10.
5. **Abstain rules.** `mustAbstain` with A1-A12 (A9, A10 and A12 have no effect until PR 6), `max_fact_age_minutes`, `class_guard`, reason counts in the view. AT-11.
6. **Model shadow (T1) and eligibility.** The `decision_brain` section, the model `Proposer` on the existing bench models, calibration from the T0 bench run, the bounded queue, eligibility and its notice, the view's eligibility column. ATs 15-19.

PR 1 is needed by PRs 3-6; PR 2 can go in parallel with PR 1 and is rerun after each later PR.

## 8. Risks

- **The hand labels flatter the rules.** §4.2's "on the data" column is read from notes by hand. Bench v3 on recorded facts is the real check, and a rule that misses 95 % there stays `off` in the built-in table.
- **Facts become prose by another name.** `block_class` and `block_target` come from regex patterns over a BLOCKED line. `unknown` must stay common rather than guessed, and AT-3 covers the unparseable case.
- **Live facts add load.** Re-reading review and gate state for every open decision each check could be slow on a busy store. Each fact is read at most once per check from data fill already loads, and the event-loop lag self-check is the alarm.
- **Labels are one person's habits.** The orchestrating session's answers are labels (decision-policies §9). A habit that later turns out wrong shows up as `bad` outcomes, and A6 and A7 stop proposing it.
- **Small classes never reach 30.** Holds, owner blocks and gate infrastructure see a few a day, so they may take weeks to reach the bar. That is intended: the bar does not drop for low volume without the owner (decision-policies §5).
- **A model drifts silently after an endpoint update.** The digest is required, and a changed digest resets eligibility (AT-19). An endpoint that serves another model under the same name is caught only if the digest is checked, so the proposer reads the digest from the endpoint at start and refuses on a mismatch.

## 9. Owner questions

1. May `ignore` of a gate failure become a rule when `superseded` is true (2 of 2 in the data)? v1 keeps `ignore` with a person, and this design keeps it so until you say otherwise.
2. Should the bar also require the 95 % Wilson lower bound to be at or above 0.90 (it needs about 90 compared decisions per class at 97 % agreement), or is the point estimate at 30 enough, as in v1?
