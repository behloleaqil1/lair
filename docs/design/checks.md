# Checks: agents test on a runner before they gate

Goal: agents need a cheap, fast, bounded way to run THEIR tests on a runner before they submit a gate. Each project
defines what a check runs, so it must not be a project script. The project's command runs for now; when cloud runners
(cloud-runners.md) exist, the module switches to the `cloud` executor behind the same config.

## Why
Measured on one project from 25 to 29 Oct:
- About 1 gate in 10 passes.
- Agents may only compile before gating, because tests on the loaded developer machine take ~15 min (median).
- The same targeted tests take ~2.5 min on a cloud machine.

Every bug is found by a gate that takes hours. Agents need a way to test before they gate.

## Model
A **check** is a bounded test run requested by an agent:
- `kind`: a named check type (e.g. `backend-targeted`), configured per project
- `tests`: a validated selector (test class names, patterns)
- `sha`: the commit to test (40 hex characters)
- `branch`: the branch the sha is pushed to (required)

The server builds and runs the project's **command** with substituted placeholders, never a shell string, in the
project's repository. The agent gets back: status, duration, failing test names (from JUnit XML), and the last 40
lines of output.

## Security
1. **Agents never pass a command**, only a kind and validated selectors. The argv is built by the server and run
   without a shell, in its own process group.
2. **Selectors are validated** against an allowlist pattern (`^[A-Za-z0-9_.*#]+$` by default) and forbidden patterns
   (`;`, `$(`, space, `/`, `..`). Count and total length are bounded. The project's pattern runs with a 100 ms limit
   (a pattern that backtracks without end refuses the request instead of stalling the server).
3. **Tokens are never logged or echoed** in results, and Lair's tokens are removed from the command's environment.
4. **The run must be running.** The bus token proves the agent and run; the agents module must also have that run
   running for that agent. A token that was never revoked is not enough.
5. **One branch per run.** A branch is required and validated (git ref rules: no `..`, no leading `-`, no `.lock`,
   ...). A run's first accepted check fixes its branch; a later request from that run for another branch is refused.
6. **The sha must be pushed.** It must be on `refs/remotes/<remote>/<branch>` (`remote` per kind, default `origin`).
   When it is not, the branch is fetched once from the remote and checked again. Every git call has a timeout, and a
   timeout or git error refuses the request.
7. **Results are data.** The log tail and test names are cleaned (code fences and tag-like markup neutralised). This is
   cosmetic, not a prompt fence: whatever puts a result into a prompt (the bus tool, a follow-up) wraps it as data.
8. **One agent can't read another agent's check results.** `GET /api/checks/:id` answers the token of the run that
   asked, or the owner's session. The list and the counts answer the owner's session only.

## Exit codes
- **0**: pass
- **1**: test failures (failing test names parsed from JUnit if configured)
- **2**: the command refused its input: reported as `refused`
- **3**: infrastructure error: the guard runs again, the command is retried once, then reported as `infrastructure`
- **4**: refused by the money guard: reported as `guard`
- Any other exit or a signal: `fail`. A timeout stops the command's whole process group: `timeout`.

## Configuration
```yaml
checks:
  backend-targeted:
    command: ["./run-tests.sh", "{sha}", "{tests}"]
    remote: origin
    tests:
      pattern: "^[A-Za-z0-9_.*#]+$"
      max_count: 50
      max_length: 5000
    timeout_seconds: 300
    max_concurrent: 2
    max_per_agent_per_hour: 10
    parse:
      junit_path: test-results/TEST-*.xml
    budget:
      daily_limit: 100
      guard_cmd: ["./check-spend.sh"]
```

### Placeholders and environment
- `{sha}`: the commit SHA (`CHECK_SHA`)
- `{branch}`: the branch name (`CHECK_BRANCH`)
- `{tests}`: the validated tests joined by space
- `{agent}`: the agent ID (`CHECK_AGENT`)
- `{check_id}`: the check ID (`CHECK_ID`)
- `{output_dir}`: the check's own output directory (`CHECK_OUTPUT_DIR`); `parse.junit_path` is relative to it, and its
  file name may be a glob (`*`, `?`)
- `CHECK_RETRY=1` is set on the infrastructure retry

## API

