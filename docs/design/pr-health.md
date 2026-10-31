# PR health detector

- **Status:** Draft
- **Plan lines / issues:** orchestrator duties catalog D31; lesson L41 (pr-health.sh went wrong)
- **Owner questions:** none (product decisions made in L41: owner = agent whose OPEN task names the PR, not the branch author)

## 1. Problem

Today a shell script (`pr-health.sh`, stopgap) polls GitHub for every open PR across a project's repos, detects conflicts,
falling behind main, stale CI, and red CI, then appends NOTE lines to list.txt so the owning agent learns the problem.
The script runs outside Lair: no observe mode, no playbook, no dedupe across restarts, no escalation, no UI. On its first
live run it sent 15 wrong NOTEs (L41).

Lair's watchdog is the right home: it already runs detectors on a tick, records breaches, runs playbooks, escalates
unsolved problems, and shows status in the dashboard. A PR-health detector moves this behaviour into Lair, with:
- per-repo configuration (which repos, whether CI is a signal for each),
- observe mode by default,
- dedupe keyed on (repo, PR, head sha, problem kind),
- agent ownership derived from the task registry (the agent whose OPEN task names the PR, not the branch author),
- notification via the agent's task stream, not raw file writes,
- escalation through the watchdog's existing path when unfixed.

## 2. Users and stories

1. **As a project operator**, I configure which repos Lair monitors and whether CI is a signal for each, so that a billing-blocked repo's red CI is not noise.
2. **As an operator**, I enable the detector in observe mode first, see what it would report, then switch to act, so that I don't spray wrong messages.
3. **As an agent**, I receive one NOTE per (PR, head, problem) episode in my task stream, so I learn of the problem without parsing raw queue lines.
4. **As an agent or operator**, I see the NOTE withdrawn when the problem is fixed, so I know it is resolved without guessing.
5. **As an operator**, I see in the dashboard which PRs have open breaches, what the problems are, and who owns them.
6. **As an operator**, if an agent doesn't fix the PR within a config time, the problem escalates to my Decision Inbox so I can intervene.
7. **As an operator**, I can suppress a specific PR from detection (held PRs, planned merges) so that known-broken PRs don't flood notifications.

## 3. Scope

