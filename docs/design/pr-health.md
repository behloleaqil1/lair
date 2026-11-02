# PR health

- **Status:** Draft (revised 2026-11-01 against main `d75b43a`)
- **Plan lines / issues:** #247 (PR health), #251 (ready guard: per-repo CI signal and repo-aware PR references). Section 9 maps every review finding (PH-01 to PH-27) to the section that resolves it.
- **Owner questions:** none. Two product questions are settled with these defaults:
  1. `pr_health.escalate_after_minutes` defaults to `null` (off). The inbox hears only about problems with no owner and notes that could not be delivered (section 4.5). A project can set it, for example to 240, after a week in act mode.
  2. A fleet-bus channel for notes is deferred to a follow-up. It needs an asynchronous bus mirror and delivery outside a run first (section 3). This version uses the argv command `notify_cmd`.

## 1. Problem

Open pull requests go bad without anyone noticing. A PR can conflict with its base, fall far behind it, get no CI run at its head, or go red. The agent that owns the PR does not find out, and the PR waits until a person looks. Today a shell script outside Lair polls the host and appends notes to the task list. That script has no observe mode and no record of what it sent besides a flat file. It cannot escalate, has no UI, and hard-codes repositories and branch naming.

Lair already reads PRs (the review module and the ready guard) and the agents' task lines (fill). It also has a module with the same shape as this one: the infrastructure monitor finds problems, raises a deduplicated Decision Inbox notice and withdraws it when the problem clears, and runs act-once commands through a ledger. PR health moves the script's rules into Lair on that pattern. It observes first and acts later.

## 2. Users and stories

1. As the owner, I list a project's repositories once (`repos:`), each with its base branch, whether its hosted CI counts, and the short names task lines use for it. PR health and the ready guard both read that list.
2. As the owner, I turn PR health on in observe mode, see in its status what it finds and what it would send, and only then switch to act.
3. As an agent, I get one note for each (repository, PR, head, problem). It says what is wrong and what to do, and it reaches me once even across retries and restarts.
4. As an agent, I get a withdrawal of that note when the problem is fixed, the head moves or the PR closes. I never get a withdrawal for a note I was never sent.
5. As the owner, I get a Decision Inbox notice only when no agent owns the PR, or when its note could not be delivered. The notice goes away by itself once the problem clears.
6. As the owner, a repository whose hosted CI does not work (it is disabled, or every run fails for billing reasons) produces no CI noise. Its conflicts and behind problems are still reported.
7. If the git host times out, rate-limits Lair or fails for one repository, the other repositories are still watched. Nothing about the failing one is cleared or re-sent when it recovers.
8. As the owner, I exclude PRs (`ignored_prs`) and bot branches (`ignored_branches`, `dependabot/**` by default) from PR health.

## 3. Scope

**In:**
- PR 1: a shared, project-level `repos:` list with a module `src/server/repos/` that holds the list, the PR-reference parser and one git host per repository. The ready guard reuses it (#251): per-repository `ci_counts`, repository-aware `<ref>#n` references and a per-task `repo:owner/name`.
- PR 2a and 2b: a new module `src/server/pr-health/`, observe only. 2a is the detector; 2b adds the owner rule, the route and the wiring. It reads each repository's open PRs on its own timer and finds four kinds of problem: `conflicts`, `behind`, `no_ci` and `ci_red`. It decides the owner, emits events and serves a read-only status route.
- PR 3: act mode. A note to the owning agent through `notify_cmd`, its withdrawal through `withdraw_cmd`, delivery recorded in a ledger, and Decision Inbox notices with withdrawal when there is no owner, delivery gave up, or the optional timer ran out.

**Out (non-goals):**
- PR health is not a watchdog detector. The watchdog escalates every new breach once even in observe mode (`watchdog/service.ts:357-365`), and its playbook verify step sleeps inside the engine (`watchdog/playbook-engine.ts:82-83`). Both contradict "observe writes nothing" and a non-blocking timer. The infrastructure monitor's pattern fits instead (section 4.2). `DETECTOR_IDS` and its tests stay untouched.
- Hosts other than GitHub. The `GitHost` interface allows them later.
- Fixing PRs: merging, rebasing or closing them. PR health only tells someone.
- A fleet-bus delivery channel. The bus store can take a message (`routes/bus.ts:136` `busStoreFor`, `bus/store.ts:364` `sendMessage`), but an agent sees it only while its run holds a bus token. The bus mirror also writes files with synchronous fs (`bus/mirror.ts:8`). A command channel works for every project today. The bus channel is a follow-up, and it needs an asynchronous mirror and delivery outside a run first.
- Moving `tracker.repos[]` onto the shared list. The tracker keeps its own block. The shared list aligns with it (same entry fields and rules) and falls back to it (section 4.3); a follow-up can make the tracker read it.
- Repositories with more than 100 open PRs. The list read is one page of 100, and the status shows `truncated`.

## 4. Design

### 4.1 Where it lives

| PR | Files (new unless marked) |
|---|---|
| 1 | `src/server/repos/{config,refs,hosts,checks,index}.ts`. Changed: `ready-guard/guard.ts`, `agents/fill.ts` (the guard call), `review/service.ts` (`readyFacts` uses `newestChecks`), `index.ts` (the ready-facts source), `docs/configuration.md` |
| 2a | `src/server/pr-health/{config,types,detect,service,index}.ts`: config, types, detector, cache, isolation, the status view and events. Changed: `shared/server-types.ts` (event names), `docs/configuration.md` |
| 2b | `src/server/pr-health/{owner,routes}.ts`: the owner rule and the status route. Changed: `review/host.ts` and `review/github.ts` (`HostCommit.committedAt`), `index.ts` (wiring), `reload/modules.ts` (reload) |
| 3 | `src/server/core/act-ledger.ts` (the generic ledger, moved out of `infra-monitor/ledger.ts`) and `src/server/pr-health/{act,notices}.ts`. Changed: `infra-monitor/ledger.ts` (becomes a subclass), `infra-monitor/config.ts` (`buildArgv`), `decisions/raisers.test.ts` (`RAISERS`), `docs/configuration.md` |

PR health is wired in PR 2b, like the infrastructure monitor (`index.ts:812-818` construct, load, `useDecisions`, routes; `index.ts:1258` start; `reload/modules.ts:187` reload). Construction is `new PrHealthManager({events, agents, ledgerPath})`. It is off unless a project sets `pr_health.enabled: true`.

### 4.2 What it reuses on main

| Need | On main | How it is used |
|---|---|---|
| PR data | `GitHost` (`review/host.ts:75-103`): `listOpenPullRequests` (79), `getPullRequest` (80), `listCommits` (82), `branchHead` (86), `compare` (88), `listChecks` (90), `getRepo` (78) | One `GitHubHost` per repository (`review/github.ts:147` options `repo, apiUrl, token, fetch, timeoutMs`) |
| Mergeability | Only `getPullRequest` returns it; the list maps it to `null` (`review/github.ts:137`, `review/host.ts:20`) | Read per PR (PH-01) |
| Rate limit | `GitHubHost` blocks itself after a 429 or 403 limit answer (`review/github.ts:165,179,197-201`) | One host instance per repository, kept for the process lifetime |
| Request timeout | `AbortSignal.timeout(timeoutMs ?? 30 s)` (`review/github.ts:194`) | `timeoutMs = pr_health.request_timeout_seconds × 1000`; a timeout throws and counts as a failure |
| Token | `tokenFrom(env, cmd)` (`review/github.ts:35`); the tracker's order (own source, else review's, else `GITHUB_TOKEN`; `tracker/config.ts:220-228`) | The same order without an own source: `review.token_env`/`token_cmd` when `review:` parses, else `GITHUB_TOKEN`. `review.api_url` is used (default `https://api.github.com`). |
| Check state | `listChecks` maps check-run conclusions failure, cancelled, timed_out, action_required and stale to `failure`; neutral and skipped to `skipped`; not completed to `pending`. Statuses map error and failure to `failure` (`review/github.ts:299-334`). | Newest run per `kind:name`, as `readyFacts` does (`review/service.ts:544-553`), moved to `repos/checks.ts` `newestChecks` |
| Task lines and done | Fill's last check, in memory: `AgentsManager.get(project)` (`agents/service.ts:3865`) → `fillStatus()` (3195) → `lines: FillLineView[]` (`shared/agents-types.ts:346,398`) with `state` (298). Done comes from `checkDone` (`agents/fill.ts:777`); `#` lines are comments (`parseTasksFile`, `fill.ts:679`); a line over `MAX_TASK_LINE_CHARS` = 2000 is `malformed` (`fill.ts:114,690`, view at 1587). | The owner rule reads the snapshot and no file (PH-03, PH-20) |
| Branch → agent | `review.authors.branch_pattern` compiled by `compileBranchTemplate` (`review/config.ts:359,456`) and `review.authors.branches` (`review/authors.ts:54,72`) | Branch fallback, without `mapAuthor`'s tasks-file step, which reads the file synchronously (`authors.ts:142`) |
| Per-task repo | Tracker: `repo:owner/name` in the description (`tracker/service.ts:561`), and `owner/name#N` refs (115) | The same tag and the same qualified form |
| Notices | `infra-monitor/notices.ts:16-47` (`attention: "notice"`, one "Noted" option, `source {module, ref: key}`, `key`, `class`, `evidence`); `syncNotices` (`infra-monitor/service.ts:222-275`: dedupe by `find`, skip a notice answered after the finding started, withdraw dropped and orphaned notices); `withdrawAll` (472) | The same shape and rules, class `pr_health.notice` (section 4.5) |
| Act-once | `infra-monitor/ledger.ts:42-117` (async fs, a temp file then rename, writes queued; an attempt is written before its command; `running` is read back as failed after a restart; an invalid file is never overwritten), and `requeues` (`infra-monitor/service.ts:294-359`, bounded attempts, backoff, `MAX_REQUEUES_PER_TICK`) | Generalised into `core/act-ledger.ts` (PR 3) |
| Commands | `CommandRunner` / `SpawnRunner` (`infra-monitor/probes.ts:35,71`: argv, no shell, timeout kills the process group, timeout = failure); `buildRequeueArgv` placeholder rules (`infra-monitor/config.ts:189`) | Shared `buildArgv(key, template, vars)`; `buildRequeueArgv` becomes a wrapper |
| Decisions | `DecisionProducer` `raise/withdraw/find/openOf` (`decisions/types.ts:128-142`); key ≤ 200 chars (`decisions/validate.ts:204`); every raising file is listed in `RAISERS` with its class (`decisions/raisers.test.ts:35-51`) | `pr_health.notice` added to `RAISERS`. It is not in the policy table (`decisions/structure.ts:23`), like `infra_monitor.notice`: a notice asks nothing. |
| Events | `EventType` union (`shared/server-types.ts:290-291` has the infra-monitor events) | New names listed in section 4.7 |

