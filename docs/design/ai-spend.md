# AI spend and waste

- **Status:** design. Of §7, PR 1 (measure; 1b is not built), PR 2 (classify, API, daily summary, notices), PR 3 (dashboard), PR 4 (G1) and PR 5 (G2, G4) are built; the rest is not. The feature decisions are made (§8, 2026-11-02).
- **Base:** main `9bce85a`.
- **Related:** [autonomy.md §6](autonomy.md#6-agents-budgets-failover-and-session-recovery-module-agents) (the agents module), [review-stages.md](review-stages.md) (staged review slots, `ask_after`, built separately), [planner.md](planner.md), [decision-policies.md](decision-policies.md) (the brain), issue #185 (usage limit detector).

Lair starts AI runs by itself: builder agents through fill, reviewer agents through the review assigner, the planner and its verifier, and the supervisor. Nothing records what those runs cost or how many of them were wasted. This spec adds three things:

1. **Measure:** record usage for every run, reported by the adapter where it can. Where it can't, Lair records the facts it can measure (model requests, runtime, context size) and shows tokens and cost as "not reported". Nothing is invented.
2. **Classify and show:** classify every run as productive, idle or no-result, and show it in an API, a dashboard panel, a daily summary and threshold notices.
3. **Guard:** add six guards against the waste patterns found below. Each has a mode, `off`, `observe` or `act`, and each ships in `observe`.

## 1. Why: what one real deployment shows

These numbers come from one busy project running 16 to 36 agents on one builder provider, over the 48 hours to 2 Nov 2026 05:00 UTC. They are read from `agents.db`, `review.db`, `planner.db` and the run logs. A "model request" is one request to the model, counted from the CLI's own log line for each request (§2.2).

| Fact | Count |
|---|---|
| Runs | 457: 105 completed, 324 failed, 10 lost their claim, 18 still running |
| Failed runs, by cause | 114 rate limited, 96 hung, 59 provider unreachable, 34 ended while Lair wasn't supervising (a Lair restart), 11 review runs not started (their run variables were lost in a restart), 9 crashed, 1 pid reused |
| Completed, by role | builders 56 of 327, reviewers 25 of 89, planner 17 of 31, verifier 7 of 10 |
| Builder completions that advanced the task (DONE, READY or BLOCKED) | 17 of 56. Of the other 39, 20 ended WAITING and 19 wrote no queue line |
| Model requests (443 runs with logs) | 4,010 in total. 1,495 (37 %) were in runs that ended with no result. The 39 idle builder completions used 993 and the 17 productive ones used 511 |
| Agent-minutes | 2,510 in completed runs and 4,982 in hung runs (each hung run sat silent for 45 minutes before it was stopped) |
| Context reloads | 201 same-session resumes and 21 fresh sessions, each re-sending the session's context or a resume summary |
| Attempts per task | 123 tasks: 26 took 6 or more attempts and 13 took 10 or more. The worst took 16 attempts for 1 completion; several took 10 or 11 for none |
| Repeat hangs | 26 tasks hung twice or more: 59 repeat hangs, 3,011 agent-minutes. 14 of those tasks never completed |
| Rate limits | every one came from the same provider, with reason `DAILY_REQUEST_COUNT`. For 8 hours each waiting agent retried about every 31 minutes, 12 to 13 times, because `failover.cooldown_minutes` is a fixed 30 |
| Decisions caused by those rate limits | 77 "every profile is failing" questions (one per task), 63 of them later withdrawn |
| Reviews | 87 reviews on 51 PR heads: 30 heads were reviewed at least twice and 6 heads three times. 55 of 89 review runs failed |
| Planner | 19 planner runs: 12 done, 7 failed. 45 proposals: only 8 applied (18 %), 20 declined by the verifier and 17 refused by Lair's rules. The top reasons: tasks already done were proposed again (three closed task ids, and a cleanup finished days earlier, proposed again from an old owner message), and "the tasks file changed while this planner run was active" (9) |
| Waits woken by a timer | 9 of 20 waits named no gate (a review, an approval) and were started again after `fill.wake.fallback_seconds` |
| `agents_usage` rows | **0**: no adapter reports usage, and `usage_patterns` is empty |

One more finding: an adapter **can** report its cost. During an earlier fallback window, a Claude Code adapter run with `--output-format stream-json` wrote 234 final `result` events. They carry `total_cost_usd`, `usage` (input, cache creation, cache read and output tokens), `num_turns` and `duration_ms`. Together they report **$413.22**, including $21.98 spent by 80 runs that ended on a usage-limit error. Lair recorded none of it. The figure was read from that window's run logs after an archive job had moved them out of the run log directory: it is the sum of `total_cost_usd` over every `"type":"result"` line in them.

### Top waste sources (48 h)

1. **Hung runs: 96 runs and 4,982 agent-minutes**, twice the time of every completed run together. A hung run is resumed in the same session, up to `recovery.same_session_restarts` times, and that re-sends its context. 26 tasks hung twice or more, and 14 of them never completed.
2. **A daily quota retried on a fixed 30-minute timer: 114 failed runs, 246 model requests and 77 decisions.** The provider said the limit was daily, but each waiting run started again every 30 minutes for 8 hours.
3. **Provider unreachable: 59 runs, 565 model requests and 1,245 agent-minutes** in runs that then died. The transient rule already makes these cost no recovery attempts, but the work done before each death is lost.
4. **Idle completions: 39 of 56 builder completions, using 993 model requests**, ended WAITING or with no queue line. 9 waits named nothing Lair could watch, so a timer woke them.
5. **Restart losses: 34 runs that "ended while Lair wasn't supervising" and 11 review runs not started** (their run variables were lost) across 8 Lair restarts. Each of the 34 is resumed, which reloads its context.
6. **Planner proposals that can't apply: 37 of 45 proposals refused or declined**, most of them for work already done. The planner and its verifier spend most of their runs this way.

## 2. What exists today

The inventory below was found with `git grep` over usage, budget, cost, failover, transient, cooldown, hung, wake and recovery in `src/server/agents/`, the planner, the review assigner, the supervisor, the brain modules and `docs/configuration.md`.

### 2.1 Code

| What | Where | What it does | What is missing |
|---|---|---|---|
| Usage ledger | `src/server/agents/store.ts:73-84` (`agents_usage`), `:535` `addUsage`, `:554` `usageSince` | One row per usage record: project, agent, provider, run, tokens, cost, time, reason | Nothing writes to it in practice (0 rows). It holds no input/output/cache split, no request count, no flag for usage that was not reported |
| Usage from run logs | `src/server/agents/service.ts:2735-2779` `readUsage`, called each tick for running runs at `:1083-1086` | Matches `agents.usage_patterns` (regex with named groups `tokens` and `cost`) against new log bytes and adds every match | A regex adds one number per match. It can't take the four token fields from one JSON event, and it double-counts because per-message `usage` objects repeat in stream-json logs. It has no adapter awareness |
| Usage from the fleet budget | `src/server/agents/service.ts:502-518` (`onCost` → `addUsage`), `src/server/fleet/budget.ts:94` `recordCost`, `:52` `costHistory` | Any cost recorded with a project attribution lands in the ledger | The fleet budget's history is in memory (last 1,000 records) and is off by default |
| Budgets | `src/server/agents/budgets.ts:51-81` `evaluateBudget`, `src/server/agents/service.ts:1169` `budgetBlock`, `:2793` `checkBudgets`, `src/server/agents/config.ts` `budgets` (`:306`) | Daily and monthly token and cost limits per project, per agent and per named agent. Soft writes `budget_warning` once per period. Hard stops new runs and raises a `spend` decision | Never triggers, because there is no usage. Soft is only an event, not an inbox notice. There is no request or minute metric for adapters that report no tokens |
| Budget UI | `src/client/components/Budget.tsx`, `src/client/components/AgentDetail.tsx:302` | Budget lines per agent | No spend or waste view |
| Failover and cooldown | `src/server/agents/failover.ts:73-83` `matchFailover`, `src/server/agents/service.ts:1134-1144` `coolingUntil`, `:1152` `unusable`, `:2224-2300` `failover`, `:2405` `raiseExhausted`, `config.ts:278-289` | A rate-limit or provider-error line stops the run and moves the task to the next profile. The provider cools for that agent for `cooldown_minutes` (30), and for every agent once two agents hit it within that time. With no profile left, the run waits for the cooldown and one decision per task is raised. A task is escalated after `max_failovers` | The cooldown is fixed. It doesn't know a daily quota or read a reset time (#185). When it expires, every waiting run starts at once instead of one probe. Each retry counts as a failover, and every task raises its own decision |
| Transient outages | `src/server/agents/service.ts:182-215` (`Outage`, 60 s to 15 min probe backoff, fleet window), `failover.ts:95-101` `matchTransient`, `config.ts:291-299` | A dead run whose last lines are a network or provider error costs no recovery attempt. The provider is marked unreachable, one start probes it with backoff, and one decision is raised per provider and outage | This is the model G1 copies for quotas. The work lost in each dead run is not counted |
| Recovery | `src/server/agents/service.ts:2023-2110` `recover`, `config.ts:259` `recovery` | Hung, crashed, dead-on-start and exit-unknown runs restart in the same session (resume), then in a fresh session, then escalate. The live config allows 4 resumes and 2 fresh sessions | All counts are per chain. Nothing caps a task across chains, and a second hang is treated the same as the first |
| Hung | `src/server/agents/service.ts:1746-1747` (watchdog rule), `:1778-1800` (`agents_hung_info` for the next prompt), `src/server/watchdog/config.ts:70` `hung_minutes` (45) | A silent agent is stopped. The next run's prompt says what hung | No repeat rule |
| Lost run variables | `src/server/agents/service.ts:1186-1190` | A module run whose in-memory variables were lost in a restart ends `failed`, and its module asks again | It is not classified as restart waste |
| Exit unknown | `src/server/agents/service.ts:1912-1950` | A run that ended while Lair was down completes if its queue line says so, otherwise it is a failed attempt | Its runtime is unreliable: the end is when Lair noticed it |
| Fill: idle completions | `src/server/agents/fill.ts:1505` `completionsWithoutDone`, `config.ts:210` `max_completions_without_done` (3) | Holds a task after 3 exit-0 runs without a done line or a real wake | This exists and is kept. It counts runs, not usage |
| Fill: waiting and wake | `src/server/agents/fill.ts:2499-2575` `classifyWait`, `:2566` fallback, `config.ts:108-128` `WakeSchema` | A WAITING line that names a gate waits for its result file (no timer). With nothing named, the task starts again after `fallback_seconds` (900) | Only gates can be named. A wait on a review, a merge, a decision or a bus message falls back to the timer |
| Run origin | `src/shared/agents-types.ts:53` `RunOrigin = "fill"`, `src/server/agents/service.ts:2930` `requestRun(input, { origin })` | Marks fill's runs | Only fill sets it. Review, planner, verifier and supervisor runs are told apart only by task-id prefix |
| Module runs | `src/server/planner/service.ts:981` (planner), `:1272` (verifier), `src/server/review/agent-assigner.ts:318`, `src/server/supervisor/chat.ts:362` | Each requests an ordinary agent run, so claims, recovery, failover and budgets apply | Their spend can't be split by role. Their result (a proposal, a verdict, a review) isn't linked to the run's cost |
| Module run caps | `src/server/planner/config.ts:139,150` `max_runs_per_day`, `src/server/review/config.ts:191` `retries.max_attempts` | Cap runs per day and per review slot | These exist and are kept |
| Planner run gating | `src/server/planner/service.ts:864-884` `nextRunAt` and `maybeStart` | A run starts on a trigger, after `debounce_seconds`, at least `min_interval_seconds` after the last run, within `max_runs_per_day` | Nothing skips a run whose inputs are the same as those of the last run that produced nothing applicable |
| Planner context | `src/server/planner/context.ts:68` (`tasksFile.done`, the last 200 done ids), `:70-82` (`openTasks`), `:84` (`ownerMessages`) | The model sees done ids, but also open plan and backlog tasks and owner messages that may describe the same, already finished, work | Open tasks whose id is done, or whose PR is merged, are not filtered out before the model sees them |
| Planner rules | `src/server/planner/proposals.ts:113` ("task ids are not reused"), `src/server/planner/service.ts:493-515,1134` (tasks file changed during the run) | Refuses a proposal for a done id **after** the model proposed it, and refuses a whole run's proposals when the tasks file changed while it ran | The run is already spent. There is no rule for an `add` whose work maps to a merged PR, so the verifier is asked about it |
| Owner messages | `src/server/planner/sources.ts:318-343` | A message is "answered" only when the replies file has a reply with its id. Until then it is in every planner context (the newest `max_messages`) | A message that a task carried out stays "unanswered", so it is proposed again |
| The brain | `src/server/brain-trainer/model.ts` (a local trained classifier), `src/server/brain-trainer/shadow.ts` | Decision proposals in shadow mode, with no model calls | No tokens, so nothing to bill. The bench (`src/cli/brain-bench.ts`, `src/server/brain-bench/models.ts:125,150`) calls model endpoints from the CLI only, outside the server |
| AI tools checks | `src/server/ai/runner.ts` | Model lists, sign-in and version checks | These are not model calls |
| Built-in Claude Code adapter | `src/server/services/adapters.ts:77-84` | `claude -p ...` writes plain text | The final usage event is only there with `--output-format stream-json` (or `json`) |

### 2.2 What each adapter's logs can report

| Adapter (CLI) | What its log holds at run end | Usage source |
|---|---|---|
| Claude Code with `--output-format stream-json --verbose` | A final `{"type":"result",...}` line with `total_cost_usd`, `usage.{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens}`, `num_turns`, `duration_ms`, `is_error`. An `assistant` event also carries a per-message `usage` | Reported, from the `result` line only |
| Claude Code with `--output-format json` | One JSON object with the same fields | Reported |
| Claude Code, plain `-p` (the built-in default today; `output: text` after D5) | Text only | Not reported |
| Another agent CLI (the one behind the built-in `kiro` adapter) | One `... GenerateAssistantResponseCommand done totalEvents=<n>` line per model request. No tokens, credits or cost | Requests counted (a measured fact). Tokens and cost "not reported". The builder provider's daily quota counts requests, so the request count is the number that matters |
| Aider and others | Varies. `usage_patterns` still works | Patterns, or "not reported" |

### 2.3 Docs

`docs/configuration.md` already documents these, and they stay true:

- Failover and cooldowns: the `Failover.` bullet under [Agents](../configuration.md#agents).
- "Transient errors are waited out".
- `Budgets.`, which says budgets are advisory while usage comes from run logs.
- `usage_patterns` in the options table.

## 3. Gaps

1. No usage is recorded. The one regex path can't parse the one adapter that reports cost, and the builder CLI reports no tokens at all.
2. Nothing classifies a run's outcome. "Completed" covers both a DONE and a "no change", and "failed" covers both a provider quota and a real crash.
3. Nothing measures attempts per task, context reloads, reviews per PR head, or planner acceptance in one place.
4. There is no spend view, no daily summary and no waste notice.
5. A daily quota is retried every 30 minutes by every waiting run, and each retry is a failover and a decision (#185).
6. Attempts are capped per chain only. A task can start many chains, and a chain can have up to recovery + failover + transient attempts (15 with the live config).
7. Waits on anything but a gate are woken by a timer.
8. A task that hung once is resumed into the same hang.
9. Budgets exist but have nothing to count. Soft limits notify no one, and adapters that report no tokens have no metric.
10. The planner proposes work that is already done and owner requests that are already carried out. It also runs again on inputs that produced nothing applicable last time. Lair refuses these proposals only after the run has paid for them.

## 4. Design

There is one new part of the agents module, `src/server/agents/spend.ts`, under `agents.spend`, plus six guards: G2 under `agents.spend`, the others in the sections they belong to (`failover`, `fill.wake`, `recovery`, `budgets`, `planner`). `agents.spend.enabled: false` is the default. With it off, nothing new is read, written or shown.

**Guards need spend.** A guard's verdicts and counts are written by spend. So a mode other than `off` for G1, G2, G3, G4 or any G6 part, while `agents.spend.enabled` is false, is a config error naming both keys. The same goes for a `daily_requests` or `daily_minutes` limit, since those are counted from `agents_spend`.

`budgets.guard_mode` is the one exception: it is accepted with spend off. It governs only the request and minute limits G5 adds; the existing token and cost hard limits block as they do today, whatever it says (decided in the review of PR 1: a default must not silently remove behaviour Lair has).

### 4.1 Measure

**A usage parser per adapter.** `agent_adapters.<id>.usage_parser` takes one of:

| Value | What it reads at run end |
|---|---|
| `claude-stream-json` | Every line whose JSON has `"type":"result"`, over the whole log, read in 1 MB chunks across ticks. One process can write several result events (14 of 180 recorded runs wrote 2 to 19): each one's `usage` and `num_turns` count only since the previous one, while the last one's `modelUsage` and `total_cost_usd` are the process's totals. So the tokens are the last event's `modelUsage` summed over its models (`inputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`, `outputTokens`; the events' `usage` summed when it has none), the cost is its `total_cost_usd`, `turns` is the sum of `num_turns` (stored as `turns`, not as requests: compaction and side calls aren't turns), and `model` is the first key of `modelUsage` (when the profile has none). A line over 1 MB after the last result read refuses the usage (it may hold the totals) |
| `claude-json` | The same fields from the one JSON object the run wrote |
| `request-lines` | Counts lines matching `request_pattern` (an adapter field, at most 500 characters, case-sensitive, compiled once, refused when it matches an empty line) over the whole log, read in 1 MB chunks across ticks like `readUsage` does today, each chunk's lines in a vm with a 250 ms timeout. That gives requests, no tokens |
| `patterns` | Today's `usage_patterns` |
| `none` | Nothing is reported. Tokens and cost show as "not reported", and runtime and context size are still recorded |

With no `usage_parser` set, the default is `patterns` when `usage_patterns` is non-empty, else the built-in adapter's default below, else `none`.

**Tokens for budgets.** The `tokens` written to `agents_usage`, which the `daily_tokens` and `monthly_tokens` limits count, are input + cache-write + output tokens. Cache reads are stored in `agents_spend.cache_read_tokens` but left out of `tokens`. They are billed at a fraction of the input price and would otherwise dominate the count: 1.6 M of the 1.7 M tokens in the AT-1 fixture are cache reads. Cost covers everything the CLI reports.

**Resumed sessions.** The parser assumes a `result` line reports only its own process's usage. The D5 PR (1b) checks this against a recorded `--resume` run. If the CLI reports the session's running total instead, the parser subtracts the previous `agents_spend` row of the same session id, never recording below zero (AT-32).

The built-ins get defaults:

- `claude-code`: `claude-stream-json`. Its `start_cmd` gains `--output-format stream-json --verbose` (decision D5, PR 1b).
  - Its `status_pattern` changes. Today it is `'^\{"status":'`, which matched the agent's own status lines on stdout. With stream-json, the agent's text arrives inside `assistant` events, so the pattern becomes `'^\{.*"type":"result"'`: the `result` event (its `type` key is not the first key of the line, in every recorded log), whose `is_error` and `subtype` give the run's end state.
  - The hung rule needs no change, because every event is a log write.
  - Both get tests against a recorded stream-json log.
  - **Session id for resume.** The first `{"type":"system","subtype":"init",...}` event carries the CLI's `session_id`. Lair reads it in the same incremental log read that `readUsage` already does, and stores it as the run's session id, so `resume_flag: "--resume {session_id}"` resumes the CLI's real session. Without that event, a resume falls back to a fresh session.
  - The adapter option `output: text` keeps the old plain-text start command and status pattern. With that option, `usage_parser` is `none`.
- `kiro`: `request-lines`, with `request_pattern: "GenerateAssistantResponseCommand done totalEvents=\\d+"` (every request line in the recorded logs has this form; `totalEvents=` keeps an agent's own prose that names the command from counting).
- The others: `none`.

When `usage_parser` is set to anything but `patterns`, `readUsage` skips that run, so nothing is counted twice.

**When it runs.** Once per run. The step that ends it (completed, failed, failover or stopped, adopted runs included) marks it owed (`agents_spend_pending`), synchronously, so a restart loses nothing; the ticks after it read its log with async I/O only (at most 4 MB and 300 ms of `request_pattern` time per tick) and never with synchronous fs. The result is written in one store transaction: one `agents_spend` row (§4.3) and its `agents_usage` row, inserted directly, then reported to the fleet budget without attribution (so its provider caps see the cost and no second ledger row is added). That transaction sets `agents_spend.usage_recorded = 1` and drops the mark, so a retry or a restart never adds the usage twice. A mark or a row that can't be written is tried again with a backoff, and given up after 5 attempts with a `usage_refused` event.

**When nothing is reported, no estimate is made (decision D3).** Every run records two measured facts:

- `runtime_s`, from spawn to the end. For an exit-unknown run, the end is the log's last write, not the time Lair noticed.
- `context_bytes`, the size of the prompt file Lair wrote plus the resume summary. Only the sizes are stored.

A run whose adapter uses `request-lines` also records `requests`. For an adapter that reports no tokens, the API returns `null` for tokens and cost with `reported: false`, and every view shows "not reported". Requests and agent-minutes are the units used for that adapter. Lair never converts runtime or requests into tokens or cost.

**Module runs and other model calls.** `requestRun` already takes `{ origin }` (`src/server/agents/service.ts:2930`), and the `RunOrigin` union (`"fill"` today) gains these values:

- `review`: set by the review assigner.
- `planner` and `verifier`: set by the planner.
- `supervisor`: set by the supervisor chat and digest.
- `owner`: set by `POST /api/agents/runs`.
- `fill`: unchanged.

A run with no origin falls back to its task prefix. Model calls a module makes without an agent run go through a single in-process function, `spend.recordCall(project, { module, provider, tokens, cost })` (`AgentsManager.recordCall`), which writes `agents_usage` with `run_id` null and `reason: "call:<module>"`. One call is one row, so the rows count the calls; `agents_usage` has no model or request column, and PR 1 adds none. Today no server module makes such calls. The brain is a local classifier with no tokens: its evaluations are counted as `brain` calls with 0 tokens, so the panel shows it costs nothing. If a future brain uses a remote model, it must call `recordCall`. The bench CLI stays outside the server and prints its own usage.

**Planner and verifier model calls.** Every planner run and every verifier run is an agent run, so its usage is recorded like any other run's. `planner_runs` already holds `agent_run_id` and `verifier_run_id`. The spend rollup joins on them to give, per planner run, its own requests, tokens and cost plus its verifier's, and the proposals by status. The panel then shows the **cost per applied proposal** and the planner's waste share (runs with no applied proposal).

### 4.2 Classify every run

At run end, each run gets one class and one reason. Everything used is data Lair already has: run state and detail, fill's events, the review store, and the planner store.

| Class | Reasons (enum) | Rule |
|---|---|---|
| `productive` | `done`, `ready`, `blocked`, `gate_queued`, `review_recorded`, `proposals`, `verdicts`, `answered` | A `fill_done` or accepted READY. The **first** `fill_blocked` for a given blocker, which surfaces new information (decision D1). A WAITING whose wake was absent when the run ended and differs from the previous run's wake (this run queued the gate, so it pushed). A review recorded by this run's assignment. A planner run that wrote one or more proposals. A verifier that wrote verdicts. A supervisor run that answered |
| `idle` | `waiting_same`, `waiting_unnamed`, `blocked_repeat`, `no_line`, `no_review`, `no_proposals`, `no_verdicts`, `no_answer` | Exit 0 and nothing above: a WAITING on the same wake as the previous run or on nothing Lair can watch; a repeat BLOCKED with the same blocker and no push since the last one; no queue line; a review run with no review; a planner run with no proposals; a verifier with no verdicts; a supervisor run with no answer |
| `no_result` | `hung`, `crashed`, `dead_on_start`, `never_started`, `rate_limit`, `provider_error`, `unreachable`, `exit_unknown`, `lost`, `vars_lost`, `lost_claim`, `stopped` | Any failed end, by the run's existing end kind. `stopped` covers an owner stop or a shutdown |

**The same blocker (decision D1).** A BLOCKED line's blocker key is a sha256 of three parts:

- its text, lowercased, with whitespace collapsed, and with times, dates and the agent attribution removed;
- the gate id it names, if any;
- the PR number it names, if any.

Only the hash is stored (`blocker_key`), never the text. "No push since" means two things since the earlier BLOCKED with that key: the named PR's head in the review store hasn't changed, and the task has had no productive run (no gate queued, no DONE or READY). A repeat BLOCKED that meets both is `idle/blocked_repeat`. Anything else is `productive/blocked`.

**Other measures:**

- `reload: true` on a run whose `sessionMode` is `resume` or `fresh` and whose previous run in the chain was `no_result`. Its `context_bytes` and its first request are the cost of the reload.
- A `lair_restart` flag on `exit_unknown`, `lost` and `vars_lost` runs. It shows how much a Lair restart cost.
- **Per task:** attempts, completions (productive runs ending in `done` or `ready`), no-result count and chains, over today, 7 days and since the task first ran.
- **Per PR head:** review runs, reviews recorded and review runs that failed (from `review_agent_assignments` and `review_reviews`).
- **Planner:** proposals by status (`applied`, `declined`, `rejected`, `pending`) and the verifier verdict, from `planner_proposals`.

**When a run's facts come later.** A module reads its run's result after the run ends (the planner its proposals, fill a WAITING line's wake), so a row is written `unclassified/pending` when they aren't there yet and is classified on a later tick, from what the module recorded (`SpendFacts`, read-only from its store: review, planner, verifier and supervisor). 30 minutes after the run's end it gets the class the facts give by then, so what never came counts as none (`no_proposals`, `waiting_unnamed`, ...). A module that isn't wired leaves its runs `unclassified`: nothing is guessed. A classified row never changes.

**The waste share** of a window is `(idle + no_result) / (productive + idle + no_result)`, `unclassified` rows being in neither, in each unit there is data for: cost (reported), tokens (reported), requests, turns, agent-minutes and runs. The panel shows the unit with the best data first: cost if any reported cost exists, then requests, then minutes.

### 4.3 Storage

The agents store goes to schema v4 on main (it is v3; no open PR changes it). It gets a new table, created with `CREATE TABLE IF NOT EXISTS` like the rest of the schema, so v1 to v3 files migrate:

```sql
CREATE TABLE IF NOT EXISTS agents_spend (
  run_id TEXT PRIMARY KEY,           -- one row per run: idempotent
  project TEXT NOT NULL, agent TEXT NOT NULL, task TEXT NOT NULL, chain_id TEXT NOT NULL,
  origin TEXT NOT NULL,              -- fill | review | planner | verifier | supervisor | owner | other
  adapter TEXT NOT NULL, provider TEXT NOT NULL, model TEXT,
  started_at INTEGER, ended_at INTEGER NOT NULL, runtime_s INTEGER NOT NULL,
  class TEXT NOT NULL, reason TEXT NOT NULL,   -- PR 1 writes `unclassified`/`pending` for what needs PR 2's rules
  session_mode TEXT NOT NULL, reload INTEGER NOT NULL, lair_restart INTEGER NOT NULL,
  usage_source TEXT NOT NULL,        -- reported | requests | none  (never estimated)
  input_tokens INTEGER, cache_write_tokens INTEGER, cache_read_tokens INTEGER, output_tokens INTEGER,
  tokens INTEGER,                    -- as the budgets count them (input + cache write + output; usage_patterns' total)
  requests INTEGER, turns INTEGER,   -- requests: request-lines only; turns: num_turns of a result event
  cost REAL, context_bytes INTEGER NOT NULL,
  pr INTEGER, head_sha TEXT,         -- review runs, and BLOCKED lines naming a PR
  blocker_key TEXT,                  -- sha256 only, for BLOCKED runs
  backfilled INTEGER NOT NULL DEFAULT 0,   -- classified from old records on first enable (PR 2)
  usage_recorded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agents_spend_time ON agents_spend(project, ended_at);
CREATE INDEX IF NOT EXISTS idx_agents_spend_task ON agents_spend(project, task, ended_at);

CREATE TABLE IF NOT EXISTS agents_spend_daily (
  project TEXT NOT NULL, day TEXT NOT NULL,          -- UTC "YYYY-MM-DD"
  agent TEXT NOT NULL, origin TEXT NOT NULL, provider TEXT NOT NULL,
  class TEXT NOT NULL, reason TEXT NOT NULL,
  runs INTEGER NOT NULL, reloads INTEGER NOT NULL, lair_restarts INTEGER NOT NULL,
  requests INTEGER, turns INTEGER, minutes REAL NOT NULL,
  input_tokens INTEGER, cache_write_tokens INTEGER, cache_read_tokens INTEGER, output_tokens INTEGER,
  cost REAL,                                         -- null when no run of the group reported it
  PRIMARY KEY (project, day, agent, origin, provider, class, reason)
);

-- Runs that ended while spend was on and whose row isn't written yet: marked in the same synchronous step that
-- ends the run, so a restart between the end and the next tick loses nothing (PR 1)
CREATE TABLE IF NOT EXISTS agents_spend_pending (
  run_id TEXT PRIMARY KEY, project TEXT NOT NULL, ended_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, last_error TEXT   -- a failed write backs off
);
CREATE INDEX IF NOT EXISTS idx_agents_spend_pending ON agents_spend_pending(project, ended_at);
```

**Retention (decision D4).** Per-run rows are kept for `agents.spend.retention_days` (90), and daily aggregates for `agents.spend.aggregate_days` (365).

- The aggregate for a UTC day is written when that day's daily summary runs, as an upsert on the primary key. Writing it again (after a restart, say) gives the same rows.
- Rows for a day can arrive after its summary ran: an exit-unknown or adopted run ends late. So right before a day's per-run rows are deleted, the pruning step always upserts that day's aggregate again from the rows still there. A late row is never lost, and an aggregate is never left stale.
- Deletes run at most once a day, in the tick, one whole UTC day at a time: the day's aggregate is written again and its per-run rows deleted in one transaction, so a crash can't leave a day half deleted (whose aggregate a later pass would then write again from what is left). At most 31 days per tick; the rest go on the next tick.
- `agents_spend_daily` has no `tokens` column: a long window's tokens are input + cache write + output, so a `patterns` row (a total with no split) adds none there.
- Windows longer than 90 days have no per-task detail. They read the aggregates of the days before the retention cutoff and the per-run rows from the cutoff on, so a row that lands after its day's summary counts at once. A day before the cutoff whose rows retention hasn't deleted yet is read from its aggregate, or from its rows when it has none.

**Backfill (PR 2, because it needs the classification).** On first enable, the runs from the last `backfill_days` (7) are classified from the run records and events Lair already holds. Their usage is `none`, because their logs may have moved, and they get `backfilled = 1`. The first panel isn't empty, and every view can tell these rows apart. The backfill is idempotent: a row whose `run_id` exists is skipped, and so is a run that ended while spend was on (its pending mark), whose row drain writes with the usage its log reports. The queue file isn't read for it: a completed builder run whose line fill never recorded (not a fill task) is `unclassified` with reason `not_recorded`, not guessed idle. The daily summary and retention wait until the backfill is done (its `spend_backfill:done` event): it goes oldest first, so a summary before then would miss the last day's runs, and it is never sent again.

### 4.4 Show it

**API** (owner session; mutates nothing; no public allow-list entry, because cost and usage are the owner's data):

- `GET /api/agents/spend?project=<p>&window=today|7d|30d|1y&by=project|agent|task|reason|origin|provider` returns the fields below. A window past 90 days comes from the daily aggregates and refuses `by=task` (400, naming the reason).
  - totals per class and unit;
  - the waste share;
  - groups sorted by waste;
  - `reloads` and `lairRestarts`;
  - the 10 tasks with the most attempts without a completion;
  - reviews per head (heads reviewed more than once);
  - planner acceptance;
  - each guard's mode and its `would` and `did` counts;
  - `reported: false`, with `null` tokens and cost, for any group whose adapters report no tokens.
  "today" is the UTC day.
- `GET /api/agents/spend/runs?project=<p>&task=<id>&limit=` returns that task's run rows. These hold numbers, ids and enums only, never a prompt or a log line.

**Dashboard.** Home gets an **AI spend** panel, shown only while `agents.spend.enabled` is on. It has:

- a today / 7 days switch;
- one stacked bar per unit (productive, idle, no-result);
- the waste share;
- the top 5 waste reasons and top 5 tasks by attempts without a completion;
- a table by project, agent, origin or task;
- reloads and Lair-restart losses;
- one line per guard: its mode, and what it would have done or did (parks, skips, cooldowns, wakes);
- "not reported" in place of tokens and cost for adapters that don't report them.

AgentDetail gets a "Spend" line (today's runs per class and cost or requests) next to its Budget section. Charts follow the dashboard's existing component styles.

**As built (PR 3).**

- The agents status (`GET /api/agents/status`, not owner-only) says only whether spend is on (`spendEnabled`), so the panel and the Spend line show while it is on and a signed-out browser sees "shown to the owner only" in their place. Their numbers come from the owner-only spend route alone, read once a minute and on each switch.
- The bars cover each unit with data: cost and tokens where an adapter reported them (else "not reported" in their place), requests, model turns, agent time and runs. Runs not classified yet are a fourth, grey segment when there are some. Each bar has its numbers beside it in text.
- The table is by agent first (task, origin and project on its select). A row whose runs have none of the panel's unit shows its waste share in the next unit it has ("100% of requests").
- The guard lines read the API's `mode`, `would` and `did` per guard, in plain words ("watching: would have cooled a provider once today").

**Daily summary.** At `agents.spend.daily_summary_utc` ("00:05"), for the UTC day that just ended, each project records one `spend_daily` event (dedupe key `spend_daily:<project>:<date>`, so a restart doesn't repeat it). It is published on the event bus as `agents.spend.daily`. The data is the same totals the API gives for that day: numbers, enums and task ids only. The same step writes that day's `agents_spend_daily` rows. The supervisor digest may read it. No AI run makes it.

**Notices.** These are Decision Inbox items with `attention: "notice"`. The notifier sends only `action` items outside Lair, so a notice never leaves it, and each one is withdrawn when its condition clears.

- `spend_waste`: the day's waste share in the panel's unit passes `notice.waste_share`, with at least `notice.min_runs` runs that day. One per project per day.
- `spend_task_attempts`: one task's attempts without a completion pass `notice.task_attempts` within 24 h. One per task per streak, withdrawn when the task completes or is released.

Each is off until its threshold is set. The recommended thresholds (decision D6) are in §4.6.

### 4.5 Guards: `off`, `observe`, `act`

Every guard has a `mode` (decision D6):

- `off`: the default. Nothing is computed.
- `observe`: the guard reaches the same verdict it would act on and changes nothing. It records one `guard_would` event, carrying the guard (`data.guard`, one of `quota`, `task_no_result_cap`, `wake_events`, `hung_repeat`, `budget`, `planner_prefilter_closed`, `planner_handled_messages`, `planner_skip_unchanged`, `planner_recheck_on_change`: the spend API counts by it), the subject (a task, a provider or a planner run), the verdict (`would_park`, `would_skip`, `would_cool`, `would_wake`, `would_block`, `would_apply`) and the evidence as numbers and ids. It raises one inbox item with `attention: "notice"` per subject and streak, and counts the verdict in the panel and the API.
- `act`: the guard does what it describes, records a `guard_did` event and counts it.

**Rollout.** Every guard ships in `observe`. Each one moves to `act` on its own, after a week of observe evidence shows its would-verdicts would have been right: the parked tasks didn't later complete unattended, the skipped planner runs had nothing applicable, and the cooled-down provider stayed limited. An observe verdict and an act verdict for the same input are the same verdict. The tests check that.

**G1. Fleet quota cooldown.** This extends `agents.failover` (`failover.quota.mode`). Today's cooldown already becomes fleet-wide once two agents hit it within 30 minutes. G1 adds what a quota needs (this is #185's reset-time part).

One deployment runs an interim `agents.failover.cooldown_minutes: 120` as a stopgap for daily quotas. Once G1 acts, the cooldown for quota lines comes from the reset time, and `cooldown_minutes` can go back to covering only short bursts.

- `failover.quota.patterns`: lines that mean a quota, not a burst. The generic examples are `DAILY_REQUEST_COUNT` and `hit your .* limit`. A pattern may capture `(?<reset>...)`, which is read as an ISO time, `HH:MM` with an optional zone (the server's local zone when none is given), or `in <n> (minutes|hours)`. The builder provider's real quota line carries no reset time, so the backoff below is the path that matters for it.
- **Which pattern wins.** In `matchFailover` (`src/server/agents/failover.ts:73`), `quota.patterns` are checked **before** `rate_limit_patterns` for each line. A real quota line matches both.
- **The run that hit the quota** ends as a `failover` event of a new kind, `quota`, and `coolingUntil`'s filter (`src/server/agents/service.ts:1138`) includes that kind. This one failover does **not** count toward `max_failovers`: the quota is the account's, not the task's.
- **In observe**, `matchFailover` still reports the line as `rate_limit`, and everything follows today's rate-limit path unchanged. G1 only records `would_cool` alongside.
- A quota line cools the provider **for every agent at once**, with no two-agent threshold, because a quota is account-wide. The cooldown lasts until the parsed reset time, capped at 24 h. If no reset time is given, it lasts `quota.backoff_minutes` (30), doubling per failed probe up to `quota.max_backoff_minutes` (240).
- When the cooldown ends, **one probe start** tries the provider, exactly as a transient outage does. Others wait. A probe that works clears the cooldown and every waiting run starts. A probe that hits the quota again doubles the wait.
- A run waiting on a fleet quota counts no failover, no recovery and no `start_timeout_minutes`. Instead of one decision per task, **one decision per provider and cooldown** is raised: "Keep waiting" (recommended), or "Try now".
- A run already running isn't stopped by someone else's quota line. It ends on its own, as today.
- In observe, the provider isn't cooled beyond today's rule. Each start that would have waited records `would_cool` with the reset time Lair would have used.
- Recommended: patterns for the CLIs in use. On the 48 hours above, this would have replaced 114 failed starts with about 6 probes, and 77 decisions with 1.
- **As built (PR 4).**
  - The cooldown's state is kept on events of a new kind, `quota` (provider, since, next probe, backoff step, lines, reset), next to the `failover` event of kind `quota`. A `quota_cleared` event ends it: a start after the latest quota line that lives past `dead_on_start_seconds` or exits 0, or the owner's "Try now". A quota state older than 48 hours is over.
  - A provider in a quota cooldown is passed over like one in a transient outage, so a fallback on another provider wins; with none, the run waits for the probe the same way (one start at a time, no `start_timeout_minutes`).
  - The quota's cooldown replaces `cooldown_minutes` for quota lines rather than adding to it: `coolingUntil` still reads only rate-limit and provider-error failovers, so the interim 120-minute cooldown doesn't hold a quota's probe back. The quota failover's run ends `rate_limit` (§4.2's end kinds don't change).
  - Each cooldown records one `guard_did` (`verdict: "cool"`); its decision is class `agents.provider_limit`, code `provider_quota`.
  - Observe's streak per provider lasts until a start on it works, read from the run records at the next quota line, so it writes only the `guard_would` and its notice (class `agents.spend_notice`, code `would_cool`). Its `would_cool` window (to the time act would have cooled until) is what G2 leaves out.
  - A reset group is read as an ISO time with a zone, `HH:MM` or `H[:MM]am|pm` with an optional zone (`Z`, `UTC`, `GMT`, an offset, or an IANA name), or `in <n> minutes|hours`. Quota patterns run in a vm that interrupts them after 50 ms (no match then), and a pattern slow on short lines is refused at load.

**G2. Per-task no-result cap.** `agents.spend.guards.task_no_result_cap: { mode: off, max: 6, window_hours: 24 }`.

- When a task reaches `max` no-result runs within the window, across all its chains, it is parked, not restarted.
  - A fill task gets the fill hold `no_result_cap`, its claim is released, and one `escalation` decision is raised per task and streak. The options are `start_again` (resets the count), `fresh_session` and `keep_parked`.
  - A module run (review, planner, verifier) ends its chain and is escalated once through the existing `escalate` path. Its module's own caps still apply.
- **What doesn't count**, by D2's reasoning (the failure isn't the task's):
  - runs that died while their provider was in a **fleet** outage or a fleet quota cooldown (decision D2), since G1 and the transient rule handle those. G1's observe-mode `would_cool` windows count as cooldowns here too;
  - runs with `lair_restart = 1` (`exit_unknown`, `lost`, `vars_lost`): Lair's own restart ended them;
  - runs that ended `stopped`: an owner stop or a shutdown;
  - runs that ended `lost_claim` because their claim was released on request: by the owner (the Agents view or the API) or by a module stopping its own run (a review whose PR moved on, a supervisor turn). A claim another run took still counts.
- **As built (PR 5).** The count is read from the run records of the task's chains, at the moment a failed run's chain would go on (a restart, a failover, a transient or never-started retry), so the run that just failed counts at once. A fleet outage is the provider's latest `transient` event by the run's end saying every agent waits; until G1 exists, the fleet cooldown is today's rate-limit and provider-error cooldown once two agents' failovers made it fleet-wide, and G1's quota cooldown (and its `would_cool` windows) joins it with PR 4. The count starts over when the task's fill hold is released: `start_again` releases it, and so does a release in Work. A superseded run never ran, so it isn't counted.
- On the data above, with `max: 6`, the 13 tasks that took 10 or more attempts would each have stopped at their sixth no-result run and asked once.

**G3. Waiting agents woken only by the awaited event.** This extends `agents.fill.wake`.

- `wake.events: { mode: off }`. With it on, `waiting_pattern` may capture, besides `(?<wake>...)` (a gate, as today):
  - `(?<pr>\d{1,7})`: wakes on `review.submitted`, `review.invalidated` or `review.merged` for that PR, or a merge refusal;
  - `(?<decision>[A-Za-z0-9_-]{1,64})`: wakes when that decision is answered;
  - `(?<message>bus)`: wakes on a bus message to the agent.
- A wait that names a known event has **no fallback timer**. It is still bounded by `max_wait_minutes` (one decision, as today).
- Lost events: on startup, and every `poll_seconds`, Lair checks the current state once (PR reviewed or merged since the wait began, decision answered, unread bus message). A missed event can't strand a wait, and a woken run is never started twice: the wake is recorded per run (`fill_woken`) as today.
- The fallback timer stays only for waits that name nothing, as today. Each idle completion on it doubles the next fallback, up to `max_backoff_seconds`. `max_completions_without_done` still holds the task after 3.
- In observe, the fallback timer still runs. Each event that would have woken a wait records `would_wake`, and each timer wake records that no event was due.
- Recommended: the `pr` and `decision` captures added to the project's `waiting_pattern`.

**G4. Hung-repeat rule.** This extends `agents.recovery`: `hung_repeat: { mode: off, max_per_task: 2, window_hours: 24, first: resume }`.

- `first` sets how the first hang restarts. It is a separate option, not tied to `mode`, so moving the mode from observe to act never changes first-hang handling on its own.
  - `resume`, the default, is today's behaviour.
  - `fresh` starts a fresh session with the hung-info block and a resume summary, so the stuck context isn't re-sent. It applies whenever it is set, in any mode, and is a change the owner makes on its own evidence.
- `mode` governs only the park below.
- The `max_per_task`-th hang of a task within the window, in any chain, **parks** it with the fill hold `hung_repeat` (or escalation for a module run) and one decision. Options: `fresh_session` (with the hung info), `keep_parked`, `release`. The task is not resumed again. A hang after `fresh_session` or `release`, within the window, parks it again (the count doesn't start over). `first: fresh` turns a first hang's resume into a fresh session; when the chain's restarts are used up, it is escalated as today.
- On the data above, with `max_per_task: 2`, the 59 repeat hangs (3,011 agent-minutes) would have been 26 parked tasks, each asked about once.

**G5. Daily budget per project with an owner notice.** This reuses `agents.budgets` and adds no second budget system (`budgets.guard_mode`).

- New metrics `daily_requests` and `daily_minutes` (`monthly_*` too), counted from `agents_spend`. These cover adapters that report no tokens: for a provider whose quota counts requests, a soft limit at 80 % of the quota warns before the wall.
- A soft limit also raises an inbox item with `attention: "notice"`, once per scope, metric and period. Today it is only an event.
- `budgets.guard_mode` covers the new request and minute hard limits. Its default is `observe`, unlike the other guards, which default to `off`. The existing token and cost hard limits are not a guard: they block as today, whatever `guard_mode` says (decided in the review of PR 1).
  - In observe, a hard limit records `would_block` and raises a notice.
  - In act, it blocks new runs with the existing `spend` decision, as hard limits do today.
- **PR 1 makes more usage count toward the existing hard token and cost limits.** Today they count `usage_patterns` and attributed fleet-budget costs; once PR 1 records what adapters report, a limit may be reached that wasn't before, and it blocks as today. PR 1's docs say so, and AT-1 checks that a hard limit blocks whatever `guard_mode` says.
- Only reported usage counts toward token and cost limits, because nothing is estimated (decision D3).
- Recommended for the deployment above: `project: { daily_requests: { soft: <80 % of the provider's daily quota> } }`, plus `daily_cost` soft and hard limits at amounts the owner chooses for each paid provider.

**G6. Planner guards: propose only what can apply.** These extend `planner:` with `guards`. Each of the four parts has its own mode. All four are cheap and deterministic: no model is called and no network is used.

- **Filter closed work before proposing** (`guards.prefilter_closed: off`). In observe, the context is unchanged and `would_skip` lists what would have been dropped.
  - Before the context is built, Lair drops from `openTasks`, and from the triggers, every task whose id is a done id of the tasks file, and every task whose **own** PR has merged.
  - A task's own PR is one whose head branch contains the task id, or the PR that the task's own READY or DONE line names, read as the ready guard reads it. It is merged when the review store says so (`review_merges`, or the PR state the review module last read from the host).
  - A task whose text only **mentions** a merged PR is kept, for example a follow-up such as "fix the regression from #42".
  - It reads only local stores: the tasks file, the queue lines and `review.db`.
  - The context gains `closed: { tasks, mergedPrs }` (the newest 200 of each), so the model also sees what is finished.
  - After the run, one new rule refuses an `add` whose task id is one whose own PR has merged, with the reason. Like every rule refusal, this happens before the verifier is asked, so the verifier run is saved too.
- **Mark an owner request handled once a task closes it** (`guards.handled_messages: off`). In observe, the message is recorded as would-be handled and stays in the context.
  - A proposal may carry `from_message: <id>`. It must be an owner-message id in that run's context, or the proposal is refused.
  - Lair's own instructions appended to the planner prompt (`src/server/planner/context.ts:125-135`) document the field: the JSON shape gains `"from_message": "<owner message id, when the proposal carries out one>"`, and one rule line says when to set it. Without that, the model never sets it.
  - When a proposal with `from_message` is applied and its task later closes (its DONE line, or an applied `finish`), Lair records the message as handled in `planner_state` (keyed by message id, so it is idempotent; at most 1,000 kept; with the task and the time). A handled message is left out of later contexts and triggers.
  - A message whose proposal was declined or refused stays open.
  - The owner can mark a message handled, or reopen it, from the planner view through two owner-only planner routes (not spend routes): `POST /api/planner/messages/:id/handled` and `POST /api/planner/messages/:id/reopen`. Both are idempotent. An id that isn't an owner message gets 404.
- **Skip a run when nothing changed** (`guards.skip_unchanged: { mode: off, max_skip_hours: 24 }`). In observe, the run starts and `would_skip` records the matching earlier run.
  - Lair hashes, with sha256, the **inputs that decide what can be proposed**, and only those:
    - the tasks file's text;
    - `openTasks` (id, source, text);
    - the open `ownerMessages` (ids and text);
    - `blocked` (task, class, reason);
    - `closed`;
    - the allowlist and the idle agent set.
  - `recentEvents` (`src/server/planner/context.ts:83`, which changes every tick), the trigger list and every time field are left out. A hash over the whole context would never repeat, and the guard would be inert.
  - If the last finished run with the same hash ended with no applicable proposal (none applied or pending), the new run is skipped. No agent run starts, the triggers are consumed, and a `planner_skipped` event records the hash prefix and the earlier run's id.
  - Any real change (an owner message, a task line, a done line, a new idle set) gives a new hash, and the planner runs.
  - Once `max_skip_hours` has passed since the last run, it runs anyway.
  - The hash and the outcome are kept in `planner_state`, so a restart doesn't undo the skip.
  - The spend panel counts skipped runs.
- **Apply what still holds when the tasks file changed during a run** (`guards.recheck_on_change: off`; decision D7).
  - Today, when the tasks file changes while a planner run is active (`src/server/planner/service.ts:468-520`), Lair puts its own version back and refuses all of the run's proposals.
  - In act mode, Lair keeps the edit, records it with its diff as an outside edit (as it does when no run is active), and raises one `attention: "notice"` item naming the run.
  - At apply time, each proposal is checked against the **current** tasks file with the same rules as any proposal (done ids, an existing line, the allowlist, `from_message`). The valid ones go on to the verifier and the approval as usual. The rest are refused one by one, each with its reason.
  - The run keeps `tampered: true` for the record. The diff stays in `planner_changes`, so the owner can still restore the file.
  - The integrity risk (a planner agent writing the tasks file itself) is covered by that record and the notice. Running agents as separate OS users closes it ([sandbox.md](sandbox.md)).
  - In observe, Lair behaves as today (it restores the file and refuses the run) and records `would_apply` with the count of proposals that were still valid.
- Recommended: all four parts. On the 48 hours above, the proposals for closed task ids and for the old, already carried out request would not have been made, and the 9 runs refused for a changed file would have had their valid proposals applied.

**Not here.** Staged review slots (`ask_after`, [review-stages.md](review-stages.md), PR #291) stop an expensive reviewer slot from running before the gate or the earlier slots. This spec only measures reviews per head and review-run waste, so the effect of `ask_after` shows in the panel.

### 4.6 Configuration

The recommended values below are the decided ones (D6). Every guard ships in `observe`, and each moves to `act` on its own after a week of evidence. The defaults stay `off`.

```yaml
agent_adapters:
  my-claude:
    # the built-in claude-code start_cmd now has --output-format stream-json --verbose (D5)
    usage_parser: claude-stream-json
    # output: text                           # the old plain-text start command; usage_parser becomes none
  my-other-cli:
    usage_parser: request-lines              # requests and minutes; tokens and cost "not reported" (D3)
    request_pattern: "GenerateAssistantResponseCommand done totalEvents=\\d+"

agents:
  failover:
    quota:                                   # G1
      mode: observe
      patterns: ["DAILY_REQUEST_COUNT", "hit your .* limit . resets (?<reset>\\d{1,2}(:\\d{2})?\\s?[ap]m)"]
      backoff_minutes: 30
      max_backoff_minutes: 240
  recovery:
    hung_repeat: { mode: observe, max_per_task: 2, window_hours: 24, first: resume }   # G4; first is its own switch
  budgets:
    guard_mode: observe                      # G5: the request and minute limits (the default); token and cost limits always block
    project: { daily_requests: { soft: 800, hard: 1000 }, daily_cost: { soft: 40, hard: 50 } }
  fill:
    wake:
      events: { mode: observe }              # G3, with (?<pr>...) in waiting_pattern
  spend:
    enabled: true
    retention_days: 90                       # per-run rows (D4)
    aggregate_days: 365                      # daily aggregates (D4)
    backfill_days: 7
    daily_summary_utc: "00:05"
    notice: { waste_share: 0.5, min_runs: 20, task_attempts: 6 }
    guards:
      task_no_result_cap: { mode: observe, max: 6, window_hours: 24 }   # G2

planner:
  guards:                                    # G6
    prefilter_closed: observe
    handled_messages: observe
    skip_unchanged: { mode: observe, max_skip_hours: 24 }
    recheck_on_change: observe               # D7
```

Config is checked at load, and errors name the key:

- A pattern that doesn't compile is refused.
- A `request_pattern` longer than 500 characters is refused.
- `waste_share` must be in (0, 1].
- `max_backoff_minutes` must be at least `backoff_minutes`.
- `quota.patterns` must not be empty when `quota` is set.
- A guard `mode` other than `off`, `observe` or `act` is refused.
- A mode other than `off` for G1, G2, G3, G4 or a G6 part, or a `daily_requests` or `daily_minutes` limit, while `agents.spend.enabled` is false, is refused, naming both keys.
- `aggregate_days` must be at least `retention_days`.
- An `estimate` key on an adapter is refused (D3: nothing is estimated).
- `daily_summary_utc` must be `HH:MM`.
- A `reset` group that isn't a time is ignored, and the cooldown falls back to the backoff.

## 5. Acceptance tests

Each test drives the real entry point (the agents tick, `requestRun`, the route), with real payloads copied from the emitters on main and from sanitized real logs. Each fakes only one named boundary: the process spawner and clock in `probes`, or the log file contents.

| # | Setup | Action | Expected |
|---|---|---|---|
| AT-1 | spend on. Adapter `usage_parser: claude-stream-json`. A log fixture ending with a real `result` line (cost 0.5177, 60 input, 55,895 cache write, 1,634,873 cache read, 13,052 output, 31 turns) | The process exits 0 with a DONE line. Then the same with a `daily_tokens: { hard: 50000 }` project limit, first with `guard_mode` unset, then each mode | One `agents_spend` row (`productive`/`done`, `reported`, those numbers, `turns: 31`, `requests` null) and one `agents_usage` row with cost 0.5177 and tokens 69,007 (input + cache write + output; the 1,634,873 cache reads are kept in `cache_read_tokens` only). With `guard_mode` unset, `observe`, `act` or `off`, the existing `spend` decision is raised and new runs wait, as today. The same limit fed by `usage_patterns` with spend off blocks too |
| AT-2 | As AT-1 | Lair restarts between the end and the next tick, then ticks twice | Still one spend row and one usage row (`usage_recorded`) |
| AT-3 | stream-json log whose `assistant` events each carry `usage`, plus a final `result` | Run ends | Only the `result` line counts; no per-message double count |
| AT-4 | A `result` line with negative or non-numeric tokens, cost `1e9`, or a line over 1 MB | Run ends | Non-finite or negative values become 0. Values over the cap (tokens 1e10, cost 1e5 per run) are refused, the row is `usage_source: none`, and the event says why. Nothing throws |
| AT-5 | `usage_parser: request-lines`. A real log from the builder CLI with 30 request lines | Run ends | `requests: 30`, `usage_source: requests`, tokens and cost null. The API says `reported: false` and the panel says "not reported". A `daily_tokens` hard limit of 10 doesn't block anything, because nothing was reported |
| AT-6 | The built-in `claude-code` adapter, and a recorded stream-json log of a real run (sanitized) | The run starts, writes progress and ends. The task is then resumed. Then the same with `output: text`. Then a log with no `init` event | Its start command has `--output-format stream-json --verbose`, and `status_pattern` is `'^\{.*"type":"result"'`, matching the `result` event. The hung rule sees progress on the JSON lines: the run isn't hung while events arrive, and is hung after `hung_minutes` of silence. Usage is read from the `result` line. The run's session id is the `init` event's `session_id`, and the resume passes it to `--resume`. With `output: text`, the old start command and status pattern are used and `usage_source` is `none`. Without an `init` event, the resume starts a fresh session |
| AT-7 | `usage_parser: claude-stream-json` and `usage_patterns` that would also match | Run ends | Counted once, by the parser (readUsage skipped this run) |
| AT-8 | Runs ending as: DONE; WAITING naming a gate whose result is absent; WAITING on the same gate as the previous run; no line; hung; rate limit; transient; exit unknown with no line; vars lost | Each ends | Classes and reasons per §4.2. `reload` set on the resumed run after the hung one. `lair_restart` set on exit unknown and vars lost |
| AT-9 | A review run that records a review; one that ends with none; a planner run with 2 proposals; one with 0; a verifier with verdicts; one with none; a supervisor run that answered; one that didn't | Each ends | `productive/review_recorded`, `idle/no_review`, `productive/proposals`, `idle/no_proposals`, `productive/verdicts`, `idle/no_verdicts`, `productive/answered`, `idle/no_answer`, each with its origin |
| AT-10 | 3 days of rows | `GET /api/agents/spend?window=7d&by=task` with an owner session; then without one; then `window=year`; then `window=1y&by=task` | 200 with totals, waste share, top tasks and each guard's mode and counts; **401/403** without the owner; **400** naming `window` for the bad value; **400** saying a window past 90 days has no per-task detail. The response holds no prompt text or log line (asserted by scanning for the fixture's prompt marker) |
| AT-11 | spend on. The clock passes 00:05 UTC. Lair restarts at 00:06 | Ticks | Exactly one `spend_daily` event and one bus `agents.spend.daily` for the day before |
| AT-12 | `notice.waste_share: 0.5`, `min_runs: 20`. 25 runs today, 14 idle or no-result | Tick | One `spend_waste` item with `attention: "notice"` (no external notification sent). With 19 runs, none. The next day's first tick withdraws it |
| AT-13 | G1 `act`. Three agents waiting on provider P. A run's last line is a real `DAILY_REQUEST_COUNT` 429 body, which also matches the default `rate_limit_patterns` | Tick, then the clock passes 30 min, then 60 | The run ends as a `failover` event of kind `quota`, not `rate_limit`, and its chain's `failovers` doesn't grow. Every agent's starts on P wait at once (no two-agent threshold). One decision for P, not per task. At 30 min one probe starts. When it hits the quota again, the next probe is at +60 min. The waiting runs' `failovers` don't grow |
| AT-14 | G1 `act`. A quota line with `resets 5am` (no zone) and the server's clock at 01:00 local time | Tick | Cools until 05:00 in the server's local zone (capped at 24 h). An unparseable reset falls back to the backoff |
| AT-15 | G1 off | The same input as AT-13 | Today's behaviour, unchanged (regression check) |
| AT-16 | G2 `act`, `max: 3`. One task: crashed, hung, crashed across two chains. A second task whose 3 failures happened during a fleet outage. A third whose only failures are Lair restarts and stops: `exit_unknown`, `vars_lost`, `stopped` | Ticks | The first task is held `no_result_cap` with one decision and its claim released. The second and third aren't parked. `start_again` resets the count. Answering twice is refused (decision already answered) |
| AT-17 | G3 `act`. WAITING line with `(?<pr>42)`. No fallback timer due | `review.submitted` for PR 41, then for 42 | Nothing for 41. For 42, the task starts once. A restart between the event and the tick still starts it once (state check). After `max_wait_minutes` with no event, one decision |
| AT-18 | G3 `act`. WAITING naming nothing | Ticks | Fallback after `fallback_seconds`, doubling after each idle completion. Held after `max_completions_without_done` (today's rule) |
| AT-19 | G4 `act`, `max_per_task: 2`, `first` unset. Then `first: fresh` with `mode: off` | The task hangs, restarts, hangs again. Then the same with the second config | First config: the first restart is `sessionMode: resume` (today's behaviour). After the second hang the task is held `hung_repeat` with one decision, and no resume run is created. Second config: the first restart is `fresh` with the hung block, and nothing is parked (`mode: off`) |
| AT-20 | G5 `guard_mode: act`, `daily_requests: { soft: 50, hard: 60 }` | Runs add 55, then 61 requests | One `attention: "notice"` item at 55. At 61 the existing `spend` decision fires and new runs wait. The running ones continue |
| AT-21 | spend off | Every action above | No `agents_spend` rows, no events, no panel, and the route returns 404 with `agents.spend.enabled is off` |
| AT-22 | v1, v2 and v3 `agents.db` files from fixtures | Open with the new store | Migrates to v4. Existing runs, events and usage are kept, and `agents_spend` exists |
| AT-23 | Config with a bad `request_pattern`, `waste_share: 2`, or `max_backoff_minutes < backoff_minutes` | Load | Refused, naming each key. The previous config stays live |
| AT-24 | G6 `prefilter_closed: act`. A backlog task whose id is a done id. A plan task `t-42` whose own PR #42 (head branch contains `t-42`) `review.db` records as merged. A follow-up task "fix the regression from #42" with no PR of its own | A planner trigger. The run returns an `add` for `t-42`, and one for the follow-up | The context holds neither of the first two, and `closed` lists both. The follow-up stays in the context. The `add` for `t-42` is refused with its reason, and no verifier run is requested for it. The follow-up's `add` goes on to the verifier |
| AT-25 | G6 `handled_messages: act`. Owner message M | A proposal with `from_message: M` is applied and its task's DONE line arrives. Then a proposal with `from_message` set to an id not in the context. Then the owner reopens M (`POST /api/planner/messages/M/reopen`), twice; then `.../handled` for an unknown id; then a request without an owner session | The planner prompt documents `from_message`. M is handled, absent from the next context, and raises no `owner_message` trigger. The unknown `from_message` is refused. Reopening puts M back, and a second reopen changes nothing. The unknown id gets **404**. The request without an owner session gets **401/403** |
| AT-26 | G6 `skip_unchanged` `act`. Run R1 with context hash H ended with only refused proposals | New `recentEvents` arrive and a trigger fires with otherwise the same inputs; Lair restarts; another trigger; then a new owner message; then the clock passes `max_skip_hours` | Both same-input triggers are skipped (`planner_skipped`, no agent run). The new events don't change the hash, and the skip holds across the restart. The new message starts a run. After `max_skip_hours` a run starts even with hash H |
| AT-27 | G6 off | The inputs of AT-24 to AT-26 and AT-30 | Today's behaviour, unchanged |
| AT-28 | Each guard (G1, G2, G3, G4, G5 and the four G6 parts) in `observe`, with the inputs of its act test (AT-13, 16, 17, 19, 20, 24, 25, 26, 30) | The same actions | Nothing changes: runs start, restart and wake as today, and planner runs start and the file is restored as today. G1's quota line is reported as `rate_limit` and follows today's rate-limit path. Exactly one `guard_would` event per subject and streak, with the **same verdict and subject** the act test produced. One `attention: "notice"` item each, the API's `would` count goes up, and no `guard_did` event is written |
| AT-29 | spend on. Per-run rows from 100 days ago and from 400 days ago. One day with no aggregate yet. One day whose aggregate was written before a late row arrived (an exit-unknown run that ended after 00:05) | The daily pruning tick, run twice | Every day's aggregate is upserted again right before its per-run rows go: the day with none gets one, and the late row is counted in its day's aggregate. The 100-day-old rows are deleted and their day's aggregate stays. The 400-day-old aggregate is deleted. A second run writes and deletes nothing more. `window=1y` totals match the sum of the per-run rows they came from |
| AT-30 | G6 `recheck_on_change: act`. Planner run R with 3 proposals. While R runs, the tasks file gains a DONE line for one proposal's task and an outside edit to another line | R ends | The file keeps the edit, which is recorded with its diff, and one notice names R. The proposal whose task is now done is refused with that reason. The other two go on to the verifier. `R.tampered` stays true. With `observe`, the file is restored and all 3 are refused as today, with `would_apply: 2` |
| AT-31 | spend on. A task's run ends BLOCKED naming PR #42 at head A | A second run ends BLOCKED with the same blocker text (other times, other attribution), PR #42 still at A, no productive run between. Then PR #42 moves to head B and a third run ends BLOCKED the same way | Run 1 is `productive/blocked`, run 2 `idle/blocked_repeat`, run 3 `productive/blocked`. `blocker_key` holds only a hash, and no row or response holds the blocker text (asserted by scanning for it) |
| AT-32 | `claude-stream-json`. A recorded first run, then a `--resume` run of the same session, each with a `result` line | Both end | The resumed run's row holds only its own process's tokens and cost. If the CLI reports the session's running total, the parser subtracts the first run's row of the same session id, and a lower total than the previous one records 0, never a negative |
| AT-33 | `agents.spend.enabled: false`, with `failover.quota.mode: observe`, then a `daily_requests` limit, then only `budgets.guard_mode: observe` with a `daily_cost` hard limit | Load | The first two are refused, naming both keys. The third loads, and its `daily_cost` hard limit blocks as today |
| AT-34 | spend enabled for the first time. Runs from the last 10 days in the store | First enable, then a second start | Runs from the last 7 days get rows with `backfilled = 1` and `usage_source: none`. Older runs get none. The second start adds nothing |
| AT-35 | The Home view, with API fixtures: one reported adapter, one request-lines adapter, guards in observe. Then spend off | Render; switch today / 7 days; then render with spend off | The panel shows the stacked bars, the waste share, top reasons and tasks, and one line per guard with its `would` count. The request-lines adapter shows "not reported" for tokens and cost. The switch refetches with `window=7d`. With spend off, there is no panel |

## 6. Security and privacy

- **No prompt text is stored.** `agents_spend`, the API, the daily summary and the notices hold numbers, ids (run, task, agent, provider, model, PR number, head sha), enum classes and reasons, and byte sizes. They never hold a prompt, a resume summary, a log line or model output. The usage parser keeps only the fields it reads, and the line itself is discarded.
- **Logs are untrusted input.** An agent writes its own log, so a run could print a fake `result` line. Values are parsed with `JSON.parse` on lines of at most 1 MB (the log read in 1 MB chunks), kept only if finite and non-negative, and capped per run. Reported usage stays advisory for budgets, as `docs/configuration.md` already says: keep a spending limit at the provider too. Patterns are compiled once at config load and run only on bounded text.
- **Async only** in the tick and in request paths: no synchronous fs or child process. Rollups are SQL over indexed columns, bounded by window and `LIMIT`.
- **Owner-only routes.** There are no mutating spend routes. The only new mutating routes are G6's two planner routes (`.../messages/:id/handled` and `.../reopen`), which are owner-only, idempotent, and have no public allow-list entry. The guards' decisions are answered through the Decision Inbox's existing owner-only routes, and `spend` answers still need `confirm: true`.
- **Notices carry only titles and numbers**, so the notifier's rule ("never a decision's context, a log line or a secret") holds.
- **Retention** is bounded: `retention_days` for per-run rows and `aggregate_days` for daily aggregates. Deleting `agents_spend` rows never changes `agents_usage`, which stays the budget ledger.
- **BLOCKED lines** are compared by a sha256 key only, and the blocker text is never stored.
- **G6 `recheck_on_change`** keeps an outside edit to the tasks file made during a planner run. It is never silent: the edit is recorded with its diff, a notice names the run, and the owner can restore the file.

## 7. PR plan

Each PR is separate, has tests and docs (`docs/configuration.md`), and sits behind its switch. Every guard PR ships its `observe` and `act` paths together, with the default `off`. The operator's install then turns each guard on in `observe`. Turning one to `act` after a week of evidence is a config change, not a PR.

1. **Measure.**
   - Store v4 with `agents_spend` and `agents_spend_daily`, and a migration test that opens real v1, v2 and v3 files.
   - `usage_parser` and `request_pattern` on adapters, with built-in defaults (the `kiro` default here; `claude-code`'s in 1b).
   - The run-end parser and its idempotent write, with the token definition (cache reads left out of `tokens`).
   - The new `RunOrigin` values, set by the review assigner, the planner, the verifier and the supervisor. `spend.recordCall`.
   - The `guard_would` and `guard_did` event kinds, and `budgets.guard_mode` (accepted, default `observe`) for the request and minute limits of G5. The existing token and cost hard limits block as today whatever it says; more usage counts toward them once adapters report it, and the docs say so.
   - The guards-need-spend config check.
   - ATs 1-5, 7, 21-23, 33.
   - 1b. **Claude Code stream-json (D5).** This is split out because it changes the built-in adapter's output for every user of it. The new `start_cmd`, the new `status_pattern`, the `init` event's `session_id` for resume, the `output: text` option, and the check that a resumed run's `result` doesn't double-count (subtracting when it would). ATs 6, 32. Depends on PR 1.
2. **Classify and API.** Classes and reasons, including the BLOCKED repeat rule (D1), `no_verdicts` and `no_answer`. Reload and restart flags. The per-task, per-head and planner rollups. The **backfill**, which needs the classification. `GET /api/agents/spend` and `.../runs`, with each guard's counts. The daily summary event and the daily aggregates, with retention and re-aggregation before deletion (D4). The notices. ATs 8-12, 29, 31, 34.
3. **Dashboard.** The Home AI spend panel, with the guard lines and "not reported", and the AgentDetail spend line. AT-35.
4. **G1 fleet quota cooldown** (#185's reset-time part). The `quota` failover kind, checked before `rate_limit`, and not counted toward `max_failovers`. Replaces the interim 120-minute cooldown once it acts. ATs 13-15, and AT-28 for G1. Docs: the `Failover.` bullet.
5. **G2 per-task no-result cap and G4 hung-repeat rule.** G2 leaves out fleet failures, Lair restarts and stops. G4's `first` is its own switch. Two fill holds and their decisions. ATs 16, 19, and AT-28 for G2 and G4.
6. **G3 event wake.** ATs 17-18, and AT-28 for G3. Docs: Fill → wake.
7. **G5 budget metrics and soft notice.** AT-20, and AT-28 for G5. Docs: `Budgets.`.
8. **G6 planner guards:**
   - Filter closed work, by the task's own merged PR only.
   - Handled owner messages: the `from_message` field in the planner prompt's appended instructions, and the two owner-only routes `POST /api/planner/messages/:id/handled` and `.../reopen`.
   - Skip unchanged runs, hashing only the listed inputs.
   - Apply what still holds after a tasks-file change (D7).
   - ATs 24-27, 30, and AT-28 for G6. Docs: the planner section of `docs/configuration.md`, and [planner.md](planner.md).

PRs 4 to 7 depend on PRs 1 and 2, which add the measures, the observe events and the counts, so they can be built in parallel after them. PR 8 needs PR 1's event kinds and PR 2's counts. Once PR 4 acts on the operator's install, #185 can close for its reset-time part.

## 8. Decisions (2026-11-02, by the orchestrator under the owner's delegation of feature decisions)

- **D1. BLOCKED reports.** The first BLOCKED for a given blocker counts as productive. A repeat with the same blocker (text, gate or PR) and no push since counts as idle (`blocked_repeat`). *Reason:* the first report surfaces information; a repeat with nothing new is a wasted run.
- **D2. Fleet failures and G2.** Runs that fail during a fleet outage or a fleet quota cooldown don't count toward G2's cap. By the same reasoning, neither do runs ended by a Lair restart (`lair_restart`) or a stop. *Reason:* none of these is the task's fault, and G1, the transient rule and the restart path already handle them.
- **D3. No estimates.** For adapters that report no tokens, Lair shows requests and minutes only. Tokens and cost show as "not reported", and there is no `estimate` option. *Reason:* an invented number would mislead the panel and the budgets.
- **D4. Retention.** Per-run rows are kept for 90 days, then daily aggregates for 1 year. *Reason:* per-run detail is needed only for recent investigation, while yearly trends need just the totals.
- **D5. Claude Code output.** The built-in `claude-code` adapter defaults to `--output-format stream-json --verbose` (PR 1b). Its `status_pattern` changes to match the `result` event. The `init` event's `session_id` is used for resume. The status and hung rules are tested against a recorded stream-json log, and `output: text` keeps the old format. *Reason:* the stream-json output is the only one that reports usage and cost.
- **D6. Thresholds and modes.** The thresholds are as recommended in §4.6. Every guard has a `mode` (`off`, `observe`, `act`) and ships in `observe`, with "would park, skip or cool down" notices and counts. Each guard moves to `act` on its own after a week's evidence. *Reason:* each guard's verdicts are checked on real data before it acts.
- **D7. A tasks file that changed during a planner run.** Each proposal is checked at apply time against the current tasks file, and the ones still valid are applied (G6 `recheck_on_change`). The whole run is no longer refused because the file changed. *Reason:* 9 runs were refused whole, though most of their proposals were still valid. The changed file is recorded and announced instead of reverted.