### POST /api/checks
Request a check. Requires the run's bus token in `Authorization: Bearer <token>`.

```json
{
  "kind": "backend-targeted",
  "sha": "<40 hex characters>",
  "branch": "feat-search",
  "tests": ["TestClassA", "TestClassB"]
}
```

Returns `201` with `{ "id": "..." }` on success; 400 for a bad request (unknown kind, selector, branch), 401 for a
missing or unknown token, 403 for a run that is not running, another branch or an unpushed sha, 429 for a limit, and
404 when the project has no `checks:`.

### GET /api/checks/:id?wait=600
Get a check's result, with the token of the run that asked (or the owner's session). With `?wait=N`, long-polls up to
N seconds for completion.

Returns:
```json
{
  "id": "0123456789abcdef",
  "status": "pass",
  "durationMs": 45000,
  "failingTests": [],
  "logTail": "..."
}
```

### curl example
```bash
CHECK_ID=$(curl -s -X POST "$LAIR_URL/api/checks" \
  -H "Authorization: Bearer $LAIR_BUS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"kind":"backend-targeted","sha":"'"$SHA"'","branch":"feat-search","tests":["TestA"]}' \
  | jq -r '.data.id')

# Long-poll for the result (the same token)
curl -s "$LAIR_URL/api/checks/$CHECK_ID?wait=600" -H "Authorization: Bearer $LAIR_BUS_TOKEN"
```

### Owner routes
- `GET /api/checks?kind=&agent=&sha=&status=&limit=`: the checks, newest first
- `GET /api/checks/stats`: counts by status and by kind

## Limits, retention and restarts
- **Per agent:** `max_per_agent_per_hour` accepted checks per kind; at most 100 refused requests an hour (past that,
  nothing more is written for that agent until the hour has passed).
- **Per kind:** `max_concurrent` running at once (fair FIFO; the rest wait queued); `budget.daily_limit` accepted
  checks per UTC day. Refused requests never use the hourly limit or the daily budget.
- **The guard** (`budget.guard_cmd`) runs before every run and before the infrastructure retry, in the repository, with
  a 30 s limit; any exit but 0, a timeout or an error ends the check as `guard` (fail closed).
- **Output:** stdout and stderr are each kept as a rolling tail of at most 1 MB while the command runs; the stored log
  tail is the last 40 lines. JUnit files are read at most 2 MB each, 8 MB and 100 files in total.
- **Retention:** finished checks older than 14 days are deleted, and the oldest beyond 10,000 (never one from the last
  25 hours, which the limits read), with their audit entries and output directories. The prune runs at start and
  hourly, never on a request. Queued and running checks are never pruned.
- **Restart:** at start, checks a previous server left running are recorded as `infrastructure` ("server restarted")
  and the queue runs again. On shutdown, running checks are recorded as `infrastructure` ("server stopping"), their
  process groups are stopped, and the store closes only after the work in flight has ended.
- Changing `checks:` takes effect at the next restart (the live reload does not include this module yet).

## How it moves to the cloud executor
Today the check runs the project's command on the Lair server. When cloud runners (cloud-runners.md §1–3) exist:

1. A check kind can name an `executor: cloud` (or a machine).
2. The service routes the job to the `cloud` executor, which starts the machine, pushes the sha, runs the command
   there, and brings the results back.
3. The API stays the same; agents notice only faster results and lower load on the developer machine.

The configuration gains `executor: cloud | local | auto` per kind (default `auto`: use cloud when available and the
machine is idle, otherwise local).

## Visibility
- **Every request is audited**, including refusals (bad selector, branch, sha, rate limit) and guard refusals.
- The owner routes above serve the Work view's checks list and the Health counts; the dashboard views are a follow-up.

## Follow-ups
- The bus tool `check` and a `lair check` CLI (wrapping a result as a data block for prompts).
- The Work view list and the Health counts in the dashboard.
- `require_before_gate` (observe only): record whether a gate's sha had a passing check of a kind.
- `max_concurrent` per project (today per kind), and the live reload of `checks:`.

## Build order
This module is one PR. It builds on:
- `src/server/bus/` (tokens for identity)
- `src/server/agents/` (runs)
- The project configuration loader

It does not depend on cloud runners; that integration is a later PR.
