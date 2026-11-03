# Review funnel: fewer strong-review rounds, cheapest check first

- **Status:** Draft (2026-11-03), against main `31b794c`.
- **Plan lines / issues:** #362 (this spec's PR closes it); builds on #354 (finding resolution and escapes) and #355 (content routing and audit sample); builds on [review-stages.md](review-stages.md) (`ask_after`).
- **Owner questions** (each has a default; the build uses the default until the owner answers):
  1. Which findings may become an approve-with-conditions? Default: **medium only**, never high or critical, never the classes `money`, `security`, `tenancy`, never an unclassified finding, never a file a red-tier risk rule matches.
  2. After how many strong rounds on one PR does the sticky reviewer give way to a fresh full read? Default: **4** (the 5th strong review is a fresh full read by any strong reviewer).
  3. The cheap pre-review's recall bar. Default: **0.6** on at least **20** bench cases (below it, or unmeasured, the cheap stage is advisory, and only where a strong slot follows it).
  4. The spend cap of one bench run. Default: **30 cases and USD 10**, whichever comes first.
  5. When does Lair recommend splitting a PR? Default: after strong round **3**, with more than **5** files carrying open medium+ findings.
  6. When does a mechanizable class become a rule candidate? Default: **3** distinct findings with the same check slug on at least **2** PRs.
  7. Does Lair open the rule candidate's issue on the git host by itself? Default: **no**, the owner clicks "Open issue" (one issue per candidate, ever).

## 1. Problem

A project that runs two reviewer kinds (an expensive, strong reviewer and a cheap one) pays for most of its review spend in repeated strong rounds. Measured on one project on 2026-11-03: 43 PRs, **2.35 strong-review rounds per PR**, **21 %** approved on the first strong round, about **USD 2.1 per strong review**, 141 medium+ findings on 68 files. The worst finding of each request-changes round was medium in 28 rounds, high in 27 and critical in 4; a round with only lows never sent a PR back. Rounds do not converge: each strong review is a fresh reviewer reading the whole PR, so round 7 of one PR still found a new batch. And most findings repeat classes the strong reviewer already raised on the same files (failure paths, concurrency, tenancy, security, money, retries), so the builder and the cheap reviewer could have caught them first.

The funnel makes each strong review count: deterministic checks and the strong reviewer's own past findings go first, a calibrated cheap reviewer screens before the strong one, and the strong reviewer re-reviews only what changed.

**Targets** (measured by the report in §4.8, over 4 weeks after every part is on, against the baseline above):

