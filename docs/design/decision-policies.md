# Decision policies: letting Lair answer its own machine-readable decisions

> Status: design, docs only. Nothing here is built; the owner approves this document before any code. Related: [supervisor.md](supervisor.md) (S3 `supervisor.act`), [ai-roles.md](ai-roles.md), [autonomy.md §8](autonomy.md) (learning loop).

## 1. Why, and what the data says

Lair raises a decision whenever it cannot or should not continue alone. Most of those decisions are machine-readable already: a module, a kind, a fixed list of option ids, and evidence that is a handful of facts. A person (or a large model standing in for one) still answers them, one at a time.

This design is built from the first four days of a real deployment (27-30 Oct 2026, one busy project with about 36 agents, one orchestrating session standing in for the owner):

| Fact | Count |
|---|---|
| Decisions raised | 379 |
| Answered by a person | 117 |
| Withdrawn by Lair when the cause cleared (nobody needed to answer) | 217 |
| Still open at the cut | 45 |
| Answered where the answer equals the option Lair itself recommended | 73 of 117 (62%) |

Two things follow.

1. **57% of decisions needed no answer at all.** The breach cleared, the check recovered, or the hold lifted before anyone looked. That is a rule about *waiting*, not a model.
2. **Where the answer was not the recommendation, the reason was almost always evidence Lair did not carry** (the provider's daily limit, Docker down after a reboot, a verifier that had already rejected a planner proposal). Machine-readable evidence (section 4) moves more decisions into the rule column; a model only helps with what is left.

Source records: Lair's decisions store (kind, title, context, options, recommended option, answer option, answer note, source module) and the orchestrator's structured decision log (`situation`, `chosen`, `reason`, `outcome`, 50 records, 20 marked good, 1 bad, 29 pending outcome). Names of projects, people and hosts are left out of this document on purpose.

## 2. Decision classes (the policy table)

Counts are decisions raised in the four days. "Answers" is the split of the answers given. Classes are matched on `(source module, kind, evidence code)`, never on title text.

| # | Class | Matching fields | Seen | Answers given | Answer a rule would give | Reason (as given) | Guard conditions |
|---|---|---|---|---|---|---|---|
| C1 | All profiles of an agent failing or rate-limited | module `agents`, kind `escalation`, evidence `provider_error` = rate limit or daily quota (HTTP 429) | 153 (108 withdrawn, 38 answered, 7 open) | `wait` 38 of 38 | `wait` | A provider limit clears by itself; stopping frees tasks that have no agent to run them | Do not `wait` if the same agent was already waited on N times and the limit reset time has passed; escalate then |
| C2 | Self-check failing (event-loop lag, latency, timeouts, unreachable machines, infra holds) | module `supervisor`, kind `other`, evidence `check_id`, `value`, `threshold`, `failing_since` | 49 (41 withdrawn, 7 answered, 1 open) | `noted` 7 of 7 | `noted`, with a pointer to the open issue for that `check_id` | Known cause, fix in progress | Only when an open issue is linked to the `check_id`; a value above the "critical" threshold or a new `check_id` goes to the owner |
| C3 | Idle capacity: ready work but nothing started | module `watchdog`, kind `escalation`, detector `idle_capacity`, evidence `ready_count`, `running_count`, `last_start`, `playbook_attempts` | 14 (all withdrawn) | `stand_down` | `stand_down` when the playbook already ran twice and the queue shows a gate waiting for a busy lane | The probe under load misreads; the breach clears itself | Do not stand down if `ready_tasks` > 0 and `running_count` = 0 for more than a threshold |
| C4 | Orphaned claim: claim file with no live process | module `watchdog`, detector `orphan_claim`, evidence `claim_age_min`, `process_found`, `release_exit_code`, `release_refusal` | 9 (7 withdrawn, 2 answered `stand_down`) | `stand_down` 2 of 2 | `stand_down` if the release script refused because a runner is alive; `release` only if no process and exit code is not "refused" | The runner was alive and the job finished normally | Never release a claim whose process check is stale or errored |
| C5 | Agent gave up or paused after repeated attempts | module `agents`, kind `escalation`, evidence `attempt_count`, `failure_class` (`provider_limit`, `dead_on_start`, `exit0_no_report`, `blocked_reported`), `last_exit` | 79 (answered: `fresh_session` 15, `start_again` 11, `release` 4; 14 withdrawn) | Depends on `failure_class` | `provider_limit` -> `release` after the reset time; `dead_on_start` -> `fresh_session`; `blocked_reported` -> `start_again` only after the blocker is marked cleared | Provider limit: the failures were not the task. Dead on start: a new session fixes a corrupt resume | Cap fresh sessions per task (3); a task with a failing gate or a human-set hold goes to the owner |
| C6 | Planner proposes edits to the tasks file | module `planner`, kind `other`, evidence `proposal_ops[]` (`add`/`finish`/`unblock`/`reword`), `verifier_verdict`, `writer_conflict` | 28 (27 answered) | `approve_all` 11, `reject_all` 9 (plus others) | `reject_all` when the verifier rejected any op; `approve_all` when every op passes the verifier and none touches a DONE task | A rejected op is wrong; rewording a DONE task reopens it and duplicates work | Rule is only safe in the reject direction. Approval stays shadow-only until promotion (section 5); this is the class where the recommended option was right only 12 of 27 times |
| C7 | Planner: agent blocked, planner asks to unblock or keep | module `planner`, kind `escalation`, evidence `block_reason_code` (`infra`, `waiting_on_gate`, `needs_owner`), `cause_cleared` | 8 | `unblock` 3, `keep` 4, `continue` 1 | `unblock` when `block_reason_code` = `infra` and `cause_cleared` = true; otherwise `keep` | The commit block was environmental and the load dropped | `needs_owner` is never unblocked by a rule |
| C8 | Gate failure triage | module `triage`, kind `escalation`, evidence `failure_pattern` (`infra_download`, `docker_down`, `test_assertion`), `recheck_count`, `same_commit` | 9 | `fix-environment` 8, `ignore` 1 | `fix-environment` when `failure_pattern` is an infra pattern and the infra status shows the cause; `real` otherwise | Docker was down after a reboot; the later gates supersede it | A failure at the same commit twice with no infra evidence is `real` by default (the recommendation Lair already makes); `ignore` stays with a person |
| C9 | Review stuck: no agent review of a RED-tier PR | module `review`, kind `escalation`, evidence `tier`, `reviewers_tried`, `last_run_failure_code` | 6 (1 answered, 5 open) | `request_agent_reviews_again` 1 | `request_agent_reviews_again` when the failure code is `run_variables_lost` or `provider_error`; else the owner | The reviewer run never started | Never `review_it_yourself` by a rule: that is a merge-adjacent decision |
| C10 | Automatic merge failed | module `review`, kind `other`, evidence `merge_error_code` | 1 | `merge_it_from_the_pr_s_page` | None | A merge is an outward-facing action | Always owner |
| C11 | Agent can't start (probe failed) / fill waiting too long | module `agents`, evidence `probe_error`, `wait_minutes` | 11 (all withdrawn) | `keep_held` | `keep_held` | The probe error is transient and clears | Only below a wait threshold |

Rows C1-C4 and C11 are 62% (236 of 379) of everything raised. They have a single answer in the data.

## 3. Which classes use what

Three tiers, in this order. A decision goes to the first tier that can answer it with its guard conditions met; otherwise to the next.

### Tier 1: pure rules (no model)

C1, C2, C3, C4, C11, and the `reject_all` direction of C6. Each is an `if` over the structured evidence fields plus guard conditions, kept in a policy table (`data/policies.yaml`) that Lair loads and validates: class id, match, answer, guards, rate limit, `expires`. Reasons:

- one answer was given every time (or nearly);
- the cause is a fact Lair can read (a provider code, a hold reason, a verifier verdict);
- being wrong costs little and is reversible (a wait that was unneeded ends at the next check).

A rule answers only when every guard holds and says why in the audit record. A rule with no recent match is flagged for removal.

### Tier 2: small classifier (shadow first)

C5 (which restart option), C6 approve direction, C7, C8, C9. The answer depends on a few evidence codes together plus some context (how many attempts, whether a gate is failing, what the last output says). A small local model, in shadow mode first.

- **Features** (structured only): `source_module`, `kind`, class id, evidence codes and numbers (attempt count, age in minutes, check value over threshold, load at the time), the option ids offered, the option Lair recommended, whether a linked issue exists, whether the cause-cleared fact is true, time of day, agent profile family. Free text (context, answer note) is allowed only for the stage B/D language models, as a bounded excerpt.
- **Labels**: the answered option id from Lair's decisions store, and from the orchestrator's decision log the `chosen` text mapped to an option id, filtered by `outcome` = `good`. Records with `outcome` = `bad` are negative examples (a rule must not repeat them; the one bad record is a stop sent to a whole process group). `pending` outcomes are not training labels until resolved.
- **Output**: `{option, reason_code, confidence}` only, constrained to the offered option ids.
- A prediction below the confidence floor, or an option outside the class's allowed set, is "abstain" and goes to the owner.

### Tier 3: stays with the owner or a large-model reviewer. Never delegated to rules or a small model

- **Money**: anything that changes spend, plans, or provider contracts, and any decision whose option consequences mention billing.
- **Merges**: C10, `review_it_yourself`, any approve/merge of a PR. The review tier (RED/AMBER/GREEN) decides who reviews; none of it is a small-model decision.
- **Security**: secrets, tokens, access, anything a security review flagged.
- **Deletes and irreversible actions**: removing data, history, branches, runs; releasing a claim whose process state is uncertain; a stop of any process group.
- **Decisions about the policy itself**: promoting or demoting a rule or model.
- Any decision with `attention` = notice-to-owner by configuration, any new class with no policy, and any class whose last N shadow comparisons disagreed.

Each class in the table carries a `max_tier` (1, 2 or 3) set by the owner; a class can only be promoted up to its `max_tier`.

## 4. Machine-readable evidence: what each module must put on a decision

Today the evidence is prose in `context` and the option list carries free-text labels. A rule cannot match prose reliably. Each decision gets a structured `evidence` object next to `context` (prose stays for the person):

```json
{
  "class": "agents.provider_limit",
  "evidence": {
    "code": "provider_rate_limit",
    "facts": {"agent": "agent-a", "profiles_failing": 2, "attempts": 3,
              "limit_resets_at": "2026-10-31T00:00:00Z", "task": "task-42"},
    "cause_cleared": false,
    "linked_issue": null
  },
  "options": [{"id": "wait", "effect": "reversible"}, {"id": "stop", "effect": "frees_task"}]
}
```

Required for every module:

| Field | Meaning |
|---|---|
| `class` | Stable class id, `module.name`. The match key. Never derived from the title |
| `evidence.code` | One value from a fixed enum per class (for example `provider_rate_limit`, `provider_error`, `dead_on_start`, `exit0_no_report`, `docker_down`, `infra_download`, `check_failing`, `claim_orphan`, `verifier_rejected`) |
| `evidence.facts` | Flat key-values, numbers as numbers, times as ISO-8601; ids not names |
| `evidence.cause_cleared` | Boolean, set by the module that raised the decision, re-evaluated at every check |
| `evidence.linked_issue` | Issue number if a known cause is tracked, else null |
| `options[].effect` | Enum: `reversible`, `frees_task`, `irreversible`, `outward`. `outward` and `irreversible` are Tier 3 by construction |
| `recommended_reason_code` | Code (not prose) for why Lair recommends its option |

Per module, the minimum new codes: **agents** (provider code, attempt count, failure class, reset time), **watchdog** (detector, playbook attempts, release exit code and refusal reason, process found), **supervisor** (check id, value, thresholds, failing since, linked issue), **planner** (per-op list with op type, verifier verdict per op, writer conflict, touches-DONE flag), **triage** (failure pattern, re-check count, same-commit flag, infra status), **review** (tier, reviewers tried, last failure code, merge error code). A decision without `class` and `evidence.code` is Tier 3 by default.

`links` and `decision_blocks` stay as they are. Add a nullable `policy_trace` column (section 5) rather than overloading `answer_note`.

## 5. Shadow mode and promotion

Every proposer, whether a rule, the classifier or a language model, has a state per class:

`off` -> `shadow` -> `suggest` -> `act`

- **shadow**: the proposer runs when the decision is raised and writes `{class, proposer, version, option, reason_code, confidence}` to the `policy_trace`. Nothing is shown to the person that could bias them; the answer is compared after it is given.
- **suggest**: the proposal is shown with the decision as a pre-selected option; the person still answers. Agreement is still measured against the answer given, and a person overriding it records a reason code.
- **act**: the proposer answers by itself, through the same answer path as a person (so withdrawal, audit and "this can be undone" apply), marked `answered_by` = the policy id and version. Allowed only up to the class's `max_tier`.

Metrics per class and proposer, from the trace joined to the answer:

| Metric | Meaning |
|---|---|
| `agreement` | Proposal equals the answer given |
| `unsafe_disagreement` | Proposal was an `irreversible` or `outward` option and the answer was not that option; target is 0, one occurrence blocks promotion |
| `coverage` | Share of decisions the proposer did not abstain on |
| `outcome_good` | Share of agreed decisions later marked good |

**Promotion rules** (defaults, in config, owner-editable):

- shadow -> suggest: at least 30 comparisons for the class (at least 15 for low-volume classes only with the owner's explicit OK), agreement at least 95% for rules and 90% for models, `unsafe_disagreement` = 0, `coverage` at least 60%.
- suggest -> act: a further 50 decisions with the same bars, no `outcome_good` below 95%, and the owner's approval recorded. The first promotion of any class to `act` is always an owner decision.
- **Demotion**: any `unsafe_disagreement`, or agreement under the bar over the last 20, drops the class one state and raises a decision. Rate limit on `act`: N answers per class per hour; a burst pauses the class.
- A rule or model change resets the class to `shadow` unless the change only removes a match.

Baselines from the data: Lair's own "recommended option" agrees with the answer 62% overall (C6 planner only 44%), so the bar is far above what the status quo gives; C1, C2, C4 already show 100% on a handful of repeats and would pass on 30 comparisons within days.

## 6. Model roadmap

Each stage is measured on the same **brain bench**: the labelled decision set (`work/brain/bench/decisions-v1.jsonl`, built from the decisions store plus the orchestrator's decision log, with a held-out split by date so later decisions are never used to train earlier ones). Score: top-1 agreement, `unsafe_disagreement`, abstain rate, latency, memory. A stage replaces the previous one for a class only when it beats it on the bench **and** passes shadow promotion on live decisions. No stage is skipped. No pre-training from scratch: it needs far more data and compute than this problem has, and gives nothing a fine-tune does not.

| Stage | What | Data needed | Where it runs |
|---|---|---|---|
| **A: rules** | Section 3 Tier 1 over structured evidence | The policy table (this document); a few dozen examples per class to check guards | In Lair, no model |
| **B: open-source small model as-is** | A small instruct model, JSON-constrained to `{option, reason_code, confidence}` with the offered option ids as an enum, in shadow mode for Tier 2 classes | None for training; the bench for choosing the model | Local, quantised, on the owner's machine (Apple Silicon, 24 GB: a 3-8B model at 4-8 bit fits) |
| **C: our own small classifier** | Gradient-boosted trees (or logistic regression) over the structured evidence features of section 3; no language model | A few hundred labelled decisions (the 117 answered plus the decision log and each new answer); needs cross-validation by date | In Lair, millisecond latency, no GPU, fully explainable (feature importances go into the trace) |
| **D: LoRA fine-tune of an open small model** | Fine-tune on Lair's decisions, lessons and outcomes: input = class, evidence, options, bounded context; output = the JSON answer | About 1,000 or more examples with outcomes; a held-out set; lessons added as extra examples | Local, with MLX on Apple Silicon (a 3-4B model fits for LoRA on 24 GB); adapters are small files |

Model choice for stage B: permissive licences preferred (Apache-2.0 or MIT): the Qwen2.5 and Qwen3 3B-8B instruct models, Mistral small models, Phi. Llama family models carry a restrictive community licence (use limits, naming and attribution terms) and are not preferred; a licence is read from the model card on the day of the choice and recorded with the bench result. The shortlist and licence notes live with the brain records (`bench/candidates.md`); the bench, not a leaderboard, picks the model.

Rules for all stages:

- the model only chooses among the offered option ids; output outside the enum is invalid and counts as abstain;
- the language-model stages never see secrets; evidence has no tokens, only ids and codes;
- training data is local. A cleaned, project-neutral dataset (no project, people, emails, paths or hosts) may be published later, with the adapter, if the owner decides; nothing is published by default;
- the stage that answers a class is a per-class setting, so stage A, C and D can run side by side and the bench shows which is best for each class.

## 7. How this plugs into the rest of Lair

**Supervisor act (`supervisor.act`, S3, issue #175).** `supervisor.act` already names an allowlist of acting ops (`release_hold`, with its evidence rule: "needs evidence that the cause was infrastructure"). The policy table is that allowlist's source of truth: a policy at state `act` is exactly an allowlisted op with a match and guards. Rules for it:

- a policy answers through the same ops API and audit the supervisor uses (rate limits per op, audit in `data/supervisor.db`);
- the allowlist default stays none; a class is added only by promotion (section 5), and only up to its `max_tier`;
- `release_hold` is the first one built, as the C1/C11 rule with `cause_cleared` or infra evidence as its guard; the supervisor's hourly review reads the trace and proposes promotions and demotions as decisions of their own.

**Learning loop PR 5 (decision store, brain bench, model per role).**

- the decision store in PR 5 gets `class`, `evidence` and `policy_trace` columns (section 4); the existing JSON-lines brain records import into it;
- the brain bench is a first-class object in PR 5: a labelled set, a frozen split, a runner that scores a proposer (rule table, classifier or model) and stores the result;
- "model per role" in `ai-roles.md` gets a role `decide` next to `supervise` and `review`: the setting names the stage per class (rules, classifier, local model with a model id) and the fallback (the owner);
- review calibration (PR 4) and decisions share the same record store and the same bench runner; reviews stay Tier 3.

## 8. Rollout (each a separate PR, after the owner approves this document)

1. Structured `class`/`evidence`/`options[].effect` on the decisions of every module, with the schema check; no behaviour change.
2. Policy table, the proposer interface and the trace column, rules in `shadow` only; agreement dashboard on the Decisions view.
3. Promotion machinery, demotion, rate limits; C1, C2, C3, C4 and C11 to `suggest`, then `act` on the owner's approval.
4. Brain bench in the learning-loop store; stage B model in shadow for C5-C9.
5. Stage C classifier once a few hundred labelled decisions exist; stage D when the label count and the bench justify it.

## 9. Owner decisions (30 Oct 2026)

The owner approved this design on 30 Oct 2026 and answered its open questions:

- **Bars (section 5):** approved as written: at least 30 comparisons, at least 95% agreement for rules and 90% for models, no unsafe disagreement, and the owner's approval for the first promotion of any class to `act`.
- **C9 (`request_agent_reviews_again` after a reviewer failed to start):** may reach `act` once it meets the bars. Its `max_tier` is 2.
- **Labels:** decisions answered by the orchestrating session count as the owner's labels; `outcome` marks the ones that turned out wrong, which become negative examples.
- **Stage D (publishing a cleaned dataset and a fine-tuned adapter):** decided later, when there is a model worth sharing.

## 10. As built: the brain trainer (stage C, shadow only)

Issue #222 (30 Oct 2026). The owner asked to start training now and keep improving, without letting any model act until it earns it. What exists, and where it differs from the design above:

- **Nightly run** (`brain_trainer` in `data/server.yaml`, off by default): labels from the answered decisions (and an optional cases file in the bench format), a time split by cutoff, a gradient-boosted classifier fitted in a container with pinned dependencies and no network, scored with the brain bench's own runner per class, beside Lair's recommended option on the same window. Configuration and files: [Brain trainer](../configuration.md#brain-trainer).
- **Labels today.** The decisions store has no `class`, `evidence` or `outcome` yet (rollout step 1, §4). Until it has, a decision's class is `module/kind/option ids` and its features are those plus the offered and recommended options, links, blocks and the hour; richer evidence and outcomes come in through the cases file. When step 1 lands, the same code reads the structured fields without a change of interface.
- **Shadow.** The best model writes `{class, proposer, version, option, reason_code, confidence}` for each decision raised. The §5 `policy_trace` column does not exist yet, so the trace is a file (`data/brain/shadow-trace.jsonl`) with the same fields; moving it to the column is a copy. Agreement is computed against the answer once given.
- **Never answers.** The trainer is given `get` and `list` of the Decision Inbox and nothing else; a test scans its sources for any import of the inbox's answering code. A model only ever leaves the container as a JSON file of trees that Lair validates and evaluates itself.
- **Promotion** stays as §5: nothing here moves a class past `shadow`. `best.json` only picks which model writes proposals.
- **Not built:** stage D (the weekly LoRA run behind its own switch and label floor) and the Decisions view's chart; they need a served adapter to score on the bench and a client change, and are separate issues.
