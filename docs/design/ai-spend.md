# AI spend and waste

- **Status:** design, docs only. Nothing here is built. The owner approves this document before any code.
- **Base:** main `9bce85a`.
- **Related:** [autonomy.md §6](autonomy.md#6-agents-budgets-failover-and-session-recovery-module-agents) (the agents module), [review-stages.md](review-stages.md) (staged review slots, `ask_after`, built separately), [planner.md](planner.md), [decision-policies.md](decision-policies.md) (the brain), issue #185 (usage limit detector).

Lair starts AI runs by itself: builder agents through fill, reviewer agents through the review assigner, the planner and its verifier, and the supervisor. Nothing records what those runs cost or how many of them were wasted. This spec adds three things:

1. **Measure:** record usage for every run, reported by the adapter where it can, estimated where it can't.
2. **Classify and show:** classify every run as productive, idle or no-result, and show it in an API, a dashboard panel, a daily summary and threshold notices.
3. **Guard:** add six guards, each off by default, against the waste patterns found below.

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

One more finding: an adapter **can** report its cost. During an earlier fallback window, a Claude Code adapter run with `--output-format stream-json` wrote 234 final `result` events. They carry `total_cost_usd`, `usage` (input, cache creation, cache read and output tokens), `num_turns` and `duration_ms`. Together they report **$413.22**, including $21.98 spent by 80 runs that ended on a usage-limit error. Lair recorded none of it.

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
| Usage ledger | `src/server/agents/store.ts:73-84` (`agents_usage`), `:535` `addUsage`, `:554` `usageSince` | One row per usage record: project, agent, provider, run, tokens, cost, time, reason | Nothing writes to it in practice (0 rows). It holds no input/output/cache split, no request count, no estimate flag |
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
| Run origin | `src/shared/agents-types.ts:53` `RunOrigin = "fill"` | Marks fill's runs | Review, planner, verifier and supervisor runs are told apart only by task-id prefix |
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
| Claude Code, plain `-p` (the built-in default) | Text only | Estimated |
| Kiro CLI | One `... GenerateAssistantResponseCommand done totalEvents=<n>` line per model request. No tokens, credits or cost | Requests counted (a measured fact). Tokens and cost estimated. This provider's daily quota counts requests, so the request count is the number that matters |
| Aider and others | Varies. `usage_patterns` still works | Patterns, or estimated |

### 2.3 Docs

`docs/configuration.md` already documents these, and they stay true:

- Failover and cooldowns: the `Failover.` bullet under [Agents](../configuration.md#agents).
- "Transient errors are waited out".
- `Budgets.`, which says budgets are advisory while usage comes from run logs.
- `usage_patterns` in the options table.

## 3. Gaps

1. No usage is recorded. The one regex path can't parse the one adapter that reports cost, and the Kiro CLI reports no tokens at all.
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

### 4.1 Measure

**A usage parser per adapter.** `agent_adapters.<id>.usage_parser` takes one of:

| Value | What it reads at run end |
|---|---|
| `claude-stream-json` | The last line whose JSON has `"type":"result"`, from the log's last 256 KB. It takes `usage.input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`, `total_cost_usd`, `num_turns` (as requests) and `is_error` |
| `claude-json` | The same fields from the one JSON object the run wrote |
| `request-lines` | Counts lines matching `request_pattern` (an adapter field, at most 500 characters, case-sensitive, compiled once) over the whole log, read in 1 MB chunks across ticks like `readUsage` does today. That gives requests, no tokens |
| `patterns` | Today's `usage_patterns` (the default when they are set) |
| `none` | Nothing is reported. The run is estimated |

The built-ins get defaults:

- `claude-code`: `claude-stream-json`. Its `start_cmd` gains `--output-format stream-json --verbose`, which is open question Q5.
- `kiro`: `request-lines`, with `request_pattern: "GenerateAssistantResponseCommand done"`.
- The others: `none`.

When `usage_parser` is set to anything but `patterns`, `readUsage` skips that run, so nothing is counted twice.

**When it runs.** Once per run, on the tick that ends it (completed, failed, failover or stopped). It also runs for adopted runs, before anything moves the log. It parses with async I/O only (`readTailText`, `readFrom`) and never with synchronous fs in the tick. The result is written in one store transaction: one `agents_spend` row (§4.3) and one `agents_usage` row through the fleet budget path, as `readUsage` does today. That transaction sets `agents_spend.usage_recorded = 1`, so a retry or a restart never adds the usage twice.

**Estimate when nothing is reported.** Every run records two measured facts: `runtime_s`, from spawn to the end (for exit-unknown runs, to the log's last write rather than the time Lair noticed), and `context_bytes`, the size of the prompt file Lair wrote plus the resume summary, as sizes only. Runs whose adapter uses `request-lines` also record `requests`. Tokens and cost are estimated only when the adapter sets `estimate: { tokens_per_request, cost_per_request, tokens_per_minute, cost_per_minute }`. Requests come first, then minutes. The row says `usage_source: estimated`, and every view labels estimates as such. With no estimate set, a run shows requests and minutes and no tokens or cost: nothing is invented.

**Module runs and other model calls.** `requestRun` takes an optional `origin`:

- `review`: set by the review assigner.
- `planner` and `verifier`: set by the planner.
- `supervisor`: set by the supervisor chat and digest.
- `owner`: set by `POST /api/agents/runs`.
- `fill`: unchanged.

A run with no origin falls back to its task prefix. Model calls a module makes without an agent run go through a single in-process function, `spend.recordCall({ project, module, provider, model, requests, tokens, cost, source })`, which writes `agents_usage` with `run_id` null and `reason: "call:<module>"`. Today no server module makes such calls. The brain is a local classifier with no tokens: its evaluations are counted as `brain` calls with 0 tokens, so the panel shows it costs nothing. If a future brain uses a remote model, it must call `recordCall`. The bench CLI stays outside the server and prints its own usage.

**Planner and verifier model calls.** Every planner run and every verifier run is an agent run, so its usage is recorded like any other run's. `planner_runs` already holds `agent_run_id` and `verifier_run_id`. The spend rollup joins on them to give, per planner run, its own requests, tokens and cost plus its verifier's, and the proposals by status. The panel then shows the **cost per applied proposal** and the planner's waste share (runs with no applied proposal).

### 4.2 Classify every run

At run end, each run gets one class and one reason. Everything used is data Lair already has: run state and detail, fill's events, the review store, and the planner store.

| Class | Reasons (enum) | Rule |
|---|---|---|
| `productive` | `done`, `ready`, `blocked`, `gate_queued`, `review_recorded`, `proposals`, `verdicts`, `answered` | A `fill_done` or accepted READY. A `fill_blocked` (the task goes to the owner with what was learned; Q1). A WAITING whose wake was absent when the run ended and differs from the previous run's wake (this run queued the gate, so it pushed). A review recorded by this run's assignment. A planner run that wrote one or more proposals. A verifier that wrote verdicts. A supervisor run that answered |
| `idle` | `waiting_same`, `waiting_unnamed`, `no_line`, `no_review`, `no_proposals` | Exit 0 and nothing above: a WAITING on the same wake as the previous run or on nothing Lair can watch, no queue line, a review run with no review, a planner run with no proposals |
| `no_result` | `hung`, `crashed`, `dead_on_start`, `never_started`, `rate_limit`, `provider_error`, `unreachable`, `exit_unknown`, `lost`, `vars_lost`, `lost_claim`, `stopped` | Any failed end, by the run's existing end kind. `stopped` covers an owner stop or a shutdown |

**Other measures:**

- `reload: true` on a run whose `sessionMode` is `resume` or `fresh` and whose previous run in the chain was `no_result`. Its `context_bytes` and its first request are the cost of the reload.
- A `lair_restart` flag on `exit_unknown`, `lost` and `vars_lost` runs. It shows how much a Lair restart cost.
- **Per task:** attempts, completions (productive runs ending in `done` or `ready`), no-result count and chains, over today, 7 days and since the task first ran.
- **Per PR head:** review runs, reviews recorded and review runs that failed (from `review_agent_assignments` and `review_reviews`).
- **Planner:** proposals by status (`applied`, `declined`, `rejected`, `pending`) and the verifier verdict, from `planner_proposals`.

**The waste share** of a window is `(idle + no_result) / total`, in each unit there is data for: cost (reported), tokens (reported), requests, agent-minutes and runs. The panel shows the unit with the best data first: cost if any reported cost exists, then requests, then minutes.

### 4.3 Storage

The agents store goes to schema v4 on main (it is v3; no open PR changes it). It gets a new table, created with `CREATE TABLE IF NOT EXISTS` like the rest of the schema, so v1 to v3 files migrate:

```sql
CREATE TABLE IF NOT EXISTS agents_spend (
  run_id TEXT PRIMARY KEY,           -- one row per run: idempotent
  project TEXT NOT NULL, agent TEXT NOT NULL, task TEXT NOT NULL, chain_id TEXT NOT NULL,
  origin TEXT NOT NULL,              -- fill | review | planner | verifier | supervisor | owner | other
  adapter TEXT NOT NULL, provider TEXT NOT NULL, model TEXT,
  started_at INTEGER, ended_at INTEGER NOT NULL, runtime_s INTEGER NOT NULL,
  class TEXT NOT NULL, reason TEXT NOT NULL,
  session_mode TEXT NOT NULL, reload INTEGER NOT NULL, lair_restart INTEGER NOT NULL,
  usage_source TEXT NOT NULL,        -- reported | requests | estimated | none
  input_tokens INTEGER, cache_write_tokens INTEGER, cache_read_tokens INTEGER, output_tokens INTEGER,
  requests INTEGER, cost REAL, context_bytes INTEGER NOT NULL,
  pr INTEGER, head_sha TEXT,         -- review runs only
  usage_recorded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agents_spend_time ON agents_spend(project, ended_at);
CREATE INDEX IF NOT EXISTS idx_agents_spend_task ON agents_spend(project, task, ended_at);
```

Rows older than `agents.spend.retention_days` (90) are deleted, at most once a day, in the tick and asynchronously in batches of 1,000.

**Backfill.** On first enable, the runs from the last `backfill_days` (7) are classified from the run records and events Lair already holds. Their usage is `none`, because their logs may have moved. They are marked `backfilled`, so the first panel isn't empty.

### 4.4 Show it

**API** (owner session; mutates nothing; no public allow-list entry, because cost and usage are the owner's data):

- `GET /api/agents/spend?project=<p>&window=today|7d&by=project|agent|task|reason|origin|provider` returns:
  - totals per class and unit;
  - the waste share;
  - groups sorted by waste;
  - `reloads` and `lairRestarts`;
  - the 10 tasks with the most attempts without a completion;
  - reviews per head (heads reviewed more than once);
  - planner acceptance;
  - `estimated: true` on every number that is an estimate.
  "today" is the UTC day.
- `GET /api/agents/spend/runs?project=<p>&task=<id>&limit=` returns that task's run rows. These hold numbers, ids and enums only, never a prompt or a log line.

**Dashboard.** Home gets an **AI spend** panel, shown only while `agents.spend.enabled` is on. It has:

- a today / 7 days switch;
- one stacked bar per unit (productive, idle, no-result);
- the waste share;
- the top 5 waste reasons and top 5 tasks by attempts without a completion;
- a table by project, agent, origin or task;
- reloads and Lair-restart losses;
- an "estimated" badge wherever a number is estimated.

AgentDetail gets a "Spend" line (today's runs per class and cost or requests) next to its Budget section. Charts follow the dashboard's existing component styles.

**Daily summary.** At `agents.spend.daily_summary_utc` ("00:05"), for the UTC day that just ended, each project records one `spend_daily` event (dedupe key `spend_daily:<project>:<date>`, so a restart doesn't repeat it). It is published on the event bus as `agents.spend.daily`. The data is the same totals the API gives for that day: numbers, enums and task ids only. The supervisor digest may read it. No AI run makes it.

**Notices.** These are Decision Inbox items of the notice tier: the notifier never sends a notice outside Lair, and each one is withdrawn when its condition clears.

- `spend_waste`: the day's waste share in the panel's unit passes `notice.waste_share`, with at least `notice.min_runs` runs that day. One per project per day.
- `spend_task_attempts`: one task's attempts without a completion pass `notice.task_attempts` within 24 h. One per task per streak, withdrawn when the task completes or is released.

Both are off until their threshold is set.

### 4.5 Guards (each off by default)

**G1. Fleet quota cooldown.** This extends `agents.failover`. Today's cooldown already becomes fleet-wide once two agents hit it within 30 minutes. G1 adds what a quota needs (this is #185's reset-time part):

- `failover.quota.patterns`: lines that mean a quota, not a burst. The generic examples are `DAILY_REQUEST_COUNT` and `hit your .* limit`. A pattern may capture `(?<reset>...)`, which is read as an ISO time, `HH:MM` with an optional zone, or `in <n> (minutes|hours)`.
- A quota line cools the provider **for every agent at once**, with no two-agent threshold, because a quota is account-wide. The cooldown lasts until the parsed reset time, capped at 24 h. If no reset time is given, it lasts `quota.backoff_minutes` (30), doubling per failed probe up to `quota.max_backoff_minutes` (240).
- When the cooldown ends, **one probe start** tries the provider, exactly as a transient outage does. Others wait. A probe that works clears the cooldown and every waiting run starts. A probe that hits the quota again doubles the wait.
- A run waiting on a fleet quota counts no failover, no recovery and no `start_timeout_minutes`. Instead of one decision per task, **one decision per provider and cooldown** is raised: "Keep waiting" (recommended), or "Try now".
- A run already running isn't stopped by someone else's quota line. It ends on its own, as today.
- Recommended: on, with patterns for the CLIs in use. On the 48 hours above, this would have replaced 114 failed starts with about 6 probes, and 77 decisions with 1.

**G2. Per-task no-result cap.** `agents.spend.guards.task_no_result_cap: { max: 0, window_hours: 24 }`. Recommended: `max: 6`.

- When a task reaches `max` no-result runs within the window, across all its chains, it is parked, not restarted.
  - A fill task gets the fill hold `no_result_cap`, its claim is released, and one `escalation` decision is raised per task and streak. The options are `start_again` (resets the count), `fresh_session` and `keep_parked`.
  - A module run (review, planner, verifier) ends its chain and is escalated once through the existing `escalate` path. Its module's own caps still apply.
- Runs that died while their provider was in a **fleet** outage or fleet quota cooldown don't count, because that is the provider's fault and G1 and the transient rule handle it.
- On the data above, with `max: 6`, the 13 tasks that took 10 or more attempts would each have stopped at their sixth no-result run and asked once.

**G3. Waiting agents woken only by the awaited event.** This extends `agents.fill.wake`.

- `wake.events: { enabled: false }`. With it on, `waiting_pattern` may capture, besides `(?<wake>...)` (a gate, as today):
  - `(?<pr>\d{1,7})`: wakes on `review.submitted`, `review.invalidated` or `review.merged` for that PR, or a merge refusal;
  - `(?<decision>[A-Za-z0-9_-]{1,64})`: wakes when that decision is answered;
  - `(?<message>bus)`: wakes on a bus message to the agent.
- A wait that names a known event has **no fallback timer**. It is still bounded by `max_wait_minutes` (one decision, as today).
- Lost events: on startup, and every `poll_seconds`, Lair checks the current state once (PR reviewed or merged since the wait began, decision answered, unread bus message). A missed event can't strand a wait, and a woken run is never started twice: the wake is recorded per run (`fill_woken`) as today.
- The fallback timer stays only for waits that name nothing, as today. Each idle completion on it doubles the next fallback, up to `max_backoff_seconds`. `max_completions_without_done` still holds the task after 3.
- Recommended: on, with the `pr` and `decision` captures added to the project's `waiting_pattern`.

**G4. Hung-repeat rule.** This extends `agents.recovery`: `hung_repeat: { max_per_task: 0, window_hours: 24, first: resume }`. Recommended: `max_per_task: 2`, `first: fresh`.

- `first` sets how the first hang restarts. `resume` is today's behaviour. `fresh` starts a fresh session with the hung-info block and a resume summary, so the stuck context isn't re-sent.
- The `max_per_task`-th hang of a task within the window, in any chain, **parks** it with the fill hold `hung_repeat` (or escalation for a module run) and one decision. Options: `fresh_session` (with the hung info), `keep_parked`, `release`. The task is not resumed again.
- On the data above, with `max_per_task: 2`, the 59 repeat hangs (3,011 agent-minutes) would have been 26 parked tasks, each asked about once.

**G5. Daily budget per project with an owner notice.** This reuses `agents.budgets` and adds no second budget system.

- New metrics `daily_requests` and `daily_minutes` (`monthly_*` too), counted from `agents_spend`. These cover adapters that report no tokens: for a provider whose quota counts requests, a soft limit at 80 % of the quota warns before the wall.
- A soft limit also raises a notice-tier inbox item, once per scope, metric and period. Today it is only an event. A hard limit stays the existing `spend` decision.
- Estimated tokens and cost count toward `*_tokens` and `*_cost` limits only with `budgets.count_estimates: true` (default false), so a guess never blocks runs by itself.
- Recommended for the deployment above: `project: { daily_requests: { soft: <80 % of the provider's daily quota> } }`, plus `daily_cost` soft and hard limits at amounts the owner chooses for each paid provider.

**G6. Planner guards: propose only what can apply.** These extend `planner:` with `guards`. All three parts are cheap and deterministic: no model is called and no network is used.

- **Filter closed work before proposing** (`guards.prefilter_closed: false`).
  - Before the context is built, Lair drops from `openTasks`, and from the triggers, every task whose id is a done id of the tasks file, and every task whose text names a PR (`#<n>`, `PR <n>`) that the review store records as merged.
  - It reads only local stores: the tasks file and `review.db`.
  - The context gains `closed: { tasks, mergedPrs }` (the newest 200 of each), so the model also sees what is finished.
  - After the run, one new rule refuses an `add` whose text names a merged PR, with the reason. Like every rule refusal, this happens before the verifier is asked, so the verifier run is saved too.
- **Mark an owner request handled once a task closes it** (`guards.handled_messages: false`).
  - A proposal may carry `from_message: <id>`. It must be an owner-message id in that run's context, or the proposal is refused.
  - When a proposal with `from_message` is applied and its task later closes (its DONE line, or an applied `finish`), Lair records the message as handled in `planner_state` (keyed by message id, so it is idempotent; at most 1,000 kept; with the task and the time). A handled message is left out of later contexts and triggers.
  - A message whose proposal was declined or refused stays open.
  - The owner can mark a message handled, or reopen it, from the planner view through an owner-only route.
- **Skip a run when nothing changed** (`guards.skip_unchanged: { enabled: false, max_skip_hours: 24 }`).
  - Lair hashes, with sha256, the context it would give the planner run, with volatile fields (times, trigger times) removed.
  - If the last finished run with the same hash ended with no applicable proposal (none applied or pending), the new run is skipped. No agent run starts, the triggers are consumed, and a `planner_skipped` event records the hash prefix and the earlier run's id.
  - Any real change (an owner message, a task line, a done line, a new idle set) gives a new hash, and the planner runs.
  - Once `max_skip_hours` has passed since the last run, it runs anyway.
  - The hash and the outcome are kept in `planner_state`, so a restart doesn't undo the skip.
  - The spend panel counts skipped runs.
- Recommended: all three on. On the 48 hours above, the proposals for closed task ids and for the old, already carried out request would not have been made.

**Not here.** Staged review slots (`ask_after`, [review-stages.md](review-stages.md), PR #291) stop an expensive reviewer slot from running before the gate or the earlier slots. This spec only measures reviews per head and review-run waste, so the effect of `ask_after` shows in the panel.

### 4.6 Configuration (recommended values shown; every default is off)

```yaml
agent_adapters:
  my-claude:
    # ...start_cmd with --output-format stream-json --verbose...
    usage_parser: claude-stream-json
  my-other-cli:
    usage_parser: request-lines
    request_pattern: "GenerateAssistantResponseCommand done"
    estimate: { tokens_per_request: 0, cost_per_request: 0 }   # 0: show requests, invent nothing

agents:
  failover:
    quota:                                   # G1
      patterns: ["DAILY_REQUEST_COUNT", "hit your .* limit . resets (?<reset>\\d{1,2}(:\\d{2})?\\s?[ap]m)"]
      backoff_minutes: 30
      max_backoff_minutes: 240
  recovery:
    hung_repeat: { max_per_task: 2, window_hours: 24, first: fresh }   # G4
  budgets:
    project: { daily_requests: { soft: 800 }, daily_cost: { soft: 40, hard: 50 } }   # G5
  fill:
    wake:
      events: { enabled: true }              # G3, with (?<pr>...) in waiting_pattern
  spend:
    enabled: true
    retention_days: 90
    backfill_days: 7
    daily_summary_utc: "00:05"
    notice: { waste_share: 0.5, min_runs: 20, task_attempts: 6 }
    guards:
      task_no_result_cap: { max: 6, window_hours: 24 }   # G2

planner:
  guards:                                    # G6
    prefilter_closed: true
    handled_messages: true
    skip_unchanged: { enabled: true, max_skip_hours: 24 }
```

Config is checked at load, and errors name the key:

- A pattern that doesn't compile is refused.
- A `request_pattern` longer than 500 characters is refused.
- `waste_share` must be in (0, 1].
- `max_backoff_minutes` must be at least `backoff_minutes`.
- `quota.patterns` must not be empty when `quota` is set.
- An `estimate` must not be negative.
- `daily_summary_utc` must be `HH:MM`.
- A `reset` group that isn't a time is ignored, and the cooldown falls back to the backoff.

## 5. Acceptance tests

Each test drives the real entry point (the agents tick, `requestRun`, the route), with real payloads copied from the emitters on main and from sanitized real logs. Each fakes only one named boundary: the process spawner and clock in `probes`, or the log file contents.

| # | Setup | Action | Expected |
|---|---|---|---|
| AT-1 | spend on. Adapter `usage_parser: claude-stream-json`. A log fixture ending with a real `result` line (cost 0.5177, 60 input, 55,895 cache write, 1,634,873 cache read, 13,052 output, 31 turns) | The process exits 0 with a DONE line | One `agents_spend` row (`productive`/`done`, `reported`, those numbers, requests 31) and one `agents_usage` row with cost 0.5177 and tokens = the sum. Budgets see it |
| AT-2 | As AT-1 | Lair restarts between the end and the next tick, then ticks twice | Still one spend row and one usage row (`usage_recorded`) |
| AT-3 | stream-json log whose `assistant` events each carry `usage`, plus a final `result` | Run ends | Only the `result` line counts; no per-message double count |
| AT-4 | A `result` line with negative or non-numeric tokens, cost `1e9`, or a line over 1 MB | Run ends | Non-finite or negative values become 0. Values over the cap (tokens 1e10, cost 1e5 per run) are refused, the row is `usage_source: none`, and the event says why. Nothing throws |
| AT-5 | `usage_parser: request-lines`. A real Kiro CLI log with 30 request lines. No estimate set | Run ends | `requests: 30`, `usage_source: requests`, tokens and cost null, an "estimated" label nowhere because nothing was estimated |
| AT-6 | As AT-5 with `estimate.tokens_per_request: 1000` | Run ends | `usage_source: estimated`, tokens 30,000. A `daily_tokens` hard limit of 10,000 does **not** block new runs (count_estimates false). With `count_estimates: true` it does |
| AT-7 | `usage_parser: claude-stream-json` and `usage_patterns` that would also match | Run ends | Counted once, by the parser (readUsage skipped this run) |
| AT-8 | Runs ending as: DONE; WAITING naming a gate whose result is absent; WAITING on the same gate as the previous run; no line; hung; rate limit; transient; exit unknown with no line; vars lost | Each ends | Classes and reasons per §4.2. `reload` set on the resumed run after the hung one. `lair_restart` set on exit unknown and vars lost |
| AT-9 | Review run that records a review; one that ends with none; planner run with 2 proposals; planner run with 0 | Each ends | `productive/review_recorded`, `idle/no_review`, `productive/proposals`, `idle/no_proposals`, with origin `review` or `planner` |
| AT-10 | 3 days of rows | `GET /api/agents/spend?window=7d&by=task` with an owner session; then without one; then `window=year` | 200 with totals, waste share and top tasks; **401/403** without the owner; **400** naming `window` for the bad value. The response holds no prompt text or log line (asserted by scanning for the fixture's prompt marker) |
| AT-11 | spend on. The clock passes 00:05 UTC. Lair restarts at 00:06 | Ticks | Exactly one `spend_daily` event and one bus `agents.spend.daily` for the day before |
| AT-12 | `notice.waste_share: 0.5`, `min_runs: 20`. 25 runs today, 14 idle or no-result | Tick | One notice-tier `spend_waste` item (no external notification sent). With 19 runs, none. The next day's first tick withdraws it |
| AT-13 | G1 on. Three agents waiting on provider P. A run's last line is a real `DAILY_REQUEST_COUNT` 429 body | Tick, then the clock passes 30 min, then 60 | Every agent's starts on P wait at once (no two-agent threshold). One decision for P, not per task. At 30 min one probe starts. When it hits the quota again, the next probe is at +60 min. The waiting runs' `failovers` don't grow |
| AT-14 | G1 on. A quota line with `resets 5am` and the clock at 01:00 in that zone | Tick | Cools until 05:00 (capped at 24 h). An unparseable reset falls back to the backoff |
| AT-15 | G1 off | The same input as AT-13 | Today's behaviour, unchanged (regression check) |
| AT-16 | G2 `max: 3`. One task: crashed, hung, crashed across two chains. Another task whose 3 failures happened during a fleet outage | Ticks | The first task is held `no_result_cap` with one decision and its claim released. The second isn't parked. `start_again` resets the count. Answering twice is refused (decision already answered) |
| AT-17 | G3 on. WAITING line with `(?<pr>42)`. No fallback timer due | `review.submitted` for PR 41, then for 42 | Nothing for 41. For 42, the task starts once. A restart between the event and the tick still starts it once (state check). After `max_wait_minutes` with no event, one decision |
| AT-18 | G3 on. WAITING naming nothing | Ticks | Fallback after `fallback_seconds`, doubling after each idle completion. Held after `max_completions_without_done` (today's rule) |
| AT-19 | G4 `max_per_task: 2`, `first: fresh` | The task hangs, restarts in a fresh session, hangs again | First restart `sessionMode: fresh` with the hung block. After the second hang, held `hung_repeat` with one decision and no resume run created |
| AT-20 | G5: `daily_requests: { soft: 50, hard: 60 }` | Runs add 55, then 61 requests | One notice-tier item at 55. At 61 the existing `spend` decision fires and new runs wait. The running ones continue |
| AT-21 | spend off | Every action above | No `agents_spend` rows, no events, no panel, and the route returns 404 with `agents.spend.enabled is off` |
| AT-22 | v1, v2 and v3 `agents.db` files from fixtures | Open with the new store | Migrates to v4. Existing runs, events and usage are kept, and `agents_spend` exists |
| AT-23 | Config with a bad `request_pattern`, `waste_share: 2`, or `max_backoff_minutes < backoff_minutes` | Load | Refused, naming each key. The previous config stays live |
| AT-24 | G6 `prefilter_closed` on. A backlog task whose id is a done id. A plan task naming PR #42, which `review.db` records as merged | A planner trigger | The context holds neither task, and `closed` lists both. A returned `add` naming #42 is refused with its reason, and no verifier run is requested for it |
| AT-25 | G6 `handled_messages` on. Owner message M | A proposal with `from_message: M` is applied and its task's DONE line arrives. Then a proposal with `from_message` set to an id not in the context. Then the owner reopens M; then a request without an owner session | M is handled, absent from the next context, and raises no `owner_message` trigger. The unknown id is refused. Reopening puts M back. The request without an owner session gets **401/403** |
| AT-26 | G6 `skip_unchanged` on. Run R1 with context hash H ended with only refused proposals | A trigger with the same inputs; Lair restarts; another trigger; then a new owner message; then the clock passes `max_skip_hours` | Both same-input triggers are skipped (`planner_skipped`, no agent run), the restart included. The new message starts a run. After `max_skip_hours` a run starts even with hash H |
| AT-27 | G6 off | The inputs of AT-24 to AT-26 | Today's behaviour, unchanged |

## 6. Security and privacy

- **No prompt text is stored.** `agents_spend`, the API, the daily summary and the notices hold numbers, ids (run, task, agent, provider, model, PR number, head sha), enum classes and reasons, and byte sizes. They never hold a prompt, a resume summary, a log line or model output. The usage parser keeps only the fields it reads, and the line itself is discarded.
- **Logs are untrusted input.** An agent writes its own log, so a run could print a fake `result` line. Values are parsed with `JSON.parse` on one line of at most 1 MB from the last 256 KB, kept only if finite and non-negative, and capped per run. Reported usage stays advisory for budgets, as `docs/configuration.md` already says: keep a spending limit at the provider too. Patterns are compiled once at config load and run only on bounded text.
- **Async only** in the tick and in request paths: no synchronous fs or child process. Rollups are SQL over indexed columns, bounded by window and `LIMIT`.
- **Owner-only routes.** There are no mutating spend routes. The guards' decisions are answered through the Decision Inbox's existing owner-only routes, and `spend` answers still need `confirm: true`.
- **Notices carry only titles and numbers**, so the notifier's rule ("never a decision's context, a log line or a secret") holds.
- **Retention** is bounded (`retention_days`). Deleting `agents_spend` rows never changes `agents_usage`, which stays the budget ledger.

## 7. PR plan

Each PR is separate, behind its off-by-default switch, with tests and docs (`docs/configuration.md`).

1. **Measure.** Store v4 with `agents_spend` and a migration test that opens real v1, v2 and v3 files. `usage_parser`, `request_pattern` and `estimate` on adapters, with built-in defaults. The run-end parser and its idempotent write. `origin` on `requestRun`, set by the review assigner, the planner, the verifier and the supervisor. `spend.recordCall`. Backfill. ATs 1-7, 21-23.
2. **Classify and API.** Classes, reasons, reload and restart flags, the per-task, per-head and planner rollups, `GET /api/agents/spend` and `.../runs`, the daily summary event, and the notices. ATs 8-12.
3. **Dashboard.** The Home AI spend panel and the AgentDetail spend line.
4. **G1 fleet quota cooldown** (#185's reset-time part). ATs 13-15. Docs: the `Failover.` bullet.
5. **G2 per-task no-result cap and G4 hung-repeat rule.** Two fill holds and their decisions. ATs 16, 19.
6. **G3 event wake.** ATs 17-18. Docs: Fill → wake.
7. **G5 budget metrics and soft notice.** ATs 20, 6. Docs: `Budgets.`.

8. **G6 planner guards:** filter closed work, handled owner messages, and skipping unchanged runs. ATs 24-27. Docs: the planner section of `docs/configuration.md`, and [planner.md](planner.md).

PRs 4 to 7 depend only on PR 1, so they can be built in parallel after it. PR 8 depends on nothing here and can start at once. Once PR 4 merges, #185 can close for its reset-time part.

## 8. Open questions for the owner

- **Q1.** Should a run that reports BLOCKED count as productive (it ends retries and hands the owner what it learned) or as idle? The proposal is productive, with reason `blocked`.
- **Q2.** Should runs during a fleet outage or fleet quota cooldown be left out of G2's cap, as proposed?
- **Q3.** For adapters that report no tokens, should the panel show requests and minutes only (proposed), or should the owner set per-request estimates from a provider's price?
- **Q4.** Is 90-day retention right?
- **Q5.** Should the built-in `claude-code` adapter switch to `--output-format stream-json --verbose` by default? That changes its log from text to JSON lines, and its `status_pattern` must be checked against it. A custom adapter can opt in regardless.
- **Q6.** Are these the right recommended thresholds: waste notice at 50 % with at least 20 runs a day, task notice at 6 attempts without a completion, G2 at 6, G4 at 2?
- **Q7.** 9 planner runs had all their proposals refused because "the tasks file changed while this planner run was active". That refusal protects the file's integrity. Should the planner instead start only once the tasks file has been quiet for a while, and wait while fill is writing it? Or should Lair re-check each proposal against the new file rather than refuse the whole run? This spec leaves the rule as it is.