| Measure | Baseline | Target |
|---|---|---|
| Strong reviews per merged red PR | 2.35 | <= 1.3 |
| First-round strong approval (unconditional) | 21 % | >= 60 % |
| Strong-review spend per merged PR | ~USD 4.9 (2.35 × 2.1) | halved (<= USD 2.5) |
| Escapes per merged PR (#354) | measured by #354 from its start | not up |

## 2. What exists today (main `31b794c`)

| What | Where |
|---|---|
| Reviews and findings tables: `review_findings` has `severity, file, line, text, blocking, rule, status, resolved_by, resolved_at, resolution` | `src/server/review/store.ts:111` (`review_reviews`), `:127` (`review_findings`) |
| PR records with head, branch and host state (`merged` included, so merges outside Lair are seen) | `src/server/review/store.ts:146` (`review_prs`), `:42-46` (schema 5) |
| Merges made by Lair (no tier column) | `src/server/review/store.ts:170` (`review_merges`) |
| Store schema version 5 and the stepwise migration (a step runs only when the file's version is below it) | `src/server/review/store.ts:40`, `:503-516` |
| A review's findings written with `status = 'open'`; `rule` is set only by checks | `src/server/review/store.ts:549-566` |
| Every review of a PR with its findings, oldest first | `src/server/review/store.ts:574` (`listReviews`) |
| A later review by the same reviewer supersedes its earlier ones | `src/server/review/service.ts:409-414` (`annotate`) |
| Manual resolution of one finding (owner only) | `src/server/review/store.ts:628`, `src/server/review/service.ts:878`, `src/server/review/routes.ts:316` |
| Severities and statuses | `src/shared/review-types.ts:29-30`, `ReviewFinding` `:32` |
| The findings line a reviewer agent writes: `path:line: severity: text` | `src/cli/review-submit.ts:53` (`FINDING`), `:120` (`parseFindings`), `src/server/review/prompt.ts:20` (`FINDINGS_FORMAT`) |
| The review route's finding body (no class, no condition) | `src/server/review/routes.ts:65-84` |
| An approval can't carry blocking findings | `src/server/review/service.ts:765` |
| A review through an assignment is recorded under the assignment's agent; `byAgents` marks a run Lair started | `src/server/review/service.ts:774-782` |
| The reviewer prompt: one-pass placeholders `{pr} {head} {repo} {tier} {base} {url} {findings_format}`, each value shape-checked; "nothing a PR's author controls beyond those shapes reaches the reviewer's prompt" | `src/server/review/prompt.ts:1-13`, `:37`, `:40`, `:62`, `:75` |
| Slot schema with `pool`, `different_model`, `ask_after` | `src/server/review/config.ts:41-67`, parsing `:353` |
| Staged slots: a slot waits for the gate and/or earlier slots | `src/server/policy/reviewer-slots.ts:180` (`withSlotWaits`), used at `src/server/review/service.ts:652`; spec [review-stages.md](review-stages.md) |
| Reviewer choice: pool order, not the author, `different_model`, not one that reviewed this head, agents whose runs ended without a review last; nothing prefers the previous round's reviewer | `src/server/review/agent-assigner.ts:352` (`candidates`), `:394`, `:410-458`, `:460` |
| Review run task id `review-<pr>-<head8>[-<n>]` | `src/server/review/agent-assigner.ts:79-81` |
| Request rounds per slot and head, with token hash | `src/server/review/store.ts:65-86` (`review_requests`, key with `round`) |
| Asking for missing slots; a request while one runs joins it | `src/server/review/service.ts:1074` (`requestReviews`), `:1371` (`requestNow`) |
| Merge policy conditions: missing slots (`reviews`), `changes_requested`, open blocking `findings` | `src/server/policy/merge-policy.ts:110`, `:136`, `:147` |
| Test integrity check, recorded as a review by `lair:test-integrity`; `isTestFile` | `src/server/review/service.ts:39`, `:83`, `:451`; rules `src/server/review/integrity.ts:28` |
| Per-run AI spend with `origin`, `pr`, `head_sha`, `cost` | `src/server/agents/store.ts:109` (`agents_spend`); review runs mapped by `src/server/agents/spend-classify.ts:136` (`reviewTaskOf`); a PR number named in a line `:111` (`prNamed`) |
| Fill builds a builder run's prompt from `agents.fill.prompt_files` | `src/server/agents/config.ts:214-215` |
| Risk rules (tiers by path and size) | `src/server/policy/risk-rules.ts:12` |
| A replay bench pattern (recorded cases, scored answers) | `src/server/brain-bench/types.ts`, `src/server/brain-bench/run.ts` (`statsOf`) |
| Decision Inbox sink; a key dedupes only while that decision is open | `src/server/review/ports.ts:4`, `:44` |
| Owner-only guard in the review routes | `src/server/review/routes.ts:188` |
| Host client: every request has a timeout (30 s default); `compare(base, head)` returns only `aheadBy`/`behindBy` | `src/server/review/github.ts:195`, `:289`; port `src/server/review/host.ts:90` |
| Issue creation with a pending record and a body marker, so a lost answer never makes a second issue | `src/server/tracker/service.ts:747-749`, `src/server/tracker/github-projects.ts:440` (`createIssue`) |

**Not found on main** (`git grep -i` over `src/`, 2026-11-03): `findings_bank`/`findingsBank`, a finding class, a check slug, a condition on a finding, `previous_head`/`previous_findings` in the prompt, a delta review mode, a settled file, a recall measure, a review bench, a rule candidate, a split recommendation, a funnel report, a changed-line total from `compare`, issue creation in the review module's host port. Everything in §4 marked NEW is one of these.

## 3. Users and stories

- As the owner, I pay for one strong review per PR in most cases, not two or three, so that review spend follows risk instead of churn.
- As a builder agent, I get the strong reviewer's past medium+ findings on the files I touch in my brief, so that I don't repeat them.
- As the cheap reviewer, I review with the same bank in my prompt, and I am a required stage only while I am measured to catch most of what the strong reviewer catches.
- As the strong reviewer on a fix round, I get my previous head and findings and review only the change since, re-checking each finding, so that a fix round converges instead of finding a new batch.
- As the strong reviewer, I can approve with a medium finding marked as a condition, verified mechanically at the next head, so that a typo-class fix does not cost another strong round.
- As the owner, I see each week whether the funnel works (first-round rate, rounds, spend, recall, conditions, escapes) and get a notice when escapes rise.
- Failure: the cheap verifier times out, is the PR's author, or misses a condition; the condition is not verified, the approval does not carry and the strong reviewer is asked (fail closed).
- Failure: the previous head is not an ancestor or the change since is too large; the strong reviewer does a full read.

## 4. Design

### 4.0 Where it lives, switches, who counts as strong

NEW module files under `src/server/review/funnel/`: `classify.ts` (finding tags), `match.ts` (finding matcher), `bank.ts`, `rounds.ts` (sticky, delta, settled, split hint), `conditions.ts`, `bench.ts`, `report.ts`, `rules.ts` (rule candidates), `notices.ts`. Wired from the review service (`src/server/review/service.ts`) and its routes (`src/server/review/routes.ts`). The funnel's periodic work (the daily escape check, retention) runs inside the review module's existing scan (every 60 s; each job at most once per UTC day, its last run stored in `review_funnel_notices`), so no new timer starts.

**A strong review** is a review of kind `agent`, recorded through an assignment of a run Lair started (`byAgents`, `service.ts:774-782`), whose agent is in `strong_reviewers`. **A cheap review** is the same with `cheap_reviewers`. A human review, an owner review or a review posted under a reviewer's name without such an assignment never counts as either. The review records this as NEW column `review_reviews.stage` (`strong | cheap | null`), set when it is recorded, so a later config change does not rewrite history.

NEW config block `review.funnel` (validated in `src/server/review/config.ts`; unknown keys refused):

| Key | Type | Default | Meaning |
|---|---|---|---|
| `strong_reviewers` | list of agent ids | `[]` | Empty: every part is off whatever its switch says. |
| `cheap_reviewers` | list of agent ids | `[]` | Must not overlap `strong_reviewers` (refused). |
| `classes` | list of slugs | `[failure-paths, concurrency, tenancy, security, money, retries, caching, modes, tests, docs, other]` | 1-30 entries, each `^[a-z][a-z0-9-]{1,30}$`; must include `money`, `security`, `tenancy` (the condition exclusions). |
| `bank` | `off \| observe \| on` | `off` | §4.3 |
| `sticky` | `off \| observe \| on` | `off` | §4.5 |
| `delta` | `off \| observe \| on` | `off` | §4.5 |
| `conditions` | `off \| observe \| on` | `off` | §4.6; `on` is refused until #354's escape records are on for the project |
| `pre_review` | `off \| observe \| on` | `off` | §4.4 |
| `split_hint` | `off \| on` | `off` | §4.5 (a notice only) |
| `rule_candidates` | `off \| on` | `off` | §4.2 (a queue and notices only) |
| `bank_max_items` | int 1-60 | 30 | |
| `bank_max_bytes` | int 1024-32768 | 8192 | |
| `fresh_read_after_rounds` | int 2-20 | 4 | Owner question 2 |
| `sticky_wait_minutes` | int 0-240 | 30 | |
| `delta_max_lines` | int 100-20000 | 1500 | |
| `condition_max_lines` | int 1-2000 | 200 | §4.6 |
| `line_window` | int 0-200 | 10 | Matcher (§4.1) |
| `recall_bar` | number 0-1 | 0.6 | Owner question 3 |
| `bench_min_cases` | int 5-500 | 20 | |
| `bench_max_cases` | int 1-500 | 30 | Must be >= `bench_min_cases` (refused otherwise). Owner question 4 |
| `bench_max_usd` | number 0-1000 | 10 | Owner question 4 |
| `bench_case_timeout_minutes` | int 5-240 | 30 | |
| `split_after_rounds` | int 1-20 | 3 | Owner question 5 |
| `split_min_files` | int 1-200 | 5 | Owner question 5 |
| `candidate_min_findings` | int 1-50 | 3 | Owner question 6 |
| `candidate_min_prs` | int 1-50 | 2 | Owner question 6 |

**`observe`** means: Lair computes what the part would do and shows it (the PR status gains a `funnel` object with one entry per part: `would`, `why`), and changes nothing: no prompt text (every funnel placeholder is `(none)`), no reviewer choice, no merge condition, no resolution, no outward action. The only writes are the review records Lair writes today plus their NEW tag columns. **`on`** acts. Each config load that sees a part's mode change appends a row to NEW table `review_funnel_switches(project, part, mode, at)`, which the report uses for "before" and "after".

### 4.1 Classification and the matcher (NEW, layer 1 input)

**Finding tags.** A finding's text may start with tags, each in square brackets, in any order, before the text:

```
src/app.ts:42: medium: [retries] [check:retry-has-cap] the retry loop has no bound
src/app.ts:57: medium: [docs] [condition] the comment says 30 s, the code waits 60 s
```

- `[<class>]`: one of `review.funnel.classes`. At most one.
- `[check:<slug>]`: a deterministic check could catch this; `<slug>` is `^[a-z][a-z0-9-]{2,40}$` naming that check. At most one.
- `[condition]`: §4.6.

Parsing (`classify.ts`, used by `parseFindings` in `src/cli/review-submit.ts` and by the review route): leading tokens matching one of the three forms are consumed; the first token that does not match ends the tags and stays text. A bracket token with an unknown class stays text and the class is null (old reviewers and free text keep working). The route body gains optional `class`, `check`, `condition` (boolean) fields with the same validation; the CLI sends them parsed. `FINDINGS_FORMAT` gains the class and check sentence when `strong_reviewers` or `cheap_reviewers` is set, and the `[condition]` sentence only as §4.6 says.

**Store (schema v6, NEW, all nullable, `ALTER TABLE ... ADD COLUMN`):** `review_findings.class`, `.check_slug`, `.condition` (`proposed | open | met | not_met | ineligible`), `.condition_head`, `.condition_by`, `.class_by`, `.class_at`; `review_reviews.stage`, `.mode` (`full | delta | conditions`), `.previous_head`, `.prompt_sha` (SHA-256 of the prompt template file used); `review_prs.tier` (the tier at its latest evaluation), `.fresh_head` (§4.5). NEW tables `review_funnel_switches` (§4.0) and `review_funnel_notices(project, key, raised_at)`, primary key `(project, key)`. Existing rows get null (unclassified, full read, unknown prompt, unknown tier). Later PRs that add tables take the next version each (§7); every PR's version is the next free one when it merges, and the migration test opens a file of every older version.

**Owner reclassification** (NEW route, owner-only): `POST /api/review/findings/:id/classify` body `{class: <slug> | null, check: <slug> | null}`; 400 on an unknown class or bad slug, 404 on another project's finding. It stores `class_by` and `class_at`. The dashboard lists unclassified strong medium+ findings for this (PR 6).

**Matcher** (`match.ts`, pure): two findings match when the file is equal, both lines are known and `|a.line - b.line| <= line_window` (a null line matches only a null line in the same file), and, when both have a class, the class is equal. Used by the bench (§4.4), live recall (§4.8), the bank's and the rule queue's de-duplication, and #354's automatic resolution (#354 reuses this module instead of its own "same rule, file and nearby line" rule).

**A distinct finding** is the first of a chain of strong findings on one PR that match each other across rounds (a reviewer repeating an open finding in a delta round, §4.5, does not make a new one). Counts in §4.2 and §4.8 are of distinct findings.

### 4.2 Layer 1: deterministic checks from mechanizable findings (NEW)

A strong finding tagged `[check:<slug>]` is mechanizable. `rules.ts` keeps a queue, NEW table `review_rule_candidates` (its own schema version, PR 6):

| Column | Type |
|---|---|
| `project`, `slug` | TEXT, primary key |
| `class` | TEXT null (the most frequent class among its findings) |
| `state` | `proposed \| accepted \| built \| rejected` |
| `finding_ids` | JSON list of distinct findings, capped at 200 (newest kept; `finding_count` keeps the total) |
| `finding_count` | INTEGER, distinct findings |
| `pr_count` | INTEGER, distinct PRs among them |
| `issue_number` | INTEGER null; `issue_pending_at` TEXT null |
| `rule_ref` | TEXT null (the project rule or test the owner names when built, <= 200 chars) |
| `first_at`, `last_at`, `updated_at`, `updated_by` | TEXT |

Each strong review with a `[check:]` finding that is a distinct finding upserts the row in the review's own transaction (a re-delivered review is refused by the once-per-token rule, so nothing counts twice). When `finding_count >= candidate_min_findings` and `pr_count >= candidate_min_prs`, one Decision Inbox notice is raised unless `review_funnel_notices` has `rule-candidate:<slug>` (written in the same step), so a notice the owner closed is not raised again.

Routes (NEW): `GET /api/review/rule-candidates?project=` (read, project-scoped, ids and counts); owner-only `POST /api/review/rule-candidates/:slug/state` body `{state: accepted|rejected|built, rule_ref?}`; owner-only `POST /api/review/rule-candidates/:slug/issue`. The issue route follows the tracker's pattern (`tracker/service.ts:747-749`): it sets `issue_pending_at` and the body carries the marker `lair-rule-candidate:<project>:<slug>` before it calls the host; on a retry with `issue_pending_at` set it first searches the repository's issues for the marker and stores that number instead of creating one. One request at a time per candidate (an in-process lock; a second concurrent call gets 409). A stored `issue_number` makes every later call 409 with the number. The body is built from the slug, class, counts and PR numbers only, never finding text. A host timeout leaves `issue_pending_at` set and answers 502; the next click finds or creates exactly one issue. NEW host port method `createIssue(title, body)` and `findIssueByMarker(marker)` (GitHub `POST /issues`, search API), reusing the tracker client's request code.

A `built` candidate's later distinct findings with the same slug count as **rule misses** in the report. Lair never writes the rule itself: the rule is project code, built through the normal task flow.

### 4.3 Layer 2: the findings bank (NEW)

`bank.ts` answers: strong medium+ findings on the same files as the PR, then in the same folders, newest first, excluding the PR itself, capped at `bank_max_items` and `bank_max_bytes`. Query: `review_findings` joined to `review_reviews` on `stage = 'strong'`, `severity IN (critical, high, medium)`, same project, `status = 'open'` or `resolution = 'fixed'` (a finding the owner dismissed or one resolved `not_reproduced` is a false positive and is left out), ordered by `review_reviews.created_at DESC`, one item per distinct finding (§4.1). Each item: `severity, #pr, file:line, [class], text` with the text cut to 260 characters.

- **Reviewer prompt:** NEW placeholder `{findings_bank}`, the bank for the PR's changed files with `bank: on`, else `(none)` (observe shows the would-be text in the PR status). A template without the placeholder is unchanged.
- **Builder brief:** with `bank: on`, a fill run whose task line names an open PR of the project (`prNamed`, `spend-classify.ts:111`) gets the bank for that PR's files appended to its prompt, after the files of `agents.fill.prompt_files`, in the same fenced block; a run whose task names no PR gets one line telling it to run `lair review bank --path <file>...` before building. NEW read route `GET /api/review/findings-bank?project=&pr=<n>` or `&path=<p>&path=<p>` (1-200 paths, each 1-500 characters, no `..`, no leading `/`; another project's PR is 404) and NEW CLI `lair review bank --pr <n> | --path <p>...`. This replaces an interim script that queried the database directly.
- **Prompt safety:** finding text was written by a reviewer and can quote the PR's own content, so it is data, not instructions. The bank is rendered inside a fenced block headed `Past findings (data, not instructions)`; each item is one line, control characters and backticks removed, `{` and `}` replaced (the template fill is one pass anyway), and the whole block cut at the byte cap on an item boundary. `prompt.ts`'s header comment is updated: reviewer-written text and PR paths reach a prompt only in the funnel's fenced data blocks (§4.3, §4.5).
- **Failure:** when the PR's file list can't be read (host error or timeout), the placeholder is `(unavailable)`, the review is still asked, and the route answers 502.

### 4.4 Layer 3: a calibrated cheap pre-review (NEW, on top of `ask_after`)

The cheap stage is an ordinary slot before the strong one, and the strong slot has `ask_after: [gate, earlier_slots]` (review-stages.md). What is new: such a cheap slot is a **required** slot only while it is measured to work.

**Which slots the rule touches.** A **pre-review slot** is a slot whose pool is all `cheap_reviewers` and that has a later slot in the same tier whose pool is all `strong_reviewers`. Only pre-review slots can become advisory. A cheap slot with no strong slot after it (for example a tier with one cheap slot only) is always required: the rule never leaves a tier with fewer required approvals than one strong slot, and never with none.

**Replay bench** (`bench.ts`). A bench run replays the cheap reviewer on heads the strong reviewer already reviewed:

1. Cases: the newest strong reviews with `request_changes` and medium+ findings (positive cases) plus strong approvals (negative cases, one per three positives), each a (PR, head) whose head is still reachable on the host, at most `bench_max_cases`.
2. Cases run **one at a time**. For each, Lair starts a cheap reviewer run with the same prompt file, `{findings_bank}` as it would have been at that head (only findings recorded before the case's strong review), `{bench} = yes` (NEW placeholder, `no` otherwise; the template tells the reviewer to read only `git diff <base>...<head>` at the given head and not the PR page, its body or later commits), task id `bench-<run8>-<pr>-<head8>`, and a bench token in its environment (only its hash is stored, on the case row).
3. The run posts with `lair review submit`; with `LAIR_REVIEW_BENCH=1` in its environment the CLI posts to NEW route `POST /api/review/bench/cases/:case/review`, which accepts only that case's token, only while its run is active, once. It does not check whether the PR is open (merged PRs are the usual case) and records the result on the case, never as a review: it fills no slot and blocks nothing.
4. Score: recall = strong medium+ distinct findings of the positive cases matched (§4.1) by any cheap finding / all of them. Also recorded: per-severity recall, cheap medium+ findings with no match (noise), negative cases the cheap reviewer sent back.
5. A case whose run ends without a review or passes `bench_case_timeout_minutes` (its run is stopped) is `no_result` and counts as **matched nothing**, so a flaky reviewer can't pass by timing out.
6. Before each case Lair reads the run's spend so far from `agents_spend` (its task ids); it starts no case once spend plus the most expensive case so far would pass `bench_max_usd` (cases are sequential, so the overshoot is at most one case's cost). The owner can stop a run.

NEW tables (their own schema version, PR 5): `review_bench_runs(id, project, reviewer_id, model, prompt_sha, recall_bar, line_window, cases, state running|done|stopped, recall, matched, expected, noise, cost_usd, started_at, ended_at, started_by)` and `review_bench_cases(id, run_id, pr, head_sha, state pending|running|done|no_result, token_hash, agent_run_id, started_at, findings JSON, matched JSON, cost_usd)`, unique `(run_id, pr, head_sha)`. Rows older than 180 days are deleted by the daily job (§4.0). A restart resumes: a `running` case is followed by its `agent_run_id` as the assigner follows a review run (done, or `no_result` when the run ended without a review or the timeout passed); the next `pending` case starts only after that; a case moves `pending -> running` in one guarded statement, so it never starts twice.

Owner-only `POST /api/review/bench/runs` body `{reviewer: <cheap id>}` starts a run (it spends money; 409 while another run of the project is running; 400 for a reviewer not in `cheap_reviewers`). Owner-only `POST /api/review/bench/runs/:id/stop`. `GET /api/review/bench/runs?project=` (read).

**Stage rule** (`pre_review: on`): a pre-review slot is **required** only when the newest `done` bench run for its reviewer has `cases >= bench_min_cases`, `recall >= recall_bar`, and its `prompt_sha` and `model` equal the current ones. Otherwise it is **advisory**: still asked, its review shown, a `request_changes` from it still blocks the merge, but it is not counted as missing and the strong slot's `earlier_slots` does not wait on it. The PR status says why (`cheap stage advisory: recall 0.42 < 0.6 (bench run <id>)`, or `not measured for this prompt and model`). With `observe`, the status shows the outcome and the slot keeps its configured behaviour.

### 4.5 Layer 4a: the strong reviewer once per fix round (NEW)

**Sticky reviewer** (`sticky: on`). When a strong slot is asked at a new head and a strong reviewer reviewed this PR at an earlier head, `candidates()` (`agent-assigner.ts:352`) puts that reviewer first, unless its run already ended without a review at this head (then the existing "tried last" order, `:460`, wins). If it is busy, the slot waits until `sticky_wait_minutes` after the request round's `requested_at` (stored today), shown as `waiting for <id>, the previous round's reviewer`; then any free candidate is used. If it no longer qualifies (removed from the pool, now shares a model with the author), it is skipped and the reason is shown. After `fresh_read_after_rounds` strong reviews on the PR, or when the owner asks for a fresh read, stickiness and delta are off for the next strong round. The owner's request is NEW field `fresh: true` on the owner-only `POST /api/review/prs/:number/request-reviews`; it stores `review_prs.fresh_head` = the current head (so it survives a restart and a request that joins a running round), and the flag is used by the next strong round at that head and then cleared.

**Delta re-review** (`delta: on`). A strong review at head B after a strong review at head A of the same PR is a delta review when A is an ancestor of B (`compare(A, B).behindBy = 0`), the diff A...B is at most `delta_max_lines` changed lines (NEW: the host port's `compare` also returns the changed-line total and whether its file list was truncated; a truncated list counts as too large), and it is not a fresh read. NEW placeholders:

- `{review_mode}`: `full`, `delta` or `conditions` (§4.6).
- `{previous_head}`: A's full sha (shape-checked), or `(none)`.
- `{previous_findings}`: every finding of the previous strong review, each `id, severity, file:line, [class], text`, in a fenced data block like the bank (at most 60 items and `bank_max_bytes`), or `(none)`.
- `{settled_files}`: the files settled at A (below), in a fenced data block; only paths matching `^[A-Za-z0-9._/@+-]{1,300}$` are listed (a path with any other character is simply not settled and gets reviewed), or `(none)`.

The delta reviewer reviews the diff A...B and re-checks each previous finding. It reports each previous finding's state with NEW `lair review submit --resolutions-file <file>`, lines `<finding-id>: fixed | open | not_reproduced[: note]`. The route accepts a resolutions file only from a strong review whose assignment is in delta mode; it must list **every** finding of the previous strong review, each once, and only those ids (400 otherwise: missing, unknown, another PR's or repeated). It writes `status = resolved`, `resolved_by` = the new review id and `resolution` = the state for `fixed` and `not_reproduced` (the #354 resolution states, through `store.ts:628`, which changes only `open` rows). An `open` previous finding must also be in the new review's findings (400 otherwise), so a finding the reviewer still sees never disappears with the superseded review (`service.ts:409-414`). The review records `mode` and `previous_head`. When A is not an ancestor, the diff is too large or truncated, or the compare fails or times out, the round is a full read and the status says why. The owner's manual resolution (`routes.ts:316`) is unchanged.

**Per-file convergence.** A file is **settled** at a strong review when that review has no medium+ finding on it. At the next delta round, `{settled_files}` lists the files settled at A that A...B does not touch; the prompt asks the reviewer not to re-read them. A settled file that A...B changes is unsettled again (its changed hunks are in the delta). Settled is computed from stored findings; nothing new is stored.

**Split recommendation** (`split_hint: on`). After `split_after_rounds` strong rounds, if more than `split_min_files` files carry open medium+ strong findings, Lair raises one Decision Inbox notice naming the files grouped by top folder and suggesting one PR per group, unless `review_funnel_notices` has `split:<pr>` (written in the same step), so it is raised once per PR even after the owner closes it. It is a notice only: Lair posts nothing on the host and changes nothing.

### 4.6 Layer 4b: approve with conditions (NEW)

A strong reviewer may tag a medium finding `[condition]`: "this must be fixed, the fix is mechanical, and it can be verified without me".

**By switch:**

- `off`: `FINDINGS_FORMAT` does not mention `[condition]`; the tag stays text.
- `observe`: the prompt says a medium finding with a mechanical fix may be tagged `[condition]` **on `request_changes` only**, where it blocks as usual. Lair stores it `condition = proposed` and its eligibility (below). The report then shows, for each proposed condition, whether the next strong round found it fixed with no new medium+ finding on its file: that is the evidence for `on` (§6). An approval carrying `[condition]` is refused (400, `conditions are not on: use request_changes`); the reviewer's run is still active and resubmits.
- `on`: the prompt says a medium finding may be tagged `[condition]` **on an approval**; it is stored non-blocking with `condition = open` (or `ineligible`).

**Eligibility** (`conditions.ts`, checked when the review is recorded): a condition is **ineligible** when its severity is not medium, its class is `money`, `security` or `tenancy` or null, its file matches a risk rule that makes the PR red by path (`risk-rules.ts`), or #355's content signals (once built) matched a money, auth or tenancy rule in that file. In `on`, an ineligible condition is stored `condition = ineligible` and the merge condition fails at every head, so only a new strong review clears it (fail closed; the run's other findings are kept).

**Merge condition** (NEW, `merge-policy.ts`, `conditions: on`): `id: conditions`, ok only when every condition of the approving strong review that fills the slot is `met` at the PR's current head. At head H itself (the approval's own head) open conditions keep it failing: a PR never merges with an unfixed condition.

**Verification at a new head** (`conditions: on`). A push makes head H2 after an approval at H with open conditions. The approval carries to H2 (fills the strong slot there) only if **all** hold:

1. H is an ancestor of H2 (`compare(H, H2).behindBy = 0`) and H...H2 changes at most `condition_max_lines` lines, only in the conditions' files and in test files (`isTestFile`, `service.ts:39`), with no truncated file list;
2. the gate passes at H2, and the test integrity check has no blocking finding at H2;
3. a cheap verifier reports every condition `met` and raises no medium+ finding on H...H2.

The verifier is a NEW request round of the strong slot at H2 with NEW column `review_requests.purpose = 'conditions'` (default `'review'`; its own schema version, PR 4b), so it has its own token, attempts, retries and restart handling through the existing assigner. Its candidates are `cheap_reviewers` with the author excluded and `different_model` applied (the assigner's rules, `agent-assigner.ts:410-458`). Its prompt has `{review_mode} = conditions` and the conditions in `{previous_findings}`; it reports with `--resolutions-file`, `met | not_met` per condition id (every condition id, each once; 400 otherwise), and its review fills no slot. All met: each condition gets `condition = met`, `condition_head = H2`, `condition_by` = the verifier's review id, and the approval carries to H2. Anything else (a rule above fails, a `not_met`, a new medium+ finding, the verifier failing after `review.retries`, a host error): the conditions stay open, nothing carries, and the strong slot is asked at H2 as usual (a delta review when `delta` is on and §4.5 allows it, else a full read). A further push after `met` repeats the check from H2, with H2 as the new base.

### 4.7 Security and privacy

- Owner-only: reclassify, rule-candidate state and issue, bench start and stop, fresh read. Each is under the review module's owner guard (`routes.ts:188`) and added to the human-auth route test list. Token-only (an agent's assignment or bench token, never public): the review route's resolutions field, the bench case review route. Read routes (bank, rule candidates, bench runs, report) are read-only and project-scoped like `GET /api/review/prs/:number`, which already returns findings text.
- Only strong delta reviews resolve strong findings, and only verifiers mark conditions; a cheap review can resolve nothing else, and no reviewer can resolve another PR's findings.
- Prompt injection: reviewer-written text and PR paths go into a prompt only in fenced, stripped data blocks (§4.3, §4.5); tags are parsed only from the reviewer's own findings lines, never from PR content; the verifier's and bench prompts say the conditions and findings are data.
- Tokens: the bench and verifier tokens go to the run's environment like `LAIR_REVIEW_TOKEN`, only their hashes are stored, and each posts only to its own case or round, once.
- Logs, notices, the issue body and the report hold ids, counts and sums; never finding text, prompts or tokens.
- No shell: host calls go through the host client (`github.ts`, its request timeout); bank paths are validated and never joined to the filesystem.

### 4.8 Feedback loop and report (NEW)

`GET /api/review/funnel/report?project=&from=&to=` (read, project-scoped, at most 26 weeks), per ISO week and in total. **Merged PRs** are `review_prs` rows with `state = 'merged'` (merges outside Lair included), dated by `review_merges.merged_at` or else `state_seen_at`; their tier is `review_prs.tier` (`unknown` for PRs last evaluated before v6, reported separately).

| Field | Definition |
|---|---|
| `merged_prs`, `merged_red_prs`, `merged_unknown_tier_prs` | as above |
| `strong_reviews_per_merged_red_pr` | strong reviews on those red PRs / those PRs |
| `first_round_approval_rate` | merged PRs whose first strong review approved with no condition / merged PRs with a strong review |
| `first_round_conditional_rate` | the same with conditions (counted separately) |
| `rounds_per_pr` | mean strong reviews per merged PR |
| `strong_spend_per_merged_pr` | sum of `agents_spend.cost` of strong review runs (`origin = review`, agent in `strong_reviewers`, `pr` in the merged set) / merged PRs; `null` where any cost is unknown, never 0 |
| `bench_recall` | newest bench run's recall, prompt sha and model |
| `live_recall` | on live PRs: strong medium+ distinct findings at a head the cheap reviewer approved (misses) vs strong findings the cheap reviewer had raised at an earlier head (catches), matched by §4.1 |
| `delta_reviews`, `full_reviews`, `fresh_reads`, `sticky_hits`, `sticky_fallbacks` | counts |
| `conditions_proposed_fixed_next_round`, `conditions_met`, `conditions_not_met`, `conditions_ineligible` | counts |
| `tagged_share` | strong medium+ findings with a class / all |
| `rule_candidates` by state, `rule_misses` | counts |
| `escapes_per_merged_pr` | from #354's escape records; `"not measured"` until #354 is built |
| `switches` | the `review_funnel_switches` rows in the range |

Daily job (§4.0): when `escapes_per_merged_pr` over the last 2 weeks is above the 4 weeks before the first `on` in `review_funnel_switches`, one Decision Inbox notice is raised unless `review_funnel_notices` has `escapes:<iso-week>`. It recommends switching `conditions` and `pre_review` back to observe; it switches nothing itself. The dashboard's review page gets a "Funnel" panel with the last 4 weeks against the targets and the unclassified findings list.

### 4.9 Reliability

- Every host call (compare, issue, PR files) has the host client's timeout; a timeout is a failure: delta falls back to a full read, a condition does not carry, an issue stays pending (no second issue), the bank is `(unavailable)`.
- Bench: one run per project, cases one at a time, a case never starts twice, a timed-out case matches nothing and its run is stopped, the money cap is checked before each case, restart resumes.
- Sticky wait is bounded by `sticky_wait_minutes` from the round's stored request time; the verifier uses the assigner's retries and backoff (`review.retries`), then fails closed.
- Idempotency: tag columns and rule-candidate upserts are written in the review's own transaction; notices are recorded in `review_funnel_notices` before raising (a restart between the two loses at most one notice, never doubles it); the issue route uses a pending record and a marker; resolutions change only `open` rows.
- Sizes: bank and previous-findings caps; resolutions file at most 200 lines; `finding_ids` capped at 200; report range at most 26 weeks.

## 5. Acceptance tests

Part A (classification, matcher, store, report base):
- **AT-A1 `parses class, check and condition tags`:** given `src/a.ts:4: medium: [retries] [check:retry-has-cap] text`, when parsed, then class `retries`, check `retry-has-cap`, text `text`.
- **AT-A2 `an unknown class tag stays text`:** `[speed] slow` gives class null and text `[speed] slow`; an untagged line parses exactly as on main.
- **AT-A3 `migrates every older store to v6`:** v1, v4 and v5 files with findings open; old rows have null class, stage, mode, prompt sha and tier; the version is 6.
- **AT-A4 `owner reclassifies a finding`:** owner session: 200, class, `class_by`, `class_at` stored; no session: 401/403; another project's id: 404; unknown class: 400.
- **AT-A5 `matcher matches by file, line window and class`:** window 10: same file at +10 matches, +11 doesn't; different classes don't; one null class matches on file and line; null line matches only null line.
- **AT-A6 `only Lair-started agent reviews count as strong`:** a review through an assignment of a strong reviewer's run: `stage = strong`; an owner review named like a strong reviewer: `stage = null`, absent from the bank and the report.
- **AT-A7 `report counts rounds and first-round approvals`:** given 3 merged red PRs with 1, 2 and 3 strong reviews (the first approved, the others' first rounds not), then `rounds_per_pr` 2.0, `first_round_approval_rate` 1/3, `strong_reviews_per_merged_red_pr` 2.0; one PR whose run has no cost makes spend `null`; a PR merged outside Lair (`state = merged`, no `review_merges` row) is counted.
- **AT-A8 `observe changes no prompt`:** with every part `observe`, the filled prompt of a review equals the one with every part `off`, and the PR status carries a `funnel` entry per part.
- **AT-A9 `funnel config refuses bad values`:** overlapping reviewer lists, `bench_max_cases < bench_min_cases`, classes without `money`, `conditions: on` without #354's escape records: refused with the key named (each key's check ships in the PR that adds the key).

Part B (bank):
- **AT-B1 `bank lists same-file findings first, then same-folder, newest first`:** given strong medium findings on `src/x/a.ts` (PR 1, older), `src/x/a.ts` (PR 2, newer), `src/x/b.ts` (PR 3), a low on `src/x/a.ts`, a cheap reviewer's medium on `src/x/a.ts`, a dismissed one, a `not_reproduced` one and one on the PR itself, when the bank is built for a PR changing `src/x/a.ts`, then the items are PR 2, PR 1, PR 3 in that order and nothing else.
- **AT-B2 `bank respects item and byte caps on an item boundary`:** 40 findings with `bank_max_items` 30 gives 30; with `bank_max_bytes` 1024 the block ends on a whole item and is at most 1024 bytes.
- **AT-B3 `bank text is fenced and stripped`:** a finding text with backticks, `{pr}` and a newline arrives as one line inside the fence, `{pr}` not expanded.
- **AT-B4 `{findings_bank} is (none) unless bank is on`**, observe shows the would-be text in the PR status, and a host timeout on the file list gives `(unavailable)` and the route 502.
- **AT-B5 `bank route refuses bad paths and other projects`:** `..`, absolute, 201 paths: 400; another project's PR: 404.
- **AT-B6 `a builder run for a PR task gets the bank`:** a fill run whose task line names open PR #7 has the bank for #7's files after its prompt files; a task naming no PR gets the `lair review bank` line; with `bank: off` neither.

Part C (sticky, delta, settled, split hint):
- **AT-C1 `re-review goes to the previous round's strong reviewer`:** pool `[s1, s2]`, s2 reviewed head A; at head B s2 is asked, not s1.
- **AT-C2 `sticky waits then falls back`:** s2 busy: the slot waits with the reason; at `sticky_wait_minutes` after the round's request (fake clock) s1 is asked; s2 removed from the pool: s1 at once, with the reason.
- **AT-C3 `fresh read after N rounds or on request`:** the 5th strong review (default 4) is a full read and not sticky; the owner's `fresh: true` makes the next strong round full and not sticky, also after a restart and when it joins a running request; the flag is then cleared.
- **AT-C4 `delta prompt carries previous head, findings and settled files`:** given a strong review at A with a medium on `a.ts` and none on `b.ts`, and B touching only `a.ts`, then `{review_mode}` is `delta`, `{previous_head}` A, `{previous_findings}` the medium, `{settled_files}` `b.ts`.
- **AT-C5 `delta falls back to a full read`:** A not an ancestor, the diff over `delta_max_lines`, a truncated compare file list, or a compare timeout: `full`, with the reason in the status.
- **AT-C6 `resolutions are accepted only complete and only from a strong delta review`:** `fixed` and `not_reproduced` resolve with the new review id; a missing previous id, an unknown or another PR's id, a repeated id: 400; `open` not repeated in the findings: 400; a cheap review or a full-mode strong review sending a resolutions file: 400; a second identical submit is refused by the token rule and changes nothing.
- **AT-C7 `a file with only lows is settled; touching it unsettles it`:** a review at A with a low on `c.ts` and a medium on `a.ts`: `c.ts` settled; B changes `c.ts`: it is not in `{settled_files}`.
- **AT-C8 `settled paths are fenced and filtered`:** a settled file named with a backtick and `{pr}` is not listed and is reviewed.
- **AT-C9 `split hint once per PR`:** after round 3 with 6 files carrying open mediums: one notice; the owner closes it and round 4 runs: no second notice; 5 files: none.
- **AT-C10 `sticky and delta observe change nothing`:** with `observe`, pool order and a full prompt are used and the status shows the would-be reviewer and mode.

Part D (conditions):
- **AT-D1 `observe stores proposed conditions on request_changes and refuses them on approvals`:** a `[condition]` medium on request_changes: `proposed`, blocking; the same on an approval: 400.
- **AT-D2 `a verified medium condition carries the approval`:** approval at H with one eligible condition on `a.ts`; push H2 changing 3 lines of `a.ts` and its test; gate passes, integrity clean, the verifier (not the author, different model) reports `met`: the slot is filled at H2, the condition `met` with `condition_head` H2, no strong run starts.
- **AT-D3 `the approval does not carry when any check fails`:** each of: `not_met`; a missing condition id; a new medium finding by the verifier; the gate failing at H2; the verifier timing out after its retries; H not an ancestor of H2; H...H2 over `condition_max_lines`; a change to a file outside the conditions' files and tests: the strong slot is asked at H2.
- **AT-D4 `ineligible conditions block until a new strong review`:** a high, a `money`, `security`, `tenancy` or unclassified condition, or one on a red-path file: `ineligible`, the merge condition fails at H and at every later head until a strong review without it fills the slot.
- **AT-D5 `a PR never merges at the approval's own head with an open condition`:** approval at H with an open condition: the merge condition fails at H.
- **AT-D6 `the verifier is never the author`:** the only free cheap reviewer is the PR's author: no verifier is started, the slot is asked as a strong review.

Part E (bench and stage rule):
- **AT-E1 `bench replays the cheap reviewer and scores recall`:** 4 positive cases with 5 strong medium+ findings, the cheap reviewer matches 3: recall 0.6; its results are not reviews and fill no slot; merged PRs are accepted.
- **AT-E2 `a timed-out case matches nothing and its run is stopped`.**
- **AT-E3 `bench stops before the money cap and resumes after restart`:** cases cost 3, 4; cap 10: the third case does not start (7 + 4 > 10); a restart with one case `running` follows it and starts nothing twice.
- **AT-E4 `bench routes are owner-only, one at a time, and the case token is its own`:** start without the owner: 401/403; a second start: 409; a case's token posting to another case or twice: 403.
- **AT-E5 `a pre-review slot is required only above the bar for the current prompt and model`:** recall 0.65 on 20 cases: required; recall 0.55, 19 cases, a changed prompt file, or a changed model: advisory, the strong slot does not wait on it, its `request_changes` still blocks, and the status says why.
- **AT-E6 `a cheap slot with no strong slot after it is never advisory`:** a tier with one cheap slot and no bench run: the slot is required.

Part F (rule candidates, report completion):
- **AT-F1 `a check slug becomes a candidate at 3 distinct findings on 2 PRs, with one notice`:** 2 findings on PR 1, the second repeating the first in a delta round, and 1 on PR 2: count 2, no notice; one more on PR 2: count 3, one notice; the owner closes it and a 4th finding arrives: no second notice.
- **AT-F2 `opening a candidate's issue is owner-only and happens once`:** no session: 401/403; first call creates one issue with the marker and no finding text; a second call: 409 with the number; a timeout after the host created it, then a retry: the marker search finds it, no second issue; two concurrent calls: one 409.
- **AT-F3 `a built candidate's later finding counts as a rule miss`:** state `built`, then a strong finding with that slug: `rule_misses` 1.
- **AT-F4 `escape notice when escapes rise, once per week`:** with #354's records showing 2 weeks above the 4 weeks before the first `on`: one notice; the next day: none; with #354 absent: `not measured` and no notice.

## 6. Rollout

Every switch ships `off`. Per part: set `strong_reviewers` and `cheap_reviewers`, switch the part to `observe` for one week, read the PR status `funnel` field and the report, then `on`. Order and evidence to switch on:

1. `bank` and `rule_candidates`: on after observe shows the bank under the caps on real PRs.
2. `sticky` and `delta`: on after observe shows the would-be sticky reviewer available on most re-reviews and delta fallbacks under one in three.
3. `pre_review`: run a bench first; on only when it passes the bar.
4. `conditions`: on only with #354's escape records on, and after one week of observe in which at least 90 % of `proposed` eligible conditions were fixed in the next round with no new medium+ finding on their files.
5. `split_hint`: on any time.

Verify in the running stack: the report's `switches` lists each change; the PR status shows each part's state. Rollback: set the part back to `observe` or `off`; nothing it wrote needs undoing (tags and resolutions stay as records; with `conditions` off the merge condition is gone and open conditions are ignored, so an approval with conditions no longer carries across heads).

## 7. PR split

Each PR <= 600 changed non-test lines, builds, is wired and merges alone (none stacked on another's branch), observe before act. A PR that adds tables or columns takes the next free store version when it merges.

| PR | Content | ATs | Store | Needs from #354 / #355 |
|---|---|---|---|---|
| 1 | §4.0 config (keys for the parts it ships) and `stage`, §4.1 tags, matcher, reclassify route, report base (rounds, first-round rate, spend, tier) | A1-A9 | v6 | none; #354 then reuses `match.ts` |
| 2 | §4.3 bank: placeholder, builder brief, route, CLI, fencing | B1-B6 | none | none |
| 3a | §4.5 sticky, fresh read, split hint | C1-C3, C9, C10 | `fresh_head` is in v6 | none |
| 3b | §4.5 delta, settled files, resolutions file, `compare` line total | C4-C8 | none | writes #354's resolution states (`fixed`, `not_reproduced`); if #354 lands first, 3b uses its writer |
| 4a | §4.6 tags by switch, eligibility, merge condition | D1, D4, D5 | none | #355's content signals for eligibility when built; path rules until then |
| 4b | §4.6 verifier round, carry to the new head | D2, D3, D6 | next (`review_requests.purpose`) | `conditions: on` needs #354's escape records |
| 5 | §4.4 bench tables, runs, case route, scoring, stage rule | E1-E6 | next (bench tables) | none |
| 6 | §4.2 rule candidates and issue, §4.8 live recall, escapes and notice, dashboard Funnel panel | F1-F4 | next (rule candidates) | #354's escape records for `escapes_per_merged_pr` |

If PR 5 or 6 passes 600 lines it splits again (5: tables, runs and scoring / stage rule; 6: rule candidates / report and dashboard), each part with its ATs.

## 8. Open risks

- **The strong reviewer does not tag.** Classes and conditions depend on it following the format. The report's `tagged_share` shows it per week; the owner reclassifies from the dashboard; the prompt template is the owner's to change.
- **Delta reviews miss interactions** between changed and settled files. Mitigation: fresh read after N rounds, escapes tracked by #354; the escape notice says when to step back.
- **Bench heads unreachable** (a force-push or a deleted branch): such cases are skipped and counted; too few cases keeps the stage advisory.
- **Bench leakage and overfit:** a replayed reviewer may still find a merged PR's later fixes, which inflates recall. The `{bench}` prompt narrows what it reads; live recall (§4.8), which can't leak, is shown next to bench recall, and a gap between them is the signal.
- **Conditions let a real defect through.** Mitigations: medium only, sensitive classes, unclassified findings and red paths excluded, a size and file bound on the fix, gate and integrity at the new head, an independent verifier, #354's escapes required, the escape notice.
- **Schema collision** with another review-store change: each PR takes the next free version at merge and the migration test covers every older version.