### 4.3 Shared repository list and PR references (PR 1)

**Config: project-level `repos:`** (new key; nothing on main uses it). The entry fields and rules match `tracker.repos[]` (`tracker/config.ts:84-87,190-199`), and `base`, `ci_counts` and `refs` are added.

```yaml
repos:
  - repo: example/app       # owner/name
    default: true            # bare "PR #12" and "#12" mean this repository
    base: main               # default: the host's default branch (getRepo, read once per host)
    ci_counts: true          # false: hosted CI is not a signal here
    refs: [app]              # short names task text uses: app#12, app PR #12
  - repo: example/lib
    ci_counts: false
    refs: [lib]
```

| Key | Type | Default | Valid |
|---|---|---|---|
| `repos` | list | see below | at most 20 entries; a repository listed twice is an error |
| `repos[].repo` | string | required | `^[A-Za-z0-9-]{1,39}/[A-Za-z0-9_.-]{1,100}$` (GitHub's limits, so a key stays ≤ 200 chars) |
| `repos[].default` | bool | `true` when there is one entry, else `false` | in `repos:` with 2 or more entries, exactly one `true` (see the fallback below) |
| `repos[].base` | string \| null | `null` (the host's default branch) | 1-255 chars, `isSafeBranchName` (`authors.ts:44`) |
| `repos[].ci_counts` | bool | `true` | |
| `repos[].refs` | string[] | `[<name part>]` when it matches the pattern, else `[]` | ≤ 8 per entry, each `^[A-Za-z][A-Za-z0-9_.-]{0,39}$`, not `pr` or `pull`, unique across entries (case-insensitive) |

**When `repos:` is absent,** Lair falls back in this order. First, if `tracker.repos[]` is set, it takes those entries' `repo` and `default`. The tracker allows 2 or more entries with no default (with a warning, `tracker/config.ts:198-199`); that list is taken as "no default", not as an error. Then `PR #n` and a bare `#n` mean only the task's `repo:` repository, and a line without one names no PR. Otherwise it uses the review repository, `review.repo ?? github` (`review/config.ts:451`), as the one default entry, with `base = review.default_branch`. If neither gives an owner/name, the list is empty: consumers that need it are inactive and give that reason. Errors are reported as `repos[1].refs[0]: …` and turn off the modules that read `repos:` (PR health and the ready guard's repository-aware parsing). The project still loads.

**References (`repos/refs.ts`, new):** `parsePrRefs(text, repos, {mode, taskRepo}) → {repo, number, sha | null}[]`, case-insensitive. A reference must start at a word boundary and the number must not be followed by `[0-9A-Za-z_]`.

| Form | Repository |
|---|---|
| `owner/name#12` (a listed repository only) | that one |
| `<ref>#12`, `<ref> PR #12`, `<ref> pull request #12` | the entry that has `<ref>` |
| `PR #12`, `pull request #12` | the task's repository, else the default |
| `#12` (only with `mode: "mention"`) | the task's repository, else the default |

- `taskRepo` comes from `repo:owner/name` in the task's description (the tracker's tag, `tracker/service.ts:561`). It must name a listed repository; otherwise the line names no task repository.
- A bare `#n` never means a repository that is neither the task's nor the default (the cross-repo rule).
- `mode: "report"` (the ready guard) keeps today's requirement that the line has a PR word or a `<ref>#` form. `mode: "mention"` (the owner rule) also accepts a bare `#n`, as the script did.
- `[sha]` and ` at <sha>` after a reference set `sha`, as `MENTION` (`guard.ts:119`) does.
- The parser runs over at most `MAX_TASK_LINE_CHARS` characters; longer text is cut first. Its regexes are linear (no nested quantifiers).

**Hosts (`repos/hosts.ts`, new):** `RepoHosts` holds one per project. `host(repo): GitHost` builds a `GitHubHost({repo, apiUrl, token, fetch, timeoutMs})` once and keeps it. The project's hosts share one `TokenSource`. Tests inject `fetch` (`FetchLike`, `github.ts:26`), the only faked boundary. `base(repo)` returns the configured base, else `getRepo().defaultBranch`, read once and kept for that host.

**Ready guard changes (#251):**
- `ReadyReport` (`guard.ts:85`) gains `repo: string`, the resolved owner/name.
- `ReadyFactsSource` (`guard.ts:81`) becomes `{ repos: RepoEntry[]; facts(repo: string, pr: number): Promise<ReadyFacts> }`.
- `parseReadyReport(line, taskText, repos)` uses `parsePrRefs` in report mode. "Ambiguous" compares (repo, number) pairs.
- The bus tail `PR #n [sha]` (`guard.ts:121`) and a structured bus report (`fill.ts:2189-2194`, which carries only `pr`) both mean the task's repository, else the default. A bus report field for the repository is a follow-up.
- `evaluateReady(report, source, {agent, ciCounts})`: when the report's repository has `ci_counts: false`, the `ci_failed` and `ci_pending` items (`guard.ts:244-268`) are skipped, including "no CI check has run". Mergeability, behind-base, head, open state and gate checks still apply.
- `index.ts:719-722` builds the source. The review repository uses `review.readyFacts(pr)`, unchanged (gate and findings). Any other listed repository gets `readyFactsFromHost(hosts.host(repo), pr)` (new in `repos/`), which reads the PR, its base tip, `compare`, `newestChecks` and commits, with `gate: null` and `findingIds: []`. The review module is single-repository, so it has no gate or findings for other repositories.
- Refusal texts name `<ref>#n` for a repository that is not the default.
- `fill.guardDownUntil` (`fill.ts:1126,2219`) becomes a map per repository, so one host that is down does not hold reports about another.
- `agents.fill.ready_guard` still needs `review.enabled` (`agents/config.ts:700`), unchanged.

### 4.4 Detector, observe only (PR 2a; the owner rule, route and wiring are PR 2b)

PR 2a is reached only by its tests until PR 2b wires it. Both are off by default. Until 2b, a finding's owner is `unknown`, with the reason that the owner rule arrives in PR 2b.

**Config: `pr_health:`** (project block, new). All keys are listed in section 4.7.

**Tick.** Runs every `interval_seconds` (default 300), with the first tick 1 s after start. Ticks never overlap: the next one is scheduled when the last ends, as in `infra-monitor/service.ts:449-456`.

1. **Inputs, read once per tick.** The parsed `repos:`, the clock and the fill snapshot `agents.get(project)?.fillStatus()`, all in memory. The tick reads no file and starts no child process, apart from the token command, which `tokenFrom` runs asynchronously with `execFile` and a 10 s timeout and then caches. In act mode the ledger is written with async fs (PR 3).
2. **Each repository in config order,** inside its own try/catch, under a per-tick request budget (`max_requests_per_tick`, default 120, shared by the project's repositories) and a deadline (half the interval):
   1. `listOpenPullRequests()` (1 request). If it returns 100 PRs, the status shows `truncated: true`.
   2. Base tip: `branchHead(base)`, once per repository per tick (1 request).
   3. Filter. Skip PRs named in `ignored_prs`, PRs whose `headRef` matches `ignored_branches` (`compileBranchGlob` and `globMatches`, `authors.ts:54,72`), and PRs whose `baseRef` is not the base (stacked PRs). The status lists each skipped PR with the reason. Order the rest by `updatedAt`, newest first, with PRs left unread last tick first, and take at most `max_prs_per_repo` (default 30).
   4. Facts per PR, through a cache keyed by (repo, number) that holds `headSha, baseTip, mergeable, behindBy, checks, checksSettled`:
      - Read `getPullRequest(n)` (for `mergeable`) and `compare(baseTip, headSha)` (for `behindBy`) when there is no cache entry, the head or base tip moved, or `mergeable` was `null`.
      - With `ci_counts`, read `listChecks(headSha)` (2 requests) then `newestChecks`, unless the last read at this head was settled: every check `success` or `skipped`, at least one check, and none `failure`. Pending, missing or red checks are therefore read again every tick, so a re-run or a late CI run is seen.
      - A PR that has not changed and whose checks are settled costs no request.
   5. The first host error stops that repository for this tick: a `HostError` (including the self-imposed 429 block), a timeout or a network failure. PRs already read this tick are applied. The PRs not yet read, and every PR when the list itself failed, keep their findings exactly as they were: no clearing starts and `lastSeenAt` does not move. The repository's state becomes `error` with a one-line message, and `pr_health.repo_error` is emitted once when an error streak starts. The next repository continues. Budget or deadline exhaustion stops the same way, but the state stays `ok` and `partial: true`.
3. **Kinds,** per PR read this tick:
   - `conflicts`: `mergeable === false`. `null` means unknown: no new finding, an open `conflicts` finding at this head stays open (it is neither seen nor cleared), and the PR is read again next tick.
   - `behind`: `behindBy > behind_threshold` (default 30).
   - `no_ci`: requires `ci_counts`. The PR is not a draft, has zero checks at the head, and `now − updatedAt ≥ no_ci_minutes` (default 20; `updatedAt` from `review/host.ts:21`). Drafts never get `no_ci`.
   - `ci_red`: requires `ci_counts`. At least one newest check is `failure`. Pending is neither red nor missing CI, and skipped is ignored. Drafts do get `ci_red`, `conflicts` and `behind`, as the script reported them.
   - Each kind can be turned off under `kinds:`.
4. **Findings and clearing.**
   - Key: `pr_health:<repo>#<n>@<head8>:<kind>`, where `head8` is the first 8 hex characters of the head. The key is at most 179 characters (a 39-character owner, a 100-character name, a 9-digit PR and `conflicts`), under the 200-character limit for decision keys.
   - An open finding found again keeps its `since`.
   - A kind that was not found while its PR was read successfully gets `clearingSince` and is cleared after `clear_minutes` (default 10) of such reads.
   - When the head moves, every finding of the old head is cleared at once (`why: "head_moved"`).
   - When the repository's list succeeded and the PR is no longer open, its findings are cleared at once (`why: "closed"`).
   - A PR that becomes ignored is cleared at once (`why: "ignored"`).
   - Findings live in memory, as the infrastructure monitor's do. Delivery state survives restarts in the ledger and the Decision Inbox (PR 3).
5. **Owner,** once per tick for each (repo, PR, head) with an open finding (section 4.4.1). It is shown in the status and recomputed every tick.
6. **Observe output.** `planned[]` in the status lists what act mode would do now: each note and withdrawal with its argv, and each inbox notice with its key and code. Observe raises no decision, runs no command, does not read or create the ledger and writes no file. It emits only the events in section 4.7, as the infrastructure monitor does in observe.

#### 4.4.1 Owner rule (`pr-health/owner.ts`, PR 2b)

The inputs are the fill snapshot, the repository list, the PR's (repo, number, headRef), the review authors settings and a lazy push time. The result is `{agent | null, source: "task_line" | "branch" | null, line | null, reason}`, or `unknown`.

1. **No snapshot.** If the project has no agents module, or fill is off, the owner is `null` with a reason (there are no task lines). If fill is on but has not checked yet (`lastCheck === null`), the owner is `unknown`: nothing is delivered for this PR this tick.
2. **Open lines.** A line is open when `agent !== null` and `state ∈ {started, claimed, held}`. That is fill's own result: done comes from `checkDone`, which honours done-by-task. These lines never name an owner:
   - `done` lines.
   - `malformed` lines, including those over 2000 characters. Their view has `agent: null` and `description: null` (`fill.ts:1587`).
   - `not_allowlisted` lines: fill shows them before checking done (`fill.ts:1676`), so whether they are done is unknown.
   - `unassigned` lines (`agent: null`).
3. **Task-line rule.** Run `parsePrRefs(name + " " + description, repos, {mode: "mention", taskRepo})` over every open line. Among the lines that name (repo, number), the owner is the agent of the latest one (the highest line number, as the script's `tail -1` did). Source: `task_line`.
4. **Branch rule.** This runs only when step 3 found nobody and `owner.branch_window_minutes > 0` (default 360). `headRef` must map to exactly one agent through `review.authors.branch_pattern` and `review.authors.branches`. That agent must have at least one open line. The push time must be within the window, and a push time in the future counts as now. The owner is that agent, with source `branch`.
   - Push time is the head commit's committer date. That is a new field, `HostCommit.committedAt: string | null` (`review/host.ts:41`), mapped from `commit.committer.date`; `GhPerson` (`github.ts:83`) gains `date?`.
   - It is read with `listCommits(n)` (`github.ts:256`, at most 3 pages) only when this step is reached, once per (repo, PR, head).
   - If the head is not in the list (over 300 commits) or the date is missing, the push time is unknown and the rule does not apply (`reason` says so).
   - If the read fails, the owner is `unknown` this tick.
   - Without `review.authors` patterns the rule does not apply.
5. **Otherwise** the owner is `null` with `reason`. A PR with no owner gets the inbox notice only (section 4.5) and no agent is told.

The owner is recomputed every tick. A note goes to the owner at the time it is sent. If the owner changes later on the same head, no new note is sent; the status shows the current owner.

### 4.5 Act path (PR 3)

Act mode runs only when `mode: act` and the project is not `read_only` (`actBlocked`, as in `infra-monitor/config.ts:177`). `mode: act` without `notify_cmd` is a config error. Each tick does at most `MAX_COMMANDS_PER_TICK = 4` command runs, counting notes and withdrawals together.

**Ledger** (`data/pr-health-deliveries.json`, new). The format is 1. It is written by `ActLedger<R>` (`core/act-ledger.ts`), the generalised `infra-monitor/ledger.ts`, and `RequeueLedger` becomes `class RequeueLedger extends ActLedger<RequeueRecord>` in the same file with the same export. Records older than 14 days are pruned, and so are the oldest once there are more than 2000. PR health gives the ledger a `keep(record)` hook, and pruning never drops a record that the hook keeps:
- a record whose (repo, PR, head) still has an open finding;
- a record whose withdrawal is pending (`sent` with `withdraw` null, `running` or `failed`);
- any record of a repository that has not been read successfully since this process started.

If the 2000 cap is reached only by kept records, it gives way and the status shows a warning. A sent note is therefore never forgotten while its problem is still open, so it is never sent again. A record:

```ts
interface NoteRecord {
  project: string;
  id: string;            // delivery id = {id}: pr_health:<repo>#<n>@<head8>:<kinds joined "+">, e.g. pr_health:example/app#42@1a2b3c4d:conflicts+ci_red
  repo: string; pr: number; head: string;  // head: full sha
  kinds: ("conflicts" | "behind" | "no_ci" | "ci_red")[];
  agent: string;
  status: "running" | "sent" | "failed" | "gave_up";
  attempts: number; lastAttemptAt: number; nextAttemptAt: number | null; lastError: string | null;
  argv: string[];
  sentAt: number | null;
  withdraw: null | { status: "running" | "done" | "skipped" | "failed" | "gave_up"; attempts: number;
                     lastAttemptAt: number; nextAttemptAt: number | null; lastError: string | null };
}
```

On load, a `running` note or withdrawal becomes `failed` with "interrupted by a restart" (`ledger.ts:73-77`). A file that cannot be read or parsed is never overwritten: act stops and the status says why.

**Notes.** For each open (repo, PR, head) whose owner is an agent:
1. Find the new kinds: open kinds of that head that no ledger record for that (repo, PR, head) includes, whatever its status. If there are any, they form a new record with one command. Otherwise, a `failed` record whose `nextAttemptAt ≤ now`, whose `attempts < max_attempts` and whose kinds are still open is retried.
2. Write the record as `running`, with `attempts + 1` and `nextAttemptAt = now + backoff`, before the command runs. If that write fails, the command does not run.
3. Run `notify_cmd` with its placeholders filled (section 4.7) through `CommandRunner`, with `command_timeout_seconds` and the project `repo` as working directory.
4. Exit 0 within the timeout makes the record `sent` with `sentAt`. Anything else (a non-zero exit, a timeout, or a failure to start) makes it `failed` with exponential backoff (`backoff_seconds × 2^(attempts−1)`, at most 6 h). At `max_attempts` it becomes `gave_up`.
- A `sent` record is never sent again, including after a restart.
- A command that delivered but exited non-zero or timed out is retried with the same `{id}`. The contract for `notify_cmd` is to be idempotent on `{id}`; the example in section 6 is. With that, an agent sees one note per episode.
- Kinds that appear later at the same head get a note of their own, which names only the new kinds.
- A kind that clears and comes back at the same head is not noted again, as the script's seen-file rule did. Its status still shows it.

**Withdrawals.** A `sent` record is withdrawn once it is cleared. A record is cleared when one of these holds, judged from the ledger and this process's reads, not from findings that existed before a restart:
- a successful list of its repository no longer has the PR (closed or merged);
- a successful read shows the PR's head is no longer the record's `head` (the head moved);
- successful reads of the PR at the record's head have found none of the record's kinds open for `clear_minutes`, counted from the first such read.

After a restart the findings start empty, but the ledger still holds the `sent` records. So a note whose problem was fixed while Lair was down is cleared by the first successful reads after the restart (closed or moved: at once; fixed: after `clear_minutes`) and gets its withdrawal.
- With `withdraw_cmd` set, the withdrawal runs in the same steps as a note (written `running` first, bounded attempts, backoff) and ends `done` or `gave_up`.
- With `withdraw_cmd: null`, the record is marked `skipped` and no command runs.
- A record that was never `sent` gets no withdrawal, and its retries stop once its kinds clear.
- A withdrawal that gave up is shown in the status and goes no further.

**Inbox notices** (`pr-health/notices.ts`). They have the same shape as `infra-monitor/notices.ts`:
- module `pr_health`, class `pr_health.notice`
- `attention: "notice"`, one option `noted` with effect `reversible`
- `source {module: "pr_health", ref: key}`
- key `pr_health:<repo>#<n>@<head8>`
- `evidence {code, facts: {repo, pr, head, kinds, owner, reason}, cause_cleared: false, linked_issue: null}`
- context in Lair's words only (section 4.8)

They are evaluated every tick, never by sleeping. A notice is raised for a (repo, PR, head) with an open kind when one of these holds:
- `no_owner`: the owner is `null`. It is raised on the first act tick. An `unknown` owner raises nothing.
- `delivery_failed`: a note record of that head is `gave_up`.
- `unfixed`: `escalate_after_minutes` is set, a note was `sent`, at least `escalate_after_minutes` have passed since its `sentAt`, and one of its kinds is still open. The timer uses `sentAt` from the ledger, so a restart neither resets it nor fires it twice.

Deduplication follows `syncNotices` (`infra-monitor/service.ts:222-275`):
- While a notice with this key is open (`find`), no other is raised.
- One that was answered (Noted) after the head's first finding is not raised again for that head.
- It is withdrawn (`inbox.withdraw`) when the head has no open kind.
- After a restart, an open notice with no finding behind it is withdrawn after `clear_minutes`, but only for repositories whose read succeeded.
- Turning act off (a reload to observe, `enabled: false` or `read_only`) withdraws the open notices, as `withdrawAll` (472) does. It runs no command, and the ledger is kept.

### 4.6 Data model

- No SQLite schema changes and no store version changes, so there is no collision with the decisions store versions.
- Findings, the per-PR cache and the push-time memo are in memory and rebuilt on the first tick after a restart.
- The ledger is the JSON file described in section 4.5. Format 1 is new, so there are no older versions to migrate. Infra-monitor's ledger keeps its own file and format 1 unchanged.
- Decision Inbox notices use the existing store.

### 4.7 Interfaces

**`pr_health:` keys**

| Key | Type | Default | Valid |
|---|---|---|---|
| `enabled` | bool | `false` | |
| `mode` | `observe` \| `act` | `observe` | `act` needs `notify_cmd` |
| `interval_seconds` | int | 300 | 60-3600 |
| `request_timeout_seconds` | int | 20 | 1-120 (the host's `timeoutMs`) |
| `max_prs_per_repo` | int | 30 | 1-100 |
| `max_requests_per_tick` | int | 120 | 10-1000 |
| `behind_threshold` | int | 30 | 1-10000 |
| `no_ci_minutes` | int | 20 | 1-1440 |
| `clear_minutes` | int | 10 | 0-1440 |
| `kinds.{conflicts,behind,no_ci,ci_red}` | bool | `true` | |
| `ignored_prs` | string[] | `[]` | `owner/name#N` with a repository listed in `repos`, ≤ 200 entries |
| `ignored_branches` | string[] | `["dependabot/**"]` | `compileBranchGlob` syntax, ≤ 50. The default is `**`, not `*`: `*` stays within one path segment, and bot branches have several (`dependabot/npm_and_yarn/x`) |
| `owner.branch_window_minutes` | int | 360 | 0-10080 (0: no branch rule) |
| `notify_cmd` | argv \| null | `null` | `Argv` as in `infra-monitor/config.ts:19-23`; only the placeholders below |
| `withdraw_cmd` | argv \| null | `null` | same |
| `command_timeout_seconds` | int | 30 | 1-300 |
| `max_attempts` | int | 3 | 1-5 |
| `backoff_seconds` | int | 300 | 30-3600 |
| `escalate_after_minutes` | int \| null | `null` | 10-10080 |

**Placeholders** for `notify_cmd` and `withdraw_cmd`:

| Placeholder | Filled with |
|---|---|
| `{agent}` | a valid agent id |
| `{repo}` | owner/name |
| `{pr}` | the PR number |
| `{head}` | 8 hex characters |
| `{kinds}` | comma-separated, e.g. `conflicts,ci_red` |
| `{id}` | the delivery id |
| `{message}` | one line, ≤ 500 chars |

`buildArgv` fills each value once and refuses a value that would start with `-` when its template argument does not. An unknown placeholder is a config error.

**Message text.** Only Lair's own words and values from config or validated fields:
- conflicts: `it conflicts with <base>: merge <base> into the branch with a normal merge, resolve, push`
- behind: `it is <k> commits behind <base>: merge <base> and push`
- no_ci: `no CI has run at <head8> for <m> min`
- ci_red: `CI is red at <head8> (<k> failing checks): fix them before reporting it done or waiting`

The full message is `PR <repo>#<n> at <head8>: <kind texts joined "; ">. Fix this before other work on that PR. (<id>)`. A withdrawal is `PR <repo>#<n> at <head8>: <kinds> no longer seen (<why>); note <id> is withdrawn.`

**Route.** `GET /api/pr-health/status?project=` is read-only. It is registered like `infra-monitor/routes.ts:30-53`: `rejectCrossSiteRequests`, `?project=` checked by the root guards, and written out so the route-ownership scan sees it. No route starts, stops, writes or changes anything; config changes go through YAML and a reload. The response:

```ts
{ project, enabled, running, mode, actBlocked: string | null, intervalSeconds, lastTick, lastError, stale /* no tick for 3 intervals */,
  repos: [{ repo, base, ciCounts, state: "ok" | "error" | "inactive", error, partial, truncated, lastReadAt, prsRead, skipped: [{ pr, why }] }],
  findings: [{ key, repo, pr, head, kind, since, clearingSince, owner: { agent, source, line, reason } | "unknown", noticeId }],
  planned: [{ type: "note" | "withdraw", id, agent, argv: string[] | null, reason: string | null } | { type: "notice", key, code }],
  deliveries: NoteRecord[] /* act only */ }
```

**Events** (new `EventType` names; exact payloads):
- `pr_health.finding` `{project, key, repo, pr, head, kind, owner: string | null, ownerSource: "task_line" | "branch" | null, mode}`: emitted once when a finding opens. It is emitted again after a restart (findings are in memory); deliveries are not repeated.
- `pr_health.cleared` `{project, key, repo, pr, head, kind, why: "fixed" | "head_moved" | "closed" | "ignored"}`
- `pr_health.repo_error` `{project, repo, error}`: once when an error streak starts.
- `pr_health.noted` `{project, id, repo, pr, head, kinds, agent, result: "sent" | "failed" | "gave_up", attempts, error: string | null}`: act only.
- `pr_health.withdrawn` `{project, id, agent, result: "done" | "skipped" | "failed" | "gave_up", attempts, error: string | null}`: act only.
- `pr_health.escalated` `{project, key, code: "no_owner" | "delivery_failed" | "unfixed", decisionId}`: act only.

### 4.8 Security and privacy

- **Token.** It is sent only as the `Authorization` header to `review.api_url`, which `ReviewSchema` checks as a URL. It is never logged, never shown in the status and never put in an event.
- **Commands.** They run as argv arrays with no shell. Values are filled once, and a value that would start with `-` is refused. Agent ids are checked with `isValidDragonId` when fill parses them. The working directory is the project repository.
- **Host text is data.** Branch names, check names, PR titles and bodies never go into a note, a notice or argv. Messages carry counts, the configured base, the repository, the PR number, a hex head and minutes. Branch names and check names appear only in the status JSON.
- **Regex.** The reference parser is linear over at most 2000 characters. Globs use `globMatches` (a table, O(tokens × characters), `authors.ts:72`). No regex supplied by a user is run.
- **Routes.** One read-only route, as the infrastructure monitor has.
- **Logs.** Logs record the repository, PR, kind, owner and result. Error lines are one line of at most 300 characters and never contain a response body.

### 4.9 Reliability

- **Timeouts.** Every host request has `request_timeout_seconds`. Every command has `command_timeout_seconds` and its process group is killed at the deadline. The token command has 10 s. A timeout always counts as a failure: a repository error, or a `failed` delivery.
- **Isolation.** Each repository is handled in its own try/catch. A failure keeps that repository's findings and stops it for the tick. No finding is cleared because of an error, so recovery re-sends nothing.
- **Rate.** The default interval is 300 s and the cache means an unchanged, settled PR costs no request. Every tick is capped by `max_requests_per_tick` (120), so the worst case is 120 × 12 = 1440 requests per hour per project, against the token's 5000 per hour shared with the review module. A 429 blocks that host on its own until the reset (at most 15 min) and costs no further requests.
- **Idempotency.** The ledger makes delivery act-once: the attempt is written first, `sent` is final, retries are bounded with backoff, and `{id}` lets the command deduplicate a delivery that a crash interrupted. Notices are deduplicated by key in the inbox.
- **Bounds.** Up to 100 PRs listed per repository, 30 evaluated, 20 repositories, 4 commands per tick and 2000 ledger records. A tick ends early at half the interval.
- **Event loop.** No synchronous fs or child process runs in the tick or in the route (#245). The ledger uses `fs/promises`.

### 4.10 Observability

- The status route shows each repository's state, findings, owners and planned actions, plus deliveries in act mode, `stale` and `lastError`.
- The events in section 4.7 show in Activity.
- Log lines: `[pr-health] <project>: <repo>#<n> <kind> (owner …)` when a finding opens, and the repository errors.
- Startup logs `[pr-health] Watching PRs for: …` or `Off (no project sets pr_health.enabled)`.

## 5. Acceptance tests

The tests drive the real entry points: `RepoHosts` and `GitHubHost`, fill's `guardReport`, and `PrHealthManager.load` and `start`, plus the monitor's `tick()`, which is what its timer calls. They fake one named boundary each: GitHub through `FetchLike`, using payloads copied from GitHub's REST shapes that `github.ts` maps (a list item has no `mergeable`), and commands through `CommandRunner`. The decisions are a real `DecisionInbox` on a temporary store. Fill snapshots are the `FillLineView` objects fill emits (`fill.ts:1587` for malformed lines).

**PR 1: shared repository list and ready guard**
- **AT-1 `repos_config_defaults_and_fallbacks`**
  - `repos:` absent with `tracker.repos` set: the list takes that `repo` and `default`.
  - Absent with no tracker but `review.repo: example/app`: one default entry with `refs: ["app"]` and `ci_counts: true`.
  - Nothing usable: an empty list, and consumers are inactive with a reason.
- **AT-2 `repos_config_rejects_bad_entries`.** Each of these is a config error naming its key and turns the consumers off: `repo: app`, a repository listed twice, ref `pr`, a ref used by two entries, two defaults, two entries with no default, 21 entries.
- **AT-3 `prRefs_forms`.** `app#12`, `App PR #12`, `lib pull request #7`, `example/lib#7`, `PR #12` (default), `repo:example/lib PR #3` (lib), bare `#12` (default only in mention mode, nothing in report mode). These do not match 12: `xapp#12`, `app#123`, `app#12a`.
- **AT-4 `prRefs_cross_repo_negative`.**
  - `app#42` never yields lib#42.
  - A bare `#42` never yields lib#42 unless the task has `repo:example/lib`.
  - `example/other#42`, which is not listed, yields nothing.
- **AT-5 `readyGuard_ci_counts_off`.** lib has `ci_counts: false`. The DONE line is `lib PR #7 at <sha>`, the PR is open with `mergeable` true and `behind_by` 0, and the commits contain the head.
  - Every check failing: accepted.
  - Zero checks: accepted.
  - `mergeable` false: refused as `conflicting`.
- **AT-6 `readyGuard_reads_other_repo`.** For `lib PR #7 at <sha>`, every request goes to `/repos/example/lib/…` and the facts have `gate: null` and `findingIds: []`. The review host gets no request.
- **AT-7 `readyGuard_default_repo_unchanged`.** The bus tail `PR #12 [abc1234]` and a structured bus report with `pr: 12` read through `review.readyFacts(12)`. The existing `guard.test.ts` and fill guard tests pass, updated only for the new `facts(repo, pr)` signature.
- **AT-8 `readyGuard_host_down_per_repo`.** lib's fetch never answers (`timeoutMs` 50). The lib report is `unverifiable` with `hostDown`. An app report in the same fill check is still evaluated, and lib's backoff does not hold app.
- **AT-9 `readyGuard_ambiguous_across_repos`.** `app#5 and lib#5` with a task naming neither is ambiguous. With a task naming `lib#5`, the report is lib#5.

**PR 2a: detector (AT-10 to AT-20, AT-26, AT-28 to AT-30, AT-32) · PR 2b: owner rule, route and wiring (AT-21 to AT-25, AT-27, AT-31)**
- **AT-10 `prHealth_off_by_default`.**
  - No `pr_health:`: no instance and no timer, and the status has `enabled: false`.
  - `enabled: true` with an empty `repos`: inactive with a reason.
  - With PR health off, the fake fetch sees no request for the project.
- **AT-11 `prHealth_conflicts_from_single_pr_read`.** The list item for PR 42 has no `mergeable` and `GET /pulls/42` returns `mergeable: false`. The result is the finding `pr_health:example/app#42@<head8>:conflicts`, and the request log contains `GET /repos/example/app/pulls/42`.
- **AT-12 `prHealth_mergeable_null_unknown`.**
  - `mergeable: null`: no new `conflicts` finding.
  - An open `conflicts` finding at the same head stays open with no `clearingSince`.
  - The next tick reads `/pulls/42` again.
- **AT-13 `prHealth_behind_threshold`.** `behind_by` 31 is `behind`; 30 is not.
- **AT-14 `prHealth_no_ci_window`.** These are with zero checks unless stated:
  - `updatedAt` 21 min ago: `no_ci`.
  - 19 min ago: nothing.
  - A draft 60 min old: nothing.
  - Only a pending check: nothing, neither `no_ci` nor `ci_red`.
- **AT-15 `prHealth_ci_red_states`.**
  - Newest run conclusion `failure`, `cancelled` or `timed_out`: `ci_red`.
  - A status in state `error`: `ci_red`.
  - An older failure followed by a newer success with the same name: nothing.
  - Only `skipped` or `neutral` runs: nothing, and they count as checks, so no `no_ci` either.
  - A draft with a failure: `ci_red`.
- **AT-16 `prHealth_ci_counts_off`.** The repository has `ci_counts: false`, with zero checks for 60 min or with failing checks.
  - No `no_ci` and no `ci_red`.
  - No check-runs or statuses request is made.
  - `conflicts` and `behind` are still found.
- **AT-17 `prHealth_ignored`.**
  - `ignored_prs: [example/app#42]` gives no finding for 42.
  - Branch `dependabot/npm/x` gives no finding.
  - A PR into a branch other than the base gives no finding.
  - The status lists each with its `why`.
- **AT-18 `prHealth_cache_no_extra_requests`.**
  - Tick 2 with the list, base tip and head unchanged, `mergeable` true and green checks makes exactly 2 requests for the repository: list and branch head.
  - When the base tip moves, `/pulls/n` and `compare` are read again, but checks are not.
  - A pending check is read again each tick.
- **AT-19 `prHealth_repo_isolation_timeout`.** Repo A's list times out.
  - A's state is `error` and its open findings are unchanged: same `since`, no `clearingSince`.
  - Repo B's findings are computed.
  - `pr_health.repo_error` is emitted once over two failing ticks.
  - When A recovers with the same state, nothing is cleared or re-opened.
- **AT-20 `prHealth_rate_limited_no_storm`.** A answers 429 with `x-ratelimit-reset` 10 min ahead. The next tick inside that window makes zero requests to A and B is unaffected.
- **AT-21 `prHealth_owner_latest_open_line`.**
  - Line 3 `agent-a|n|t1|fix app#42` and line 7 `agent-b|n|t2|app PR #42 red CI`, both `started`: the owner is agent-b (task_line, line 7).
  - Line 7 `done`: the owner is agent-a.
  - Line 7 `not_allowlisted`: the owner is agent-a.
- **AT-22 `prHealth_owner_cross_repo_negative`.** PR lib#42.
  - With only `fix app#42` open: owner null.
  - With only `PR #42` open (default app): owner null.
  - With `repo:example/lib PR #42` open: that line's agent.
- **AT-23 `prHealth_owner_branch_window`.** No line names the PR. `branch_pattern: agent/{agent}/**`, the branch is `agent/agent-c/x`, and agent-c has an open line.
  - Committer date 5 h ago: agent-c (branch).
  - 7 h ago: null.
  - Within 6 h but agent-c has no open line: null.
  - No `branch_pattern`: null.
  - Head commit missing from `listCommits`: null with a reason.
  - `listCommits` times out: `unknown`.
  - `listCommits` is not called when a task line names the PR.
- **AT-24 `prHealth_owner_ignores_malformed_long_line`.** The snapshot has the malformed view fill emits for a 2001-character line naming PR #42 (`agent: null`, `state: "malformed"`). The owner is null with the reason that no open task line names the PR, and nothing throws.
- **AT-25 `prHealth_owner_unknown_until_fill_checks`.** Fill on with `lastCheck: null` gives `unknown`. Fill off gives null.
- **AT-26 `prHealth_sources_no_sync_io`.** This is a source scan, as main does it (`infra-monitor/probes.test.ts:191-204`): vitest cannot spy on named ESM exports of `fs` or `child_process`, so a spy would see zero calls whatever the code did. The scan covers every non-test `.ts` file in `src/server/repos/` and `src/server/pr-health/`, plus `src/server/core/act-ledger.ts` from PR 3 on. With comment lines removed, it asserts:
  - no `\b\w+Sync\s*\(` call;
  - no import from `"fs"` or `"node:fs"` (only `fs/promises`);
  - no import from `"child_process"` (commands go through `CommandRunner`).

  It also asserts that the expected files (`service.ts`, `refs.ts`) are in the list, so an empty scan fails.
- **AT-27 `prHealth_observe_writes_nothing`.** Observe mode with `notify_cmd` and `withdraw_cmd` set and findings both with and without owners:
  - the fake runner records no command;
  - the inbox has no decision;
  - the ledger path does not exist and the data directory is unchanged;
  - `planned` lists the note argv and the `no_owner` notice.
- **AT-28 `prHealth_clearing`.**
  - A new head clears the old head's findings with `head_moved`.
  - A PR missing from a successful list is cleared with `closed`.
  - A kind gone for 9 min stays with `clearingSince`; at 10 min it is cleared with `fixed`.
- **AT-29 `prHealth_event_payloads`.** `pr_health.finding`, `pr_health.cleared` and `pr_health.repo_error` carry exactly the fields in section 4.7.
- **AT-30 `prHealth_config_errors`.** Each of these is a config error naming its key:
  - `ignored_prs: [app#1]`
  - an `ignored_prs` repository not in `repos`
  - an `ignored_branches` entry `a***`
  - `mode: act` without `notify_cmd`
  - `{foo}` in `notify_cmd`
  - `interval_seconds: 30`
- **AT-31 `prHealth_wired_and_reloaded`.**
  - Server startup with a project that enables PR health logs the watching line, and `GET /api/pr-health/status` returns it.
  - A reload to `enabled: false` stops the timer.
  - The route has no POST, PUT or DELETE.
- **AT-32 `prHealth_budget_and_deadline`.** 40 changed PRs with `max_requests_per_tick: 40`. The tick stops at the budget with `partial: true`, the unread PRs keep their state, and they are read first next tick.

**PR 3: act**
- **AT-33 `prHealthAct_one_note_per_episode`.** The owner is agent-b, with `conflicts` and `ci_red` at h1.
  - One `notify_cmd` run with exactly the filled argv (`{agent}` agent-b, `{kinds}` `conflicts,ci_red`, `{id}`).
  - The record is `sent`.
  - The next tick in the same state runs nothing.
  - `behind` appearing later at h1 gives one more note, naming `behind` only.
- **AT-34 `prHealthAct_retry_after_failure`.**
  - Exit 1 makes the record `failed`, and nothing runs before `nextAttemptAt`.
  - The retry exits 0, so the record is `sent` after 2 runs in total with the same `{id}`.
  - A timed-out run is `failed`, never `sent`.
- **AT-35 `prHealthAct_restart_after_send`.** Each case uses a new manager on the same ledger file with `withdraw_cmd` set:
  - Same state after the restart: nothing runs.
  - The problem was fixed while Lair was down: the first successful read finds none of the record's kinds, and exactly one withdrawal runs after `clear_minutes`.
  - The PR was closed while Lair was down: exactly one withdrawal runs at the first successful list.
  - The head moved while Lair was down: exactly one withdrawal runs for the old head.
  - The repository's first read fails: no withdrawal runs.
- **AT-36 `prHealthAct_restart_mid_command`.** A `running` record loads as `failed` ("interrupted by a restart") and is retried after its `nextAttemptAt` with the same `{id}`.
- **AT-37 `prHealthAct_gave_up_escalates`.** With `max_attempts: 2` and both runs failing, the record is `gave_up` and one `delivery_failed` notice is raised. Later ticks raise no more.
- **AT-38 `prHealthAct_withdraw`.**
  - A sent note whose kinds clear gives exactly one `withdraw_cmd` run.
  - A sent note whose PR closes gives exactly one run.
  - A `failed` record that was never sent gives none.
  - With `withdraw_cmd: null`, nothing runs and the withdrawal is `skipped`.
- **AT-39 `prHealthAct_new_head`.** A note was sent at h1 and h2 is pushed, still conflicting. There is one withdrawal for h1 and one note for h2.
- **AT-40 `prHealthAct_no_owner_notice_only`.** The owner is null.
  - Zero commands.
  - One notice: class `pr_health.notice`, `attention: "notice"`, key `pr_health:example/app#42@<head8>`, code `no_owner`.
  - The next tick raises none.
  - When the problem is fixed, the notice is withdrawn.
  - Answered as Noted, it is not raised again for that head.
  - An `unknown` owner raises nothing.
- **AT-41 `prHealthAct_escalate_after_timer`.** With `escalate_after_minutes: 60`:
  - Sent at t0 and still open at t0+59: no notice.
  - At t0+60: one `unfixed` notice.
  - A problem fixed at t0+30 never raises one.
  - A restart after the notice does not raise a second.
  - With the default `null`, no `unfixed` notice is ever raised.
- **AT-42 `prHealthAct_ledger_failures`.**
  - An unwritable ledger directory: no command runs and `lastError` is set.
  - An invalid ledger file: not overwritten, and act is paused with a reason.
- **AT-43 `prHealthAct_argv_safety`.**
  - The runner receives an array, and the message has no branch name, check name or title.
  - A value that would start with `-` is refused: the `planned` reason is set and nothing runs.
- **AT-44 `prHealthAct_read_only_project`.** A `read_only` project has `actBlocked` set and behaves like observe.
- **AT-45 `prHealthAct_switch_to_observe`.** A reload from act to observe withdraws the open notices and runs no command.
- **AT-46 `infraMonitor_ledger_regression`.** The existing infra-monitor tests pass on `ActLedger`, and `raisers.test.ts` passes with the new `pr-health/notices.ts` entry.
- **AT-47 `prHealthAct_prune_keeps_open`.** A `sent` record is 15 days old and its head still has an open finding: it is kept, and the next tick sends nothing. A record 15 days old with no open finding and its withdrawal done is pruned.

## 6. Rollout

1. Merge PR 1. Nothing changes until `repos:` lists a second repository or sets `ci_counts: false`. Then the ready guard can be turned on for a project with several repositories (#251).
2. Merge PR 2a, then PR 2b. Nothing runs until 2b wires the module. Then set `pr_health: {enabled: true}` (observe is the default) and `repos:`. Run it alongside the existing script for a day: `GET /api/pr-health/status` should show the same problems and owners as the script's output, and `planned` shows what act would send.
3. Merge PR 3. Set `notify_cmd` (and `withdraw_cmd` if wanted), then `mode: act`. Example of a command that is idempotent on `{id}`:
   `notify_cmd: ["/opt/lair-hooks/agent-note", "{agent}", "{id}", "{message}"]`, where the script appends `- NOTE for <agent> (<id>): <message>` to the team's task list unless a line containing `<id>` is already there.
4. Check that a deliberately conflicting test PR gets one note, and one withdrawal after the fix. Watch `pr_health.noted` and `pr_health.withdrawn` in Activity. Then retire the script.
5. Roll back with `mode: observe`, which runs no command and withdraws the open notices, or `enabled: false`. The ledger stays for history.

## 7. PR split

| PR | Content | Non-test lines (estimate) | ATs |
|---|---|---|---|
| 1 | `repos/` (config with the tracker and review fallbacks, refs, hosts, `newestChecks`, `readyFactsFromHost`), ready guard changes (`facts(repo, pr)`, `ci_counts`, repository-aware parsing, per-repository host backoff), `index.ts` source, docs | ~480 | AT-1 to AT-9 |
| 2a | `pr-health/` config and validation, types, detector (kinds, per-head cache, request budget and deadline), per-repository isolation, findings and clearing, status view, events, docs | ~600 | AT-10 to AT-20, AT-26, AT-28 to AT-30, AT-32 |
| 2b | Owner rule, `HostCommit.committedAt`, status route, `index.ts` wiring and start, `reload/modules.ts` | ~400 | AT-21 to AT-25, AT-27, AT-31 |
| 3 | `core/act-ledger.ts` (moved from infra-monitor, with the `keep` hook), `buildArgv`, notes, withdrawals (including after a restart), inbox notices, timer, `RAISERS` entry, docs | ~560 | AT-33 to AT-47 |

The estimates are measured against the infrastructure monitor, whose non-act code is about 1,200 lines; PR 2a and 2b together are the same order of size.

Each PR builds and merges on its own. PR 2a's module is not reachable from startup until PR 2b wires it, so 2a changes no behaviour. PR 2a, 2b and 3 sit behind `pr_health.enabled: false`, and PR 3 also needs `mode: act`.

## 8. Open risks

- **Committer date is not push time.** A commit made long before it is pushed looks older than it is, so the branch rule may name nobody. That is safe, because the inbox then hears about it. AT-23 covers the source.
- **Mergeability can lag.** GitHub may return `null` for a while after a push. The PR is read again each tick, and an open `conflicts` finding is never cleared on `null`.
- **The fill snapshot can be stale.** The owner rule uses fill's last check, which can be up to one fill interval old. A note can then name an agent whose line was just closed; it is sent once, and the status shows the current owner.
- **Delivery is act-once only if the command honours `{id}`.** A crash during a command means one retry with the same `{id}`. A command that ignores `{id}` can duplicate a note in that case.
- **Rate-limit state is per host instance.** The review module's host and PR health's hosts each learn about a 429 separately. The request budget bounds what PR health spends.
- **More than 100 open PRs in a repository.** The extra PRs are not seen. The status shows `truncated`.
- **Event repeats.** Findings are in memory, so `pr_health.finding` events repeat after a restart. Deliveries do not.

## 9. Review findings

| Id | Finding | Resolved in |
|---|---|---|
| PH-01 | `mergeable` is not on the list endpoint; `null` rule | 4.2 (mergeability row), 4.4 step 2.4 and the `conflicts` kind; AT-11, AT-12 |
| PH-02 | No host factory; token, apiUrl, `timeoutMs` | 4.2 (PR data, timeout and token rows), 4.3 Hosts (`RepoHosts`), 4.7 `request_timeout_seconds`; AT-6, AT-10, AT-19 |
| PH-03 | `view.taskRegistry()` invented; sync fs | 4.2 (task lines row), 4.4 step 1, 4.4.1 (fill snapshot, read once per tick, no file); AT-24, AT-25, AT-26 |
| PH-04 | Owner not repository-aware, "first" not latest, no 6 h window, hard-coded branch pattern | 4.3 References, 4.4.1 steps 3-4 (latest line, `branch_window_minutes`, `review.authors` patterns); AT-21, AT-22, AT-23 |
| PH-05 | No design for notice withdrawal, including after a restart | 4.5 Withdrawals ("cleared" judged from the ledger and this process's reads, also after a restart), 4.7 `withdraw_cmd` and the `pr_health.withdrawn` event; AT-35, AT-38, AT-39 |
| PH-06 | No exactly-once delivery | 4.5 Ledger and Notes (written first, `sent` is final, `{id}`, one message per (PR, head) for its new kinds); AT-33 to AT-36 |
| PH-07 | Observe mode contradicts the watchdog's escalation | 3 Out (not a watchdog detector), 4.4 step 6; AT-27 |
| PH-08 | Blocking verify wait | 4.5 Inbox notices (evaluated each tick from `sentAt`); AT-40, AT-41 |
| PH-09 | No per-repository isolation; resolve on error | 4.4 step 2.5, 4.9 Isolation; AT-19, AT-20 |
| PH-10 | Draft and dependabot rules | 4.4 step 3 (drafts get every kind but `no_ci`), `ignored_branches` default; AT-14, AT-15, AT-17 |
| PH-11 | Events that do not exist | 4.7 Events (new names, exact payloads, added to `EventType`); AT-29 |
| PH-12 | Rate limit | 4.4 step 2.4 cache, 4.7 `interval_seconds` 300 and `max_requests_per_tick`, 4.9 Rate; AT-18, AT-20, AT-32 |
| PH-13 | Non-goal contradicts scope | 3 (removed; several repositories are in scope) |
| PH-14 | `watchdog/detectors/` does not exist | 3 Out, 4.1 (own module, `DETECTOR_IDS` untouched) |
| PH-15 | Short head length | 4.4 step 4 (`head8` = 8 hex characters) |
| PH-16 | Check states, 19-minute negative, `ci_counts` off also skips `ci_red` | 4.2 check state row, 4.4 step 3; AT-14, AT-15, AT-16 |
| PH-17 | Format validation; example command | 4.3 and 4.7 key tables, 6 step 3; AT-2, AT-30 |
| PH-18 | Repository list not shared; ready guard reuse | 4.3 (project `repos:` aligned with `tracker.repos[]`, `parsePrRefs`, `RepoHosts`, guard `facts(repo, pr)` and `ci_counts`), 7 PR 1; AT-1 to AT-9 |
| PH-19 | Owner rule: push-time source, open definition, escalate only | 4.4.1 steps 2, 4 and 5 (`HostCommit.committedAt` from the committer date; open = fill's states; no owner gives the notice only); AT-21, AT-23, AT-40 |
| PH-20 | Async bounded read, no sync AT, long lines | 4.4 step 1 and 4.9 Event loop (no file read in the tick; fill's limits already apply), 4.4.1 step 2 (malformed lines); AT-24, AT-26 |
| PH-21 | PR split | 7 (PRs 1, 2a, 2b and 3, each ≤ ~600 non-test lines, with their ATs) |
| PH-22 | Reuse `notices.ts` and `ledger.ts` | 4.2 (notices and act-once rows), 4.5 (`ActLedger` moved out of infra-monitor, notice shape and `syncNotices` rules); AT-46 |
| PH-23 | The no-sync AT cannot work as a spy | AT-26 is a source scan following `infra-monitor/probes.test.ts:191-204` over `repos/`, `pr-health/` and `core/act-ledger.ts` |
| PH-24 | Pruning can re-send a note | 4.5 Ledger (the `keep` hook never prunes a record whose head has an open finding or whose withdrawal is pending); AT-47 |
| PH-25 | The PR 2 estimate is too low | 4.1, 4.4 and 7 (split into 2a and 2b) |
| PH-26 | A tracker fallback with no default | 4.3 (2 or more tracker entries with no default are taken as "no default", not an error) |
| PH-27 | AT-10 contradiction; key length | AT-10 bullet 3 reworded; 4.4 step 4 (at most 179 characters) |
| Owner questions | Settled defaults | Header: `escalate_after_minutes` is `null`; the bus channel is a follow-up that needs an asynchronous mirror and delivery outside a run |
