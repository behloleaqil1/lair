# Provider limits: quotas, outages, fallback order and switch-back

- **Status:** design (spec only; nothing here is built). Refs issue #185 (usage limit detector, D26).
- **Base:** main `0debc32` (every file:line below was checked there).
- **Related:** [ai-spend.md §4.5 G1](ai-spend.md#45-guards-off-observe-act) (the fleet quota cooldown, built), [ai-roles.md](ai-roles.md) (profiles and roles, failover along a role), [autonomy.md §6](autonomy.md#6-agents-budgets-failover-and-session-recovery-module-agents) (the agents module), [configuration.md, Agents](../configuration.md#agents).

Lair starts every AI run through an agent CLI. When the account behind that CLI runs out of quota, or the provider is down, every run fails in seconds. Lair already handles part of this: rate-limit and provider-error lines fail over to the next profile, transient network errors are waited out, and G1 cools a provider for the whole fleet on a quota line. This spec closes the gaps that one real monthly cap exposed:

1. **Structured errors.** Classify a provider error by the structured fields the CLI prints (`errorType`, `reason`, `rateLimitType`, ...), not only by English wording.
2. **Quota periods.** Tell a burst limit from a daily, weekly or monthly cap, and wait until the reset instead of probing every few hours for weeks.
3. **Burst of dead-on-start runs.** When runs of several agents on one provider die within seconds of starting, inside a few minutes, treat that as a provider outage, even when no pattern matches.
4. **Fallback order per role.** When the fallback has limited room, the roles that produce work get it first.
5. **Switch-back.** Probe the primary while the fleet runs on a fallback, and move back to it once it works.

Every new behaviour has a mode, `off`, `observe` or `act`, and ships in `observe`. None of them needs `agents.spend.enabled` or G1's own mode: in particular a structured quota match in `act` opens the §4.2 cooldown (period, reset, probes) on its own (§4.1, "Quota without G1").

## 1. Why: what one deployment shows

**A monthly cap that no pattern matched** (issue #185, 2026-11-02). The builder CLI hit its **monthly** request cap. Every run exited 1 within 15 to 45 seconds, and its last log line was:

```
Error: You've reached your monthly usage limit. Please return next month to continue building. (code -32000): {"errorType":"UsageLimitReachedError","retryErrorType":"CLIENT_ERROR",...}
```

- None of the default `rate_limit_patterns` (`src/server/agents/config.ts:30-37`) match this wording. The closest is `\busage limit (reached|exceeded)\b`, but the line says "reached your monthly usage limit". The default `quota.patterns` (`config.ts:74`, `DAILY_REQUEST_COUNT` and `hit your .* limit`) miss it too.
- So `matchFailover` (`src/server/agents/failover.ts:77`) returned null. The runs were recorded as `dead_on_start` (`src/server/agents/service.ts:2174-2178`) and resumed in the same session, 4 of 4 times, instead of failing over.
- The deployment fixed it by hand, adding `"errorType"\s*:\s*"UsageLimitReachedError"` and `\breached your monthly usage limit\b` to its project config. After that, failover worked.
- The structured part of the line was there all along: `errorType` names the error in a stable, machine-readable way. The same CLI's HTTP body for its daily cap carries `"reason":"DAILY_REQUEST_COUNT"` (`fixtures/agents-usage/kiro-requests-30.txt:220`), and the monthly one carries `MONTHLY_REQUEST_COUNT`.

**A daily quota retried on a fixed timer** ([ai-spend.md §1](ai-spend.md#1-why-what-one-real-deployment-shows), 48 h to 2026-11-02). There were 114 rate-limited runs, all `DAILY_REQUEST_COUNT`. For 8 hours each waiting agent retried about every 31 minutes, because `failover.cooldown_minutes` was a fixed 30. G1 (built since) replaces that with one probe per backoff step, doubling from 30 to 240 minutes. For a monthly cap, the same backoff still means one failed probe every 4 hours for up to a month, about 180 dead runs. G1 also caps any reset at 24 hours (`QUOTA_MAX_COOLDOWN_MS`, `failover.ts:127`) and forgets a cooldown after 48 hours (`QUOTA_STATE_MS`, `service.ts:248`).

**Another CLI reports its window and its reset.** A Claude Code run with `--output-format stream-json` writes a `rate_limit_event` before it stops (`fixtures/agents-usage/claude-stream-json-usage-limit.jsonl:2`). It has `rate_limit_info.status: "rejected"`, `rateLimitType: "five_hour"`, `resetsAt` as epoch seconds, and a `seven_day` window. Today Lair reads none of these fields. The reset time is in the line, but the only way to read it is a `(?<reset>...)` regex group, and that does not handle epoch seconds.

**With a fallback, the primary is never probed again** (from the code, §2). When the primary provider is in a quota cooldown or an outage, `unusable()` (`service.ts:1396-1412`) passes it over. If the agent has a fallback, every run starts on the fallback. A probe of the primary happens only for a run that has **no** usable profile (`service.ts:1496-1521`). So once every agent has a fallback, nothing ever ends the primary's cooldown:

- the quota state lasts until it ages out after 48 hours;
- a transient outage never ages out, because `outage()` (`service.ts:3250-3251`) reads the newest event with no time bound.

Until then, the whole fleet keeps running on the fallback, which is usually the dearer one.

## 2. What exists today

Found with `git grep` over `failover`, `quota`, `transient`, `outage`, `dead_on_start`, `cooldown`, `probe`, `profileIndex`, `origin`, `errorType`, `MONTHLY` and `monthly` in `src/server/agents/`, `src/server/ai/`, `src/shared/agents-types.ts`, `src/client/components/` and `docs/configuration.md` on main `99ba920`.

| What | Where | What it does | What is missing |
|---|---|---|---|
| Failover line matching | `src/server/agents/failover.ts:77-92` `matchFailover`; `config.ts:30-45` the default patterns | Matches the last 20 log lines, each cut to 500 characters, line by line from the newest: on each line, a G1 quota match (act only) first, then `rate_limit_patterns`, then `provider_error_patterns`. So a newer rate-limit line beats an older quota line. In G1 observe a quota-only line (one no rate-limit or provider-error pattern also matches) returns null (`failover.ts:85-91`) | Wording only. No structured field is read. A JSON line longer than 500 characters is cut before any field |
| G1 quota cooldown | `failover.ts:94-124` `matchQuota` (vm, 50 ms), `:126-171` `quotaResetAt`; `service.ts:255-271` `QuotaCooldown`, `:2874-2891` `quotaCooldown`, `:2899-2945` `quotaHit`, `:3013-3032` `noteQuotaBack`; `config.ts:336-344` `failover.quota` | A quota line cools its provider for every agent until its reset time, or `backoff_minutes` doubling up to `max_backoff_minutes`. Then one start probes it. A start that lives past `dead_on_start_seconds` clears it. One decision per provider and cooldown | No period: daily and monthly are the same. A reset is capped at 24 h, and the state is forgotten after 48 h. A reset comes only from a regex group, as ISO, a clock time or "in N minutes", never epoch seconds. No probe happens while every run has a fallback |
| Rate-limit cooldown | `service.ts:1376-1386` `coolingUntil`; `config.ts:327` `cooldown_minutes` (30) | Cools for the agent that hit it, and for every agent once two agents hit it within the cooldown | Fixed length. Kept for short bursts |
| Transient outage | `service.ts:219` `TRANSIENT_FLEET_WINDOW_SECONDS` (900), `:227-245` `Outage`, `:3250-3268` `outage`, `:3271` `downFor`, `:3281-3293` `probeInFlight`, `:3310` `noteReachable`, `:3376` `transientRetry`; `failover.ts:219-225` `matchTransient`; `config.ts:55-64`, `:349-356` | A dead run whose last 3 lines match `transient_patterns` costs no recovery attempt. Its provider is down for that agent, and for every agent once two agents' runs die within 15 min. One start probes it with backoff. One decision per provider | Needs a matching line. A burst of silent `dead_on_start` deaths is not an outage. The newest event has no age bound |
| Dead on start | `service.ts:2167-2178` (in `onExit`), `:2304-2350` `recover`; `config.ts:271` `dead_on_start_seconds` (60) | A run that dies within 60 s, or with an empty log, is recovered: a same-session resume, then a fresh session, then escalation | Recovered per run. Nothing looks across agents |
| Profile choice at launch | `service.ts:1439-1557` `launch`; `failover.ts:238-254` `chooseProfile` | Starts from the run's `profileIndex`, wraps once, and takes the first usable profile. It records a `failover` event of kind `unavailable` when it moves | No role priority, and no cap on how many runs may move to a fallback. A provider that is cooling down or in an outage is never chosen as a probe while a fallback is usable |
| Profile index across a chain | `service.ts:3879` (a new run starts at `profileIndex: 0`), `:1963` (`followUp` keeps `prev.profileIndex`), `:1550-1554` (another CLI cannot resume: new session) | A new chain tries the primary first. A restart in the same chain stays on the fallback | No switch-back inside a chain |
| Failover on a quota | `service.ts:2776-2870` `failover` | Moves the task on. A quota failover counts no failover, and with no profile left it waits for the probe | Kept as it is |
| Roles | `src/server/ai/profiles.ts:21` `ROLE_PATHS`, `:140` `agentRole`, `:196-201` `roleFallbacks`; `src/shared/agents-types.ts:57` `RunOrigin`; `src/server/agents/spend.ts` `originOf` | A run's role is known from its origin: `fill`, `review`, `planner`, `verifier`, `supervisor` or `owner`, else its task prefix. Fallbacks follow the role's order | Nothing ranks roles against each other |
| Fleet budget provider pause | `src/server/fleet/budget.ts:186` `isProviderAvailable` | A provider the fleet budget paused is passed over | Cost caps only. No slot limit |
| Status and UI | `src/shared/agents-types.ts` `AgentsStatusView.unreachable`; `src/client/components/Work.tsx:181-183` (the unreachable card), `Home.tsx:277` | Shows providers that are unreachable after transient errors | A quota cooldown, its period and its reset are shown only in a run's detail text and the decision |
| Decisions | `service.ts:3036-3065` (the quota decision, key `quota:<provider>:<since>`), `:3206` `raiseExhausted` | One quota decision per provider and cooldown: "Keep waiting" or "Try now" | No period or reset date in the text when the line gave none |
| Docs | `docs/configuration.md:1691` (the `Failover.` bullet), `:364` (role failover) | Describe the above | Nothing on structured errors, periods, bursts, priority or switch-back |

**Searched and not found** on main (these are the NEW items): `errorType` and `MONTHLY` in `src/server/agents/` outside tests (the only non-test hit is the transient default pattern string `config.ts:56`; `acceptance.test.ts:1882, 6932, 7229` hold real `ClientNetworkError` lines); any period field on the quota state; any count of `dead_on_start` across agents; any role rank or fallback slot limit (`max_active` exists only for fill and heavy work, `config.ts:188`); any probe of a passed-over provider while a fallback is usable.

## 3. Gaps

1. A provider error is classified by wording only. A new phrasing (the monthly cap) passes unmatched and is recovered as a crash.
2. A quota has no period. A monthly cap is probed every 4 hours. A reset more than 24 hours away is cut to 24 hours, and the state is forgotten after 48 hours.
3. An epoch-seconds reset, or a reset in a JSON field, can't be read.
4. A burst of `dead_on_start` runs across agents on one provider is recovered run by run. That means N resumes and N escalations instead of one outage and one decision.
5. When a fallback has little room (a smaller quota, or a dearer per-request price), every role moves to it equally, in launch order.
6. While every run has a usable fallback, the primary's cooldown or outage is never probed, so the fleet never returns to it on its own. A chain that moved to a fallback stays there through its restarts.

## 4. Design

The changes live in the agents module: `failover.ts` for the pure parts, `service.ts` for the state. They add five keys under `agents.failover`. Each new behaviour has its own mode. In `observe` it reaches the verdict it would act on, records one `guard_would` event per subject and streak, and raises one `attention: "notice"` inbox item. It changes no run, claim, cooldown, outage or decision. In `act`, the first action per subject and streak records one `guard_did`. Both use the G1-G6 convention (`service.ts:2601-2651`, `:2928-2941`): `data.guard` is `structured`, `burst`, `fallback` or `switch_back` (added to `SPEND_GUARDS`, `src/shared/agents-types.ts:153`), `data.verdict` names the verdict, and the dedupe key is `guard_would:<guard>:<subject>:<since>` (or `guard_did:...`). No new event kind is added.

These modes don't need `agents.spend.enabled`: they read run records, events and log tails only. Their events are written with the service's own `record`, as G1's are, never through `recordModuleGuard` (`service.ts:3750`), which writes nothing while spend is off.

### 4.1 Structured provider errors (`failover.structured`)

**Extracting the fields.** A fixed extractor, `structuredFields(line)` in `failover.ts`, reads the lines the existing checks read, uncut: for a dead run, the last 20 lines of its 64 KB tail (`service.ts:2157-2165`); for a silent run, the last line of its 8 KB tail (`:2028`). It uses the raw line, not the 500-character cut. It never runs a user regex. It does two things:

1. **Parse the JSON.** It takes the substring from the line's first `{` to its last `}` and runs `JSON.parse` on it, which is linear and bounded by the 64 KB cut. On success it keeps the scalar values at every dotted path, up to depth 4 and at most 200 values. For example, `errorType`, `rate_limit_info.status` and `rate_limit_info.resetsAt`.
2. **Fall back on flat pairs.** If parsing fails (a truncated line), one built-in regex collects the flat pairs: `"([A-Za-z_][A-Za-z0-9_]{0,40})"\s*:\s*("([^"\\]{0,200})"|-?\d{1,16})`. It is linear (no nested quantifiers), at most 200 pairs.

A `__type` value such as `com.example#ThrottlingException` is also kept as its part after the last `#`.

**Rules.** `failover.structured.rules` is an ordered list. Each rule is `{ path, equals | ends_with, class, period?, reset_path? }`:

- `class` is one of `quota`, `rate_limit`, `provider_error`, `transient`.
- `period` is one of `window`, `daily`, `weekly`, `monthly`, or `from:<path>` (read the period from a field, §4.2).
- `reset_path` names a field holding the reset: epoch seconds or milliseconds (by magnitude: a value below 10^11 is seconds), or an ISO time.

**Order.** Lines are read newest first, as `matchFailover` does. On one line, every rule is tried, and the class is chosen by rank, not by list order: `quota` beats `provider_error`, which beats `rate_limit`, which beats `transient`. Among rules of the same class, the first in the list gives the period and the reset. A line can carry two matching fields: the real Kiro daily-cap body (`fixtures/agents-usage/kiro-requests-30.txt:220`) has both `__type: ...#ThrottlingException` (`rate_limit`) and `reason: DAILY_REQUEST_COUNT` (`quota`), and it is a `quota` whatever order a user writes the rules in (AT-4b). A user's `structured.rules` replaces the defaults, as `rate_limit_patterns` does today.

The defaults are generic and documented, each from a CLI's real output (§1):

| path | value | class | period / reset |
|---|---|---|---|
| `errorType` | `UsageLimitReachedError` | `quota` | period from the line's words (§4.2) |
| `reason` | `DAILY_REQUEST_COUNT` | `quota` | `daily` |
| `reason` | `MONTHLY_REQUEST_COUNT` | `quota` | `monthly` |
| `rate_limit_info.status` | `rejected` | `quota` | `from:rate_limit_info.rateLimitType`, `reset_path: rate_limit_info.resetsAt` |
| `__type` | ends with `ThrottlingException` | `rate_limit` | (none) |
| `retryErrorType` | `TRANSIENT` | `transient` | (none) |
| `errorType` | `ClientNetworkError` | `transient` | (none) |

**Where it runs.** It runs in `onExit` (`service.ts:2157-2165`), before the transient and failover checks, and in `failoverWhileAlive` (`:2023-2032`). A structured class beats a pattern match on the same line. For a newer line, the newer line wins.

- A `transient` class takes the transient path (`transientRetry`), within `transient_max_retries`, exactly as a `transient_patterns` match does today. It is read from the same window as the patterns: only the last `TRANSIENT_TAIL_LINES` (3, `failover.ts:209`) lines. A transient field on an older line gives no class, so the run goes on to the failover and dead-on-start checks as today (AT-10b). The window is not widened: a network error 10 lines before the end is followed by output that may say what really ended the run.
- A transient class is never a quota, and never opens a quota cooldown. A line that carries both a transient field and a quota field (no CLI seen does) is a `quota` by the rank above.
- `quota`, `rate_limit` and `provider_error` build the same `FailoverInfo` a pattern would build, with `source: "structured" | "pattern"`, `period` and `resetAt` added. `rate_limit` and `provider_error` are failovers as today (they count toward `max_failovers` and use the fixed `cooldown_minutes`).

**Quota without G1.** A structured `quota` class in `act` is a quota failover (`kind: "quota"`) whatever G1's mode and whatever `agents.spend.enabled`. Today a quota-only line in G1 observe or off returns null (`failover.ts:85-91`), so this is new behaviour, and it is what closes gap 2 under the shipped defaults. For such a run:

- `failover` (`service.ts:2776`) counts no failover (`failovers = quota ? done : done + 1`, `:2788`), so the run never reaches `max_failovers` or `raiseExhausted` (`:3206`) through it;
- `quotaHit` (`:2899`) records the `quota` event with `source: "structured"` and the §4.2 period and reset, so the provider cools for every agent until its reset and is then probed. It is never the fixed 30-minute `cooldown_minutes`, because `coolingUntil` (`:1376-1386`) counts only `rate_limit` and `provider_error` failovers;
- `quotaCooldown` (`:2874`), and the G2 fleet reads that use it (`quotaCooledAt` `:2604`, `fleetFailure` `:2579`), read a `quota` event when G1 is `act`, or when `structured` is `act` and the event's `source` is `structured`. So a structured cooldown is honoured with G1 off, and switching G1 off doesn't revive old pattern cooldowns;
- the `guard_did` for the new cooldown says `guard: "structured", verdict: "cool"` (with G1 act and a pattern match it stays `guard: "quota"`).

**With G1 on as well.** Both feed one cooldown per provider: one `quota` event stream, one `nextTryAt`, one decision (`quota:<provider>:<since>`). In G1 `act`, a line that matches both a quota pattern and a structured quota rule is one hit, and the structured rule's period and reset win. In G1 `observe`, a structured quota match in `act` acts, and G1 records no `would_cool` for that line (it was acted on). A structured `observe` with G1 `act` changes nothing G1 does.

**Modes.**

- `act`: the structured class is used.
- `observe`: today's path runs unchanged. Whenever the structured class differs from what the patterns gave (the #185 case: no pattern matched, the class is `quota`), Lair records `guard_would` (`guard: "structured"`, `verdict: "would_classify"`, the class, the rule's index, the path and the value; never the whole line) and one notice per provider and class.
- `off`: no extraction.

**Checks at load.** Each `path` is at most 100 characters of `[A-Za-z0-9_.]`, and each value at most 200 characters. There are at most 50 rules. A `period: from:<path>` and a `reset_path` follow the same path rule. An invalid rule is a config error naming `agents.failover.structured.rules[<i>]`.

### 4.2 Quota periods and the reset (extends G1)

The `QuotaCooldown` state (`service.ts:255`) and its `quota` event data gain three fields:

- `period`: `window` | `daily` | `weekly` | `monthly` | `unknown`;
- `resetAt`: epoch ms, or null;
- `resetFrom`: `line` | `period` | `none`.

**The period** comes from, in order:

1. the structured rule's `period`;
2. a `from:<path>` value, mapped by `failover.quota.period_values`. The defaults are `five_hour → window`, `seven_day → weekly`, `daily → daily`, `monthly → monthly`;
3. fixed, bounded word tests in `failover.ts` on the 500-character line: `\b(monthly|this month|next month)\b|MONTHLY_` gives `monthly`; `\b(daily|today|per day|tomorrow)\b|DAILY_` gives `daily`; `\b(weekly|this week|next week)\b|WEEKLY_` gives `weekly`;
4. otherwise `unknown`.

**The reset** comes from, in order:

1. the line: a structured `reset_path`, or today's `(?<reset>...)` group read by `quotaResetAt`;
2. the period's next boundary in `failover.quota.reset_zone` (default `UTC`, any IANA zone or offset). For `daily` that is the next 00:00. For `monthly` it is the first day of the next month at 00:00. `window`, `weekly` and `unknown` have no boundary without a line reset;
3. otherwise none.

Each period has its own cap, replacing the flat 24 h: `window` 24 h, `daily` 26 h, `weekly` 8 days, `monthly` 32 days, `unknown` 24 h (as today). `QUOTA_STATE_MS` becomes the largest cap plus 48 h (34 days), so a long cooldown isn't forgotten. The event read stays `limit: 1`.

**Probing toward the reset.** This replaces "every backoff step" for a known reset:

- **Reset known** (`resetAt` set): the first probe is at `resetAt + quota.reset_grace_minutes` (5). Until then, if the reset is more than `max_backoff_minutes` away, one probe runs every `quota.long_probe_hours` (24; 0 means none before the reset). This catches an owner who raised the cap. A probe that hits the quota **after** the reset means the period or the zone was misread. From then on, the cooldown uses today's doubling backoff from `backoff_minutes`, up to `max_backoff_minutes`, with `resetFrom: none`.
- **Reset unknown:** today's doubling backoff. For `monthly` it is capped at `quota.monthly_max_backoff_minutes` (1440, one probe a day) instead of `max_backoff_minutes` (240).

**Showing it** (#185's UI part). `AgentsStatusView` gains `quotas?: ProviderQuotaView[]`, with the provider, period, since, hits, resetAt, resetFrom and nextProbeAt. Work shows it next to the unreachable card (`Work.tsx:181`), for example: "provider P: monthly cap since 2 Nov 15:00Z; resets 1 Dec 00:00 UTC (from the period); next probe 3 Nov 15:00Z". The quota decision text (`service.ts:3036-3065`) names the period and the reset date. Its options stay "Keep waiting" and "Try now".

§4.2 applies to every quota cooldown, whichever path opened it: G1 `act` with a pattern, or `structured` `act` with a rule (§4.1, "Quota without G1"). In G1 observe, `would_cool` carries the period, the reset and its source.

### 4.3 A burst of dead-on-start runs is an outage (`failover.burst`)

**The rule.** It is checked in `recover` (`service.ts:2302`), when a run ends `dead_on_start` and no structured class, quota, failover or transient pattern matched it. It sits after `runEnded` and the `dead_on_start` event (`:2310-2329`), so the run keeps `endKind: dead_on_start` and the burst count of a later run (or a restart, AT-13) sees it, and before `guardFailed` (G2 park, G4, `:2331`). A burst on provider P is:

- runs of at least `burst.min_agents` (3) distinct agents, each ending `dead_on_start` on P,
- within `burst.window_minutes` (10) of each other,
- with no start on P in that window that lived past `dead_on_start_seconds` or exited 0.

The count is read from run records (`endKind`, `profile.provider`, `endedAt`). It doesn't depend on wording.

**In act**, the run that completes the burst is not recovered. Lair records a `transient` event for P with `fleet: true`, `cause: "dead_on_start_burst"`, the agents, and the most common last line (cut to 500 characters). The existing outage machinery then applies unchanged:

- starts on P wait;
- a fallback on another provider is used;
- one start probes P with backoff (60 s doubling to 15 min);
- one decision is raised per provider and outage;
- `noteReachable` clears it.

While that outage is open, a further `dead_on_start` on P is a transient retry (no recovery attempt, within `transient_max_retries`). The runs that formed the burst have already used their own recovery. They are not refunded, so a restart or a re-read can't apply anything twice.

**G2 and G4.** In act, the run that completes the burst returns before `guardFailed`, so G2 can't park its task for it. The outage event is recorded at that run's end, so `fleetFailure` (`service.ts:2579`) reads it as ended in a fleet outage, and so is every later death on P while the outage is open: none of them counts toward G2's no-result cap. The earlier runs of the burst (A and B in AT-10) ended before anything knew of a burst. They count as today. G4 counts hangs only, so a burst doesn't touch it. In observe, `guardFailed` runs as today.

**The decision says what it may be:** "N agents' runs on P died within seconds of starting, in M minutes. The provider may be down, or the start command may be broken." This is because a broken adapter or a revoked sign-in looks the same. The rule's job is one decision and one probe instead of N escalations.

**In observe**, recovery runs as today, plus one `guard_would` (`guard: "burst"`, `verdict: "would_hold"`, the provider, the run ids) per provider and burst. The streak ends when a start on P works.

`outage()` (`service.ts:3250`) also gains an age bound: an outage whose newest event is older than `transient_max_minutes` × 4 (default 8 h) with no failure since is over. This is a pure read, and the next failure opens a new one.

### 4.4 Fallback order per role (`failover.fallback`)

**A run's role:** its origin via `originOf`. `fill` and `owner` are `build`, `review` is `review`, `planner` and `verifier` are `plan`, and `supervisor` is `supervise`. When the origin is `other`, `agentRole(config, agent)` decides.

**Priority.** `failover.fallback.priority` defaults to `[build, review, supervise, plan]`, work-producing roles first:

- builders produce the changes;
- reviews turn them into merges;
- the supervisor reports;
- the planner adds more tasks, which can wait while capacity is short.

The list must name each of the four roles once.

**Limits per provider.** `failover.fallback.limits.<provider>` takes:

- `max_active`: at most this many runs may run at once on the provider **as a fallback**, meaning on a profile that is not their chain's first. A run on its own primary never counts;
- `roles`: the roles that may fall back to it. Default: all.

A provider with no entry is unlimited, as today.

**At launch** (`service.ts:1484`), `chooseProfile`'s `usable` callback (which calls `unusable`, `:1396`) also refuses a fallback profile on P when:

- P's fallback slots are full;
- the run's role is not in `roles`;
- a queued run of a higher-priority role in this project wants a fallback slot on P in this tick.

The tick sorts queued runs by role rank, then by queued time, before `advance` (`service.ts:1350`). That makes the third check a pure read of the tick's order. A refused run waits; it is not exhausted:

- it waits on its primary's own reason: a quota cooldown or an outage (its `nextTryAt` and probe, §4.5), a rate-limit cooldown (`coolingUntil`), or a budget pause. `run.notBefore` is the earliest of those, else the next tick;
- its detail names the refusal and what it waits on: "fallback Q full (1/1); build runs first; waiting on P: rate-limit cooldown until 15:30Z";
- it counts no failover;
- it never takes the `raiseExhausted` path (`service.ts:1522-1530`, `:3206`). Today, a run with no chosen profile and no outage or quota to wait on raises a decision per run; when the only reason a profile was passed over is a §4.4 refusal, the run is requeued with the detail above instead. The existing one-decision-per-provider rule holds. No per-task decision is raised for a wait caused by priority.

Running runs are never stopped to free a slot.

**In observe**, there is no refusal. Each refusal act would make records one `guard_would` (`guard: "fallback"`, `verdict: "would_wait"`, the provider, the role and the slot count) per provider and role per hour.

### 4.5 Switch-back (`failover.switch_back`)

**Probe the primary while a fallback is usable.** When provider P is in a quota cooldown or a fleet outage, its `nextTryAt` is due, no probe is in flight (`probeInFlight`), and P's profile passes `usable(p, false)` (the same test the existing no-profile probe uses, `service.ts:1500-1502`: adapter defined, not in a rate-limit cooldown, not paused by the fleet budget, not signed out), the launcher picks **one** queued run whose profile list has P **before** the profile it would otherwise choose. It starts that run on P as the probe, instead of on the fallback.

- **Which run probes:** the lowest-priority role first (§4.4), then the newest session (a `new` session first, so no resume context is risked), then the oldest queued. Lair never starts a synthetic run for a probe. If no queued run wants P, the next one that does probes it.
- **Probe outcomes:**
  - a probe that works clears the cooldown or outage, through the existing `noteQuotaBack` and `noteReachable`;
  - a probe that hits the quota again doubles the wait (G1), and the run moves to its fallback **without** counting a failover (as G1's quota failover does today);
  - a probe that dies of a transient error is a transient retry.
  - none of these reaches `raiseExhausted`: a probe that fails moves to its fallback as a failover that counts nothing, or waits as above.

**Move chains back.** Once P is usable again, a chain that runs on a fallback returns to its first usable profile at its next **follow-up that starts a new or fresh session** (`followUp`, `service.ts:1950-1970`: `profileIndex` becomes 0, and `chooseProfile` checks from there). Three limits apply:

- a running run is never stopped to switch back;
- a planned same-session resume stays on the fallback, because another CLI can't resume the session (`service.ts:1550`);
- new chains already start at index 0 (`service.ts:3879`).

Each switch records a `failover` event of kind `switch_back` (from, to). It counts no failover.

**Guard against flapping.** A provider that cleared and then hit a quota, or a burst, again within `switch_back.hold_minutes` (30) doubles that hold for its next clear, up to 4 h. Chains don't move back until the hold has passed.

**In observe**, the probe is not redirected and chains stay where they are. Lair records `guard_would` (`guard: "switch_back"`, `verdict: "would_probe"` or `"would_switch_back"`) once per provider and cooldown, which shows how long the fleet stayed on the fallback.

### 4.6 Configuration

```yaml
agents:
  failover:
    structured:                  # §4.1
      mode: observe              # off | observe | act
      rules: [ ...the defaults in §4.1... ]
    quota:                       # G1, built; new keys marked
      mode: off                  # unchanged: G1's *patterns* (needs agents.spend.enabled for observe/act);
                                 # a structured quota in act cools without it (§4.1)
      reset_zone: UTC            # new: the zone for a daily or monthly boundary
      reset_grace_minutes: 5     # new: integer 0..168
      long_probe_hours: 24       # new: integer 0..720; probes before a far reset; 0 = none
      monthly_max_backoff_minutes: 1440   # new
      period_values: { five_hour: window, seven_day: weekly, daily: daily, monthly: monthly }  # new
    burst:                       # §4.3
      mode: observe
      min_agents: 3              # 2..50
      window_minutes: 10         # 1..120
    fallback:                    # §4.4
      mode: observe
      priority: [build, review, supervise, plan]
      limits: {}                 # <provider>: { max_active: 1..100, roles: [build, review, ...] }
    switch_back:                 # §4.5
      mode: observe
      hold_minutes: 30           # 5..240
```

**Load checks** (each error names its key):

- `reset_zone` must be a zone `Intl` accepts or an offset;
- `reset_grace_minutes` is an integer in 0..168 and `long_probe_hours` an integer in 0..720 (a negative or fractional value is refused);
- `monthly_max_backoff_minutes` is at least `max_backoff_minutes`;
- `priority` names each of the four roles once;
- `limits` keys match the provider name rule (`config.ts:21`), and `roles` entries are roles;
- `structured.rules` follow §4.1's checks.

With every new mode in `observe` and no `limits`, behaviour is today's, apart from the `guard_would` events and notices.

**Docs:** `docs/configuration.md` gets a "Provider limits" paragraph after the `Failover.` bullet (`:1691`), the keys in the options table, and the rollout advice. Run in observe for a week. Move `structured` to act first, because it only adds matches; with it alone (G1 off, spend off) a quota cap already cools its provider until the reset (§4.1). Then `burst`. Then `switch_back` and `fallback` once the evidence shows their verdicts were right.

## 5. Acceptance tests

Each test drives `AgentsService.tick()` through the existing acceptance harness (`src/server/agents/acceptance.test.ts`), with a fake spawner and clock as the one faked boundary. It uses real log lines copied from the fixtures (`fixtures/agents-usage/`, plus a new sanitized `kiro-monthly-limit.txt` holding the #185 line). Every AT fails on main, except where it says regression.

| AT | Given | When | Then |
|---|---|---|---|
| AT-1 | `structured: act`, G1 `act`. Default patterns (none match). Three agents on P, each with a fallback on Q. A run exits 1 after 20 s on the #185 monthly line | Tick | A `failover` event of kind `quota` (`source: structured`, `period: monthly`), not `dead_on_start`. No resume. Its chain's `failovers` doesn't grow. Every agent's next start is on Q |
| AT-2 | AT-1 with `structured: observe` | Tick | Today's path: the run is recovered as `dead_on_start` (resume). One `guard_would` with `would_classify`, `quota`, path `errorType`. One notice. A second identical death adds no second event or notice |
| AT-1b | `structured: act`, G1 `off`, `agents.spend.enabled: false` (the shipped G1 default). Default patterns. P with fallback Q for two agents, P only for a third. The #185 monthly line on 2 Nov 15:00Z, `long_probe_hours: 24` | Tick, then the clock runs 3 days | A `failover` of kind `quota` (`source: structured`, `period: monthly`), one `quota` event with `resetAt` 1 Dec 00:00 UTC, and one `guard_did` (`guard: structured`, `verdict: cool`). `failovers` unchanged; no `raiseExhausted` decision. The two agents start on Q. The P-only agent waits and P is probed once at +24 h, +48 h, +72 h, never every 30 min, and no `coolingUntil` cooldown is read for P |
| AT-1c | AT-1b with G1 `act` and spend on, and quota patterns that also match the #185 line | Tick | One `quota` event (not two), with the structured period and reset. One `guard_did`. One quota decision for P |
| AT-3 | `structured: act`. A line whose JSON is cut mid-object, and a 64 KB line with 300 pairs | Tick | The flat-pair fallback finds `errorType` in the first. The second reads at most 200 values and the tick finishes within the test's time bound. A line with no `{` is left to the patterns |
| AT-4 | `structured: act`. `retryErrorType: TRANSIENT` on a line no `transient_patterns` entry matches (custom patterns set to one unrelated entry) | Tick | A transient retry (no recovery attempt), as a pattern match would give |
| AT-4b | `structured: act`, G1 `off`. Rules: the defaults, then the same list with the `__type ... ThrottlingException` rule moved first | The Kiro 429 body with `ThrottlingException` and `reason: DAILY_REQUEST_COUNT` (`kiro-requests-30.txt:220`); then the same body with no `reason` | With either rule order, the first is `quota`, `period: daily`. The second is `rate_limit` (a counted failover, the fixed cooldown) |
| AT-5 | G1 `act`. A `DAILY_REQUEST_COUNT` 429 line at 15:00 UTC, `reset_zone: UTC` | Tick, then the clock to 00:04, 00:05, 00:06 | `period: daily`, `resetAt` 00:00, `resetFrom: period`. No probe before 00:05. One probe at 00:05. When it works, `quota_cleared` and the waiting runs start |
| AT-6 | G1 `act`. The #185 monthly line on 2 Nov, `long_probe_hours: 24` | The clock runs 3 days | `resetAt` 1 Dec 00:00 UTC. One probe at +24 h, +48 h, +72 h, and no others. The state is still read on day 3 (after the old 48 h). The status view's `quotas[0]` shows the period, reset and next probe. The decision text names "monthly" and "1 Dec" |
| AT-7 | G1 `act`. The Claude Code `rate_limit_event` fixture (`resetsAt` epoch seconds, `five_hour`) | Tick | `period: window`, `resetAt` = `resetsAt` × 1000, `resetFrom: line` |
| AT-8 | AT-5, but the probe at 00:05 hits the quota again | Tick | `resetFrom: none`. The next probe follows the doubling backoff from `backoff_minutes` |
| AT-9 | G1 `act`, a monthly line with no reset or period boundary readable (`reset_zone` valid, the line's words say "monthly") | Probes fail repeatedly | The backoff grows to 1440 min, not past it (at most one probe a day) |
| AT-10 | `burst: act`. Agents A, B, C on P each die 10 s after start with a line no pattern matches, within 4 min. Fallback Q exists for A only | Ticks | A's and B's runs are recovered as today. C's death opens one fleet `transient` outage on P (`cause: dead_on_start_burst`), with no resume for C. A's next start is on Q. B and C wait for one probe. One decision for P. A probe that lives past 60 s clears it |
| AT-10b | `structured: act`. A run prints `{"errorType":"ClientNetworkError","retryErrorType":"TRANSIENT"}` (the real line, `acceptance.test.ts:1882`), then 10 more lines, then exits 1 after 20 s | Tick | No transient retry (the line is outside the last 3) and no `quota`: recovered as `dead_on_start`, as today. The same line as the last line is a transient retry |
| AT-10c | `structured: act`, `burst: act`, G1 `act`. A network outage: runs of agents on P and on Q (two providers) each die within seconds with `getaddrinfo ENOTFOUND` lines and `ClientNetworkError` as the last line, within 5 min | Ticks | One fleet `transient` outage on P and one on Q; zero `quota` events; no chain's `failovers` grows. Each provider is probed with the transient backoff (60 s, 120 s, ...), not the quota backoff. A run that falls to Q dies there too and waits; it doesn't move back to P (no ping-pong) |
| AT-11 | AT-10 with two agents only, or with one start on P that lived 2 min inside the window, or with the deaths 11 min apart | Ticks | No burst. Each run is recovered as today (negative cases) |
| AT-12 | AT-10 with `burst: observe` | Ticks | Every run is recovered as today. One `guard_would` (`would_hold`) for P, and no outage event |
| AT-13 | AT-10 in act, then a Lair restart while the outage is open. G2 `act`, and C's task already has its cap minus one no-result ends in the window | Restart, tick | The outage is read back from events. No second outage event and no second decision. C's run isn't recovered twice. C's run still has `endKind: dead_on_start`. G2 doesn't park C's task (the burst run returned before `guardFailed`, and `fleetFailure` reads it as a fleet outage) |
| AT-14 | `fallback: act`, `limits: { Q: { max_active: 1 } }`. P is in a quota cooldown. A planner run and a builder run are queued on P with fallback Q, the planner queued first | Tick | The builder starts on Q. The planner waits, with detail "fallback Q full (1/1)", with no failover counted and no per-task decision |
| AT-14b | AT-14, but P is in a *rate-limit* cooldown (two agents' `rate_limit` failovers, `coolingUntil`), not a quota cooldown or outage | Tick | The planner is requeued with "fallback Q full (1/1); build runs first; waiting on P: rate-limit cooldown until <time>" and `notBefore` at that time. No `raiseExhausted` decision. A probe is never started on P while it is cooling (`usable(p, false)` refuses it) |
| AT-15 | `fallback: act`, `limits: { Q: { roles: [build] } }` | A review run's primary P is cooling | The review waits for P's probe and doesn't start on Q. A builder starts on Q |
| AT-16 | AT-14 with `fallback: observe` | Tick | Both start on Q, as today. One `guard_would` (`would_wait`, role `plan`) |
| AT-17 | `switch_back: act`. P in a quota cooldown, every agent with fallback Q, `nextTryAt` due. Two queued runs (build, plan) | Tick | Exactly one run, the plan run, starts on P as the probe. The build run starts on Q. If the probe lives past `dead_on_start_seconds`, `quota_cleared` follows. If it hits the quota again, it moves to Q with `failovers` unchanged, and the next probe is a step later |
| AT-18 | After AT-17 clears P. A chain on Q crashes (its follow-up is a fresh session), another chain on Q is running, and a third has a planned same-session resume | Ticks | The fresh follow-up starts on P with a `switch_back` event. The running run is untouched. The resume stays on Q |
| AT-19 | `switch_back: act`. P clears, then hits a quota again 10 min later, then clears | Ticks | No chain moves back until the doubled hold (60 min) has passed |
| AT-20 | `switch_back: observe`, the AT-17 input | Tick | Both runs start on Q, as today. One `guard_would` (`would_probe`) per provider and cooldown |
| AT-21 | Every new mode `off` | The inputs of AT-1, 10, 14 and 17 | Today's behaviour, unchanged, and no `guard_would` events from the new guards (regression) |
| AT-22 | Config: a rule with path `a..b` or a 300-character value, 51 rules, `priority` missing `plan`, `reset_zone: Mars/Base`, `monthly_max_backoff_minutes: 60` | Load | Each is refused, naming its key |
| AT-23 | A transient outage event 9 h old with no failure since | Tick | `outage()` is null. A start on P goes ahead |

## 6. Security and privacy

- **No shell, no user regex in the new paths.** `structuredFields` uses `JSON.parse` on a substring of at most 64 KB and one fixed linear regex. Rules compare by equality or suffix. The word tests in §4.2 are fixed code. The existing user patterns stay in their vm with a timeout.
- **What is stored.** The `guard_would`, `guard_did` and `quota` events store the rule index, the path and the matched value (at most 200 characters), the period and the times. They never store the whole JSON object: CLI error bodies can carry request ids or account hints. The existing 500-character `line` in a quota event is kept as today.
- **No new routes.** The status view's `quotas` comes through the existing `GET /api/agents/status`, with the same access. "Try now" stays the existing owner-only decision action.
- **Fail closed.** A rule that doesn't load stops the project config from loading. A field that fails to parse is no match, and today's patterns decide. A reset that can't be read falls back to the backoff, never to "no cooldown".
- **Idempotent.** Every state change is an event read back by its newest entry (`limit: 1`). A restart re-reads the same state, and the burst rule counts runs that have already ended, so it can't open a second outage for the same burst (AT-13). Each probe start is guarded by `probeInFlight`.
- **Nothing runs on its own.** No synthetic run is started. A probe is always a run that was already queued for that work.

## 7. Build PRs, in order

Each PR builds, is wired behind its mode (default `observe`), and merges on its own. Each one is under about 600 non-test lines.

1. **Structured errors** (§4.1): `structuredFields`, the rules and their checks, use in `onExit` and `failoverWhileAlive`, `source` on `FailoverInfo`, observe events. The fixture `kiro-monthly-limit.txt`. The structured `quota` path with G1 off (the `quotaCooldown` read by `source`). ATs 1-4 (with 1c, 4b, and AT-1b's cooldown, failover-count and no-decision part), 10b, AT-21 (its part), AT-22 (its part). Docs: the `Failover.` bullet.
2. **Quota periods and reset** (§4.2): period and reset on the quota state, the per-period caps and state window, the probe schedule, `quotas` in the status view, Work's card, and the decision text. ATs 5-9, AT-1b's probe-schedule part, AT-22 (its part). Until this PR merges, a structured quota cooldown uses G1's doubling backoff (30 to 240 min) and its 24 h cap: fewer probes than today's 30-min retries, and never a counted failover.
3. **Dead-on-start burst** (§4.3): the burst rule in `recover`, the outage cause, and the outage age bound. ATs 10-13 (with 10c), 23.
4. **Switch-back** (§4.5): the primary probe at launch, `switch_back` in `followUp`, and the hold. ATs 17-20.
5. **Fallback priority and limits** (§4.4): the role of a run, the tick's order, the slot and role checks, and the wait detail. ATs 14-16 (with 14b), AT-21 (its part).

PR 4 comes before PR 5 because it ends the "fleet stuck on the fallback" cost in §1. PR 5's probe-run choice (lowest role first) reads PR 5's priority list. Until PR 5 merges, PR 4 uses the default order as a constant.

## 8. Risks

- **A wrong structured rule fails over good runs.** The rules match exact values in machine fields, not prose, and they ship in observe. A week of `would_classify` events shows each rule's hits before act. In act, a wrong `quota` rule cools a provider for every agent until its reset, with G1 off too (§4.1). That is bounded by the long probe (one start per `long_probe_hours`, which clears it when the run works), the one quota decision per provider whose "Try now" ends it, and `guard_did` (`guard: structured`) naming the rule's index, path and value.
- **A burst that is not the provider** (a broken start command, a revoked sign-in, a full disk). The rule holds the fleet and raises one decision that names both causes, instead of N escalations. The probe still runs with backoff, so a fix is picked up within 15 minutes.
- **A misread period or zone** delays work until the wrong boundary. The long-probe schedule (24 h) and the switch to backoff after a failed post-reset probe bound the damage. The owner's "Try now" overrides it.
- **A probe costs a run.** Each probe that fails is one short dead run, at most one per provider per step. That is far fewer than today's one per waiting agent.
- **Priority starves a low role.** The planner may wait for as long as the primary is down and the fallback is full. That is the intent. Its wait is visible in its detail, and its existing `max_runs_per_day` is unaffected.
- **Switch-back flapping** between a primary at its limit and the fallback. The hold doubles on each relapse, up to 4 h.

## 9. Open decisions

- **D1. The priority order.** The default `[build, review, supervise, plan]` reads "work-generating" as the roles whose runs produce changes and merges. If the owner means the planner (which generates tasks), the default becomes `[plan, build, review, supervise]`. The list is configurable either way.
- **D2. Before-reset probes for a monthly cap.** The default is one a day (`long_probe_hours: 24`), so a raised cap is noticed. 0 waits for the reset only.