**In:**
- A new watchdog detector `pr_health` that polls GitHub for each configured repo's open PRs.
- Four problem kinds: `conflicts` (PR conflicts with base), `behind` (head is > N commits behind base), `no_ci` (no CI at head after M minutes), `ci_red` (failing CI at head). Each one is a configurable switch with its threshold.
- A per-repo `ci_signal: boolean` (defaults true; false means skip no_ci and ci_red for that repo, e.g. GitHub Actions billing blocked).
- A playbook `pr_health` that notifies the owning agent via a new `notify_agent` action, waits for fix, and escalates.
- Observe mode writes the planned notifications to the breach record but does not deliver them.
- Breach keys: `pr_health:<repo>#<number>@<head>:<kind>`, so the same (repo, PR, head, kind) is one breach.
- Owner mapping: the agent whose OPEN (non-#done) task line in the task registry mentions the PR (`#<n>` or `PR #<n>` or `lair#<n>` with word boundary, case-insensitive); if none, the branch's author pattern (`kiro/kiro-X/...`) is checked against agents with an open task. Owner discovery is deterministic; if no owner, the escalation goes to the project's inbox.
- Reuse the review module's `GitHubHost` client for fetching PR data (it already has timeouts, auth, and the `listOpenPullRequests`, `listChecks`, `compare` methods).

**Out (non-goals):**
- Watching non-GitHub hosts (GitLab, Bitbucket). The review module's `GitHost` interface is extensible, but only GitHub is built now.
- Watching PRs from the same repo (cross-repo PRs only). Reasoning: most projects have one primary repo. Leave for a follow-up if needed.
- Automatic merge or rebase (that is the review module's job; pr_health only detects and notifies).
- Custom playbooks per problem kind. One playbook covers all four; splitting adds config complexity for little gain.

## 4. Design

### Where it lives

- `src/server/watchdog/detectors/pr-health.ts` — the detector.
- `src/server/watchdog/playbooks.ts` — add the `pr_health` playbook definition.
- `src/server/watchdog/types.ts` — add `pr_health` to `DETECTOR_IDS`, add the playbook id, add the action placeholders.
- `src/server/watchdog/config.ts` — extend the `WatchdogSchema` with `pr_health:` settings.
- `src/server/watchdog/executors.ts` — add `notify_agent` executor logic.
- Integration: the detector runs on each watchdog tick; the `GitHubHost` is obtained from the review module's host factory (already in server context).

### Data model

No new tables or stores. Breaches use the existing `store.watchdog.breaches` with key `pr_health:<repo>#<number>@<head>:<kind>`. The breach `vars` holds the fields needed by the playbook:

```ts
{
  repo: string;         // e.g. "example/example-repo"
  number: string;       // PR number as a string
  head: string;         // short sha
  kind: string;         // conflicts | behind | no_ci | ci_red
  agent: string;        // the owning agent id, or "" if none
  branch: string;       // PR head branch
  base: string;         // PR base branch
  behind_count?: string; // for behind
  minutes?: string;      // for no_ci
}
```

### Interfaces

**Config (`watchdog.pr_health`):**

```yaml
watchdog:
  pr_health:
    enabled: true
    repos:
      - repo: example/example-repo
        ci_signal: true           # default: true
      - repo: example/billing-blocked
        ci_signal: false
    behind_threshold: 30          # commits behind base (default 30)
    no_ci_minutes: 20             # minutes since PR updated without CI (default 20)
    notify_timeout_minutes: 30    # wait before escalation (default 30)
    ignored_prs: []               # list of "owner/repo#123" to skip
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Enable the pr_health detector |
| `repos` | array | `[]` | List of repos to monitor; each has `repo` (owner/name) and optional `ci_signal` (default true) |
| `behind_threshold` | number | `30` | Number of commits behind base before "behind" is raised |
| `no_ci_minutes` | number | `20` | Minutes after PR update without CI before "no_ci" is raised |
| `notify_timeout_minutes` | number | `30` | Minutes to wait after notification before escalation |
| `ignored_prs` | array | `[]` | PRs to skip, as `owner/repo#123` |

**New action (`notify_agent`):**

| Placeholder | Description |
|-------------|-------------|
| `{agent}` | Agent id to notify |
| `{message}` | The notification text |
| `{pr}` | PR reference (`owner/repo#123`) |

The action command is user-configured (`watchdog.actions.notify_agent`). In observe mode, the command is recorded but not run. The default playbook step skips notification when `{agent}` is empty (no owner found).

**Route updates:** None; the breach is visible through the existing `/api/watchdog/breaches` endpoint.

### Flow

1. **Detection (on each watchdog tick):**
   - If `pr_health.enabled` is false or `repos` is empty, skip (inactive reason).
   - For each repo in `repos`:
     - Get the `GitHubHost` from the review module's host factory.
     - Call `listOpenPullRequests()` with a timeout (existing `command_timeout_seconds`).
     - For each open, non-draft PR:
       - Skip if in `ignored_prs`.
       - Fetch base branch head (`branchHead(base)`).
       - Call `compare(base_head, pr_head)` to get `behindBy`.
       - If PR's `mergeable === false`, kind = `conflicts`.
       - If `behindBy > behind_threshold`, kind = `behind`.
       - If `ci_signal` for this repo:
         - Call `listChecks(pr_head)` with a timeout.
         - If no checks and PR updated > `no_ci_minutes` ago and not draft, kind = `no_ci`.
         - If any check is `failure`, kind = `ci_red`.
       - For each detected kind, yield a finding with key `pr_health:<repo>#<number>@<short_head>:<kind>`.
   - Determine owner:
     - Read the task registry from `view.taskRegistry()` (existing method to read list.txt or equivalent).
     - Find the first OPEN line (not `#done`) whose text matches the regex for this PR (`#<n>`, `PR #<n>`, `lair#<n>` for Lair repos, `#<n>` for others, case-insensitive, word-boundary).
     - If none and PR branch matches `kiro/kiro-X/...`, look for agent `kiro-X` with an OPEN task.
     - Store result in `vars.agent`.

2. **Playbook (`pr_health`):**
   - Step 1 `diagnose`: re-run the detector logic for this PR; pass if the breach key is still present.
   - Step 2 `notify_agent`: run `notify_agent` action if `vars.agent` is non-empty; skip otherwise.
   - Step 3 `verify`: wait `notify_timeout_minutes`, then re-run detector; pass if key is gone (the agent fixed it).
   - On failure: escalate to Decision Inbox with the breach context.

3. **Failure paths:**
   - GitHub API unreachable or rate-limited: the detector throws, the tick catches it, the breach is not updated, and the SLO shows `error`.
   - PR closed between detection and playbook: diagnose step finds the breach key gone (PR no longer open), step returns `cleared`.
   - Agent not found: notify step is skipped (no agent to notify), escalation happens sooner.
   - Notification command fails: the playbook retries up to `max_attempts`, then escalates.

### Security and privacy

- The GitHub token comes from the existing review module's token source (`review.token_env` / `review.token_cmd`), sent only as an Authorization header to the configured API host.
- Breach summaries include repo name, PR number, and branch name. No secrets, no tokens.
- Logging: never log the token; log repo, PR number, problem kind. Errors log the HTTP status and a truncated message, never the response body.

### Reliability

- All GitHub API calls use the existing `GitHubHost` client, which has timeouts.
- A timeout is a failure: the detector throws, the tick's error handling applies.
- Retries: the playbook has `max_attempts` (default 2); each attempt waits for the tick interval before re-running.
- Idempotency: the same (repo, PR, head, kind) produces the same breach key; re-detection does not duplicate breaches.
- Restart: breach state is persisted in `store.watchdog.breaches`; after a restart, the detector picks up where it left off without duplicate notifications (dedupe by key).

### Observability

- Event `watchdog.finding {detector: "pr_health", key, summary}` on each finding.
- Event `watchdog.breach.opened`, `watchdog.breach.resolved` on breach state changes.
- The `/api/watchdog/status` endpoint's SLO list includes `pr_health` with state `ok`, `breached`, `inactive`, or `error`.
- Dashboard: the Watchdog view shows pr_health breaches alongside other detector breaches.

## 5. Acceptance tests

1. **AT-1 `prHealth_conflicts_detected`:** Given a PR whose GitHub `mergeable` is `CONFLICTING`, when the detector runs, then a breach with key `pr_health:<repo>#<n>@<sha>:conflicts` is opened.
2. **AT-2 `prHealth_behind_detected`:** Given a PR whose head is 35 commits behind base (threshold 30), when the detector runs, then a breach with key `pr_health:<repo>#<n>@<sha>:behind` is opened.
3. **AT-3 `prHealth_noCi_detected`:** Given a PR with no checks, not a draft, updated 25 minutes ago, `ci_signal: true`, when the detector runs, then a breach with key `pr_health:<repo>#<n>@<sha>:no_ci` is opened.
4. **AT-4 `prHealth_ciRed_detected`:** Given a PR with at least one check in state `failure`, `ci_signal: true`, when the detector runs, then a breach with key `pr_health:<repo>#<n>@<sha>:ci_red` is opened.
5. **AT-5 `prHealth_ciSignalOff_skipsNoCI`:** Given a repo with `ci_signal: false`, a PR with no checks updated 25 minutes ago, when the detector runs, then no `no_ci` or `ci_red` breach is opened.
6. **AT-6 `prHealth_ownerMapping_taskLine`:** Given a PR #42 and a task registry with line `kiro-A|Smaug|fix-bug|PR #42 red CI`, when the detector runs and opens a breach, then `vars.agent` is `kiro-A`.
7. **AT-7 `prHealth_ownerMapping_branchAuthor`:** Given a PR with branch `kiro/kiro-B/feature`, no task line mentioning the PR, task registry with open line `kiro-B|...|...`, when the detector runs, then `vars.agent` is `kiro-B`.
8. **AT-8 `prHealth_dedupeAcrossRestarts`:** Given a breach already in the store for `pr_health:<repo>#<n>@<sha>:conflicts`, when the detector runs and finds the same condition, then no new breach is opened (same key), and `lastSeenAt` is updated.
9. **AT-9 `prHealth_observeWritesNothing`:** Given `watchdog.mode: observe`, when the detector runs and the playbook runs, then the `notify_agent` command is NOT executed, and the breach record shows `plannedArgv`.
10. **AT-10 `prHealth_ignoredPrs_skipped`:** Given `ignored_prs: ["example/repo#42"]`, a PR #42 in `example/repo` with conflicts, when the detector runs, then no breach is opened for that PR.
11. **AT-11 `prHealth_playbook_escalates`:** Given a breach with no agent (`vars.agent` empty), when the playbook runs, the notify step is skipped, verify fails, max_attempts exhausted, then a Decision Inbox escalation is raised.

## 6. Rollout

1. **Config switch:** `watchdog.pr_health.enabled` defaults `false`.
2. **Observe first:** operators add repos to `pr_health.repos`, leave `watchdog.mode: observe`, and check the breaches list.
3. **Act:** set `watchdog.mode: act` and configure `watchdog.actions.notify_agent` command.
4. **Verify:** the SLO status shows `ok` or `breached`; the Activity view shows breach events; notifications reach agents.
5. **Rollback:** set `enabled: false` or remove the config block; open breaches stay for history but no new ones are detected.

## 7. PR split

1. **PR 1 (this PR, ~400 changed lines):**
   - Add `pr_health` to `DETECTOR_IDS`, `PLAYBOOK_IDS`, `ACTION_PLACEHOLDERS`.
   - Add `pr_health:` config schema and parsing.
   - Implement the detector in `detectors/pr-health.ts`.
   - Add the playbook definition.
   - Add acceptance tests AT-1 through AT-11 (faking only the GitHub API boundary).
   - Update `docs/configuration.md` with the new config keys.
   - Update this design doc to "as built".

## 8. Open risks

1. **Rate limiting:** A project with many repos and many open PRs may hit GitHub's rate limit. Mitigation: use conditional requests (ETag/If-None-Match) in a follow-up; for now, the detector runs at the tick interval (default 60 s), and each repo's PRs are fetched once per tick.
2. **Stale owner mapping:** If a task is reassigned between detection and notification, the wrong agent may be notified. Mitigation: the playbook diagnose step re-reads the task registry; if the owner changed, the old breach is cleared (different key due to head sha change on fix).
3. **False `conflicts`:** GitHub's `mergeable` field can be `null` while it computes. Mitigation: treat `null` as "unknown" and skip (do not report conflicts); rely on the tick to check again.
