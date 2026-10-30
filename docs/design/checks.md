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
- `sha`: the commit to test
- `branch`: the branch name (optional)

The server builds and runs the project's **command** with substituted placeholders—never a shell string. The agent gets
back: status, duration, failing test names (from JUnit XML), and a fenced log tail.

## Security
1. **Agents never pass a command**, only a kind and validated selectors. The argv is built by the server.
2. **Selectors are validated** against an allowlist pattern (`^[A-Za-z0-9_.*#]+$` by default) and forbidden patterns
   (`;`, `$(`, space, `/`, `..`). Count and total length are bounded.
3. **Tokens are never logged or echoed** in results. The bus token binds the check to an active run.
4. **SHA validation**: a check for a sha not on a pushed branch of the task's repository is refused.
5. **Results are data**: log output is fenced (backticks replaced, tags sanitized) before it reaches a prompt.
6. **One agent can't read another agent's check results** unless the owner can (all checks are listed for the owner).

## Exit codes
- **0**: pass
- **1**: test failures (failing test names parsed from JUnit if configured)
- **3**: infrastructure error (retried once, then reported as `infrastructure`)
- **4**: refused by the money guard

## Configuration
```yaml
checks:
  backend-targeted:
    command: ["./run-tests.sh", "{sha}", "{tests}"]
    tests:
      pattern: "^[A-Za-z0-9_.*#]+$"
      max_count: 50
      max_length: 5000
    timeout_seconds: 300
    max_concurrent: 2
    max_per_agent_per_hour: 10
    parse:
      junit_path: build/test-results/test/TEST-*.xml
    budget:
      daily_limit: 100
      guard_cmd: ["./check-aws-spend.sh"]
```

### Placeholders
- `{sha}`: the commit SHA
- `{branch}`: the branch name
- `{tests}`: the validated tests joined by space
- `{agent}`: the agent ID
- `{check_id}`: the check ID

## API

### POST /api/checks
Request a check. Requires the bus token in `Authorization: Bearer <token>`.

```json
{
  "kind": "backend-targeted",
  "sha": "abc123...",
  "branch": "kiro/feature",
  "tests": ["TestClassA", "TestClassB"]
}
```

Returns `201` with `{ "id": "..." }` on success.

### GET /api/checks/:id?wait=600
Get check result. With `?wait=N`, long-polls up to N seconds for completion.

Returns:
```json
{
  "id": "abc12345",
  "status": "pass",
  "durationMs": 45000,
  "failingTests": [],
  "logTail": "..."
}
```

### curl example
```bash
curl -X POST http://127.0.0.1:4777/api/checks \
  -H "Authorization: Bearer $LAIR_BUS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"kind":"backend-targeted","sha":"abc123...","tests":["TestA"]}'

# Long-poll for result
curl "http://127.0.0.1:4777/api/checks/$CHECK_ID?wait=600"
```

## How it moves to the cloud executor
Today the check runs the project's command on the Lair server. When cloud runners (cloud-runners.md §1–3) exist:

1. A check kind can name an `executor: cloud` (or a machine).
2. The service routes the job to the `cloud` executor, which starts the machine, pushes the sha, runs the command
   there, and brings the results back.
3. The API stays the same; agents notice only faster results and lower load on the developer machine.

The configuration gains `executor: cloud | local | auto` per kind (default `auto`: use cloud when available and the
machine is idle, otherwise local).

## Visibility
- **Checks list on the Work view:** agent, kind, sha, status, duration, links to logs.
- **Counts on Home → Health:** total checks, by status, by kind.
- **Every request is audited**, including refusals (bad selector, rate limit, guard).

## Gates and checks (optional, observe only)
When configured:
```yaml
checks:
  backend-targeted:
    ...
gates:
  require_check_before_gate:
    - backend-targeted
```

A gate's sha that had no passing check of that kind is recorded but not blocked (observe mode). The data feeds the
transition to mandatory checks.

## Build order
This module is one PR. It builds on:
- `src/server/bus/` (tokens for identity)
- `src/server/agents/` (runs, claims)
- The project configuration loader

It does not depend on cloud runners; that integration is a later PR.
