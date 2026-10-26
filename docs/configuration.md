# Configuration Reference

Lair uses YAML files in the `projects/` directory to configure each monitored project. Private configurations can be placed in `projects/local/` (gitignored).

## Required fields

Every project must define these core settings:

| Key | Type | Description |
|-----|------|-------------|
| `name` | string | Display name for the project |
| `repo` | string | Path to the local repository |
| `github` | string | GitHub owner/repo (e.g., `example/example-repo`) |
| `queue_file` | string | Path to the queue/status markdown file |
| `agents_dir` | string | Directory containing agent configurations |
| `gates_dir` | string | Directory containing gate results and queue |

Example:

```yaml
name: MyProject
repo: /home/user/my-project
github: myorg/my-project
queue_file: /home/user/my-project/work/queue.md
agents_dir: /home/user/my-project/work/agents
gates_dir: /home/user/my-project/work/gates
```

## Machines

Define machines that can run agents and gates:

```yaml
machines:
  local:
    name: Workstation
    type: local
    runners:
      - heavy
      - light

  build-server:
    name: Build Server
    type: ssh
    host: 198.51.100.10
    user: deploy
    key: ~/.ssh/example_key
    connect_timeout: 4
    runners:
      - remote
    work_dir: /home/deploy/project
    sync: rsync
```

### Machine options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `name` | string | (key) | Display name for the machine |
| `type` | `local` \| `ssh` | required | How to connect to the machine |
| `runners` | array | `[]` | Gate lanes this machine handles (`heavy`, `light`, `remote`) |
| `host` | string | — | SSH hostname or IP (required for ssh type) |
| `user` | string | — | SSH username (required for ssh type) |
| `key` | string | — | Path to SSH private key (required for ssh type) |
| `connect_timeout` | number | `4` | SSH connection timeout in seconds |
| `work_dir` | string | — | Working directory on remote machine |
| `gate_script` | string | — | Path to gate script on remote machine |
| `kiro_cli` | string | — | Path to kiro-cli on remote machine |
| `sync` | `rsync` \| `git` \| `none` | `none` | Method for syncing worktrees to remote |

## Control commands

By default, Lair runs in read-only mode. Enable controls by setting `read_only: false` and defining command templates:

```yaml
read_only: false
allow_direct_assign: false

# File paths for messaging
inbox_file: /path/to/inbox.md
outbox_file: /path/to/outbox.md
backlog_file: /path/to/backlog.md

# Command bar
ask_cmd: ["/path/to/ask.sh", "{text}"]

# Orchestrator controls
tick_now_cmd: ["/path/to/tick.sh"]
pause_cmd: ["/path/to/pause.sh"]
resume_cmd: ["/path/to/resume.sh"]

# Agent controls
agent_run_cmd: ["/path/to/agent-run.sh", "{task}"]
agent_stop_cmd: ["/path/to/agent-stop.sh", "{agent}"]
agent_release_cmd: ["/path/to/agent-release.sh", "{agent}", "{task}"]

# Gate controls
gate_submit_cmd: ["/path/to/gate-submit.sh", "{track}", "{lane}", "{priority}"]
gate_stuck_cmd: ["/path/to/gate-stuck.sh", "{gate_id}"]

# Merge controls
merge_cmd: ["/path/to/merge.sh", "{number}", "{sha}"]
```

### Control options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `read_only` | boolean | `true` | Disable all write operations when true |
| `allow_direct_assign` | boolean | `false` | Allow assigning tasks directly to agents |
| `inbox_file` | string | — | Path to inbox markdown file for instructions |
| `outbox_file` | string | — | Path to outbox markdown file for replies |
| `backlog_file` | string | — | Path to backlog markdown file |
| `ask_cmd` | array | — | Command to run for ask queries. Placeholder: `{text}` |
| `tick_now_cmd` | array | — | Command to trigger an orchestrator tick |
| `pause_cmd` | array | — | Command to pause the orchestrator |
| `resume_cmd` | array | — | Command to resume the orchestrator |
| `agent_run_cmd` | array | — | Command to start an agent. Placeholder: `{task}` |
| `agent_stop_cmd` | array | — | Command to stop an agent. Placeholder: `{agent}` |
| `agent_release_cmd` | array | — | Command to release a task. Placeholders: `{agent}`, `{task}` |
| `gate_submit_cmd` | array | — | Command to submit a gate. Placeholders: `{track}`, `{lane}`, `{priority}` |
| `gate_stuck_cmd` | array | — | Command to mark a gate stuck. Placeholder: `{gate_id}` |
| `merge_cmd` | array | — | Command to merge a PR. Placeholders: `{number}`, `{sha}` |

## Merge bar

Configure the checks required before a PR can be merged:

```yaml
merge_bar:
  required_steps:
    - commitlint
    - gitleaks
    - semgrep
    - verify-backend
  require_review: true
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `required_steps` | array | `[]` | Gate steps that must pass for merge |
| `require_review` | boolean | `true` | Require review approval before merge |

## Orchestrator

Configure the orchestrator service:

```yaml
orchestrator:
  launchd_label: com.example.orchestrator
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `launchd_label` | string | — | macOS launchd service label |

The Orchestrator view checks whether this service is loaded with `launchctl`, so that status only works on macOS. On Linux, leave `launchd_label` unset; the rest of the view (ticks, STOP file) still works.

## Fleet bus

Configure the MCP fleet bus for agent communication:

```yaml
mail_dir: /path/to/mail
wake_file: /path/to/wake
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `mail_dir` | string | — | Directory for per-agent mailbox files |
| `wake_file` | string | — | File to touch to wake the orchestrator |

## Dragons (agents)

Define the AI agents available in your project:

```yaml
dragons:
  kiro-A:
    name: Smaug
    model: claude-opus-4.5
    machine: local
    adapter: kiro
    instructions: |
      Focus on backend work.

  kiro-B:
    name: Saphira
    model: claude-sonnet-4
    machine: build-server
    instructions: ""

default_instructions: |
  Follow the dragon rules. Always run quick-check before committing.
```

Each key under `dragons` is the dragon's ID. IDs start with a letter, contain only letters, digits, `_` and `-`, end with a letter or digit, and are at most 64 characters: `kiro-A`, `aider-1` and `worker_b` all work. Entries with other IDs are skipped. Log files are matched to dragons by name: `<id>.log` or `<id>-<YYYYMMDDTHHMMSSZ>.log` in `agents_dir`.

Dragons listed in `<agents_dir>/dragons.txt` (one per line: id, name, task) can be started and stopped from the dashboard too, without a `dragons:` entry. Such a dragon uses its name from `dragons.txt` and the default adapter, and has no model, machine or instructions; add a `dragons:` entry to set them. When a dragon is in both, the `dragons:` entry is used. The same ID rules apply, and `dragons.txt` is re-read on every request, so new lines need no restart.

### Dragon options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `name` | string | (agent id) | Display name for the agent |
| `model` | string | `claude-sonnet-4` | AI model ID to use |
| `machine` | string | `local` | Machine ID where this agent runs |
| `adapter` | string | `kiro` | Agent adapter ID (see [Agents](agents.md)) |
| `instructions` | string | `""` | Standing instructions for this agent |

### Dragon commands

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `dragon_start_cmd` | array | — | Command to start an agent. Placeholders: `{dragon}`, `{task}`, `{prompt_file}` |
| `dragon_stop_cmd` | array | — | Command to stop an agent. Placeholder: `{dragon}` |
| `dragon_release_cmd` | array | — | Command to release an agent's task. Placeholder: `{dragon}` |
| `default_instructions` | string | `""` | Default instructions applied to all agents |
| `prompts_dir` | string | `data/prompts` | Directory where Lair writes the prompt file it passes as `{prompt_file}`. A relative path is resolved against the directory Lair was started from |

## Available models

Define the AI models available for selection:

```yaml
available_models:
  - id: claude-opus-4.5
    name: Claude Opus 4.5
    description: Most capable, higher cost
  - id: claude-sonnet-4
    name: Claude Sonnet 4
    description: Fast and capable, lower cost
  - id: claude-haiku
    name: Claude Haiku
    description: Fastest, lowest cost
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `id` | string | required | Model identifier |
| `name` | string | (id) | Display name |
| `description` | string | — | Short description of capabilities |

If not specified, Lair provides default Claude models.

## Agent adapters

Lair ships built-in adapters for `kiro`, `aider`, `claude-code` and `cursor-agent`; only `kiro` is tested, the others are experimental. Define custom adapters, or override a built-in one by reusing its ID:

```yaml
agent_adapters:
  my-agent:
    name: My Custom Agent
    start_cmd: my-agent --prompt {prompt_file}
    stop_cmd: kill -INT {pid}
    status_method: file
    queue_file: work/queue.md
    log_dir: work/logs
```

Adapters are listed in the Settings view and each dragon names one with `adapter:` (default `kiro`). Dragons are started and stopped with `dragon_start_cmd` and `dragon_stop_cmd`, not with the adapter templates. See [Agents](agents.md#agent-adapters) for all adapter options and placeholders.

## Gate runner

> The gate runner is library code with tests; the server does not start it yet, so these options have no effect today.

Configure the built-in gate runner:

```yaml
gate_runner:
  enabled: true
  poll_interval: 5
  sync_method: rsync
  rsync_exclude:
    - node_modules
    - .git
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Enable the built-in gate runner |
| `poll_interval` | number | `5` | Seconds between queue checks |
| `sync_method` | `rsync` \| `git` \| `none` | `none` | Method for syncing to remote machines |
| `rsync_exclude` | array | `[]` | Patterns to exclude from rsync |

## Gate pipelines

A pipeline is a list of steps, each an argv command (no shell). Lair runs each **lane** of a pipeline as one job, and sends every job to the first executor in this order that can take it ([design](design/runners.md)):

1. **GitHub Actions** runners of the project's repository: an idle self-hosted runner (private repositories only), then GitHub-hosted runners (free for public repositories; for private ones only within `monthly_minutes`), then a busy self-hosted runner.
2. **lair-node machines**: not built yet, so this step is always skipped.
3. **The local machine**, once it has capacity (no memory pressure, enough free RAM, load per core below the limit). Until then the job waits.

With only a `pipelines:` block, jobs run on the local machine. Runs are started from the Gates view or with `POST /api/pipelines/runs`.

```yaml
pipelines:
  gate:
    steps:
      - name: install
        run: [npm, ci]
      - name: test
        run: [npm, test]
        timeout_minutes: 20
      - name: lint
        run: [npm, run, lint]
        lane: quick          # a separate job
    lanes:
      quick:
        executors: [local]   # this lane always runs here

executors:
  order: [github, nodes, local]
  github:
    monthly_minutes: 500     # GitHub-hosted minutes a private repository may use per month
  local:
    min_free_ram_mb: 2048
```

**Using GitHub Actions:**

1. Create a fine-grained token for the repository with **Actions: read and write**, **Contents: read** and **Metadata: read** (add **Administration: read** to use self-hosted runners) and start Lair with it in `LAIR_GITHUB_TOKEN`. The token never goes in the YAML, and local steps never see it.
2. Open the Gates view, click **Workflow file**, and commit that file to the default branch as `.github/workflows/lair-gates.yml`. It declares `permissions: contents: read`, validates its inputs, and checks out the exact commit. Copy it again after changing a pipeline: Lair skips GitHub while the committed file is missing or out of date, and says so.
3. Private repository: to run without billed minutes, register a self-hosted runner to the repository (Settings, Actions, Runners, New self-hosted runner) on a spare machine, and start it with GitHub's `./config.sh` and `./run.sh` commands. To use GitHub-hosted runners too, set `monthly_minutes`.

**Never self-hosted for a public repository.** Fork pull requests can run code on a public repository's self-hosted runners, so Lair never sends a job there, the workflow it generates for a public repository has no self-hosted option, and the status shows a warning when such runners are registered.

**Fallback.** A job GitHub refuses (billing, spending limit, Actions disabled, a workflow that fails to start), or that no runner picks up within `pickup_timeout_minutes`, is cancelled and goes to the next executor once GitHub reports that none of its steps started. The refused executor is unavailable for `unavailable_minutes` (shown, with the reason, in the Gates view). A job is never run twice: when a runner takes the job while it is being cancelled, Lair keeps that run's result. In-flight jobs resume after a server restart.

**Minutes budget.** Before sending a private repository's job to a GitHub-hosted runner, Lair adds the lane's expected minutes (the most of its last five hosted runs, at least 1) to the minutes billed this calendar month (UTC). When that would go over `monthly_minutes`, it sends nothing there, raises a `spend` decision once per month (event `decision.needed`), and uses the next executor. Billed minutes also go into the fleet budget as provider `github-actions:<project>`, in minutes.

**Results** are the same gate result whichever executor ran the job: each step's status, exit code, duration and output tail, plus where it ran, the attempts with their fallback reasons, the redacted log, CI artifacts and the minutes used. A CI run that is missing a step fails.

### Pipeline options

`pipelines.<name>` (names: letters, digits, `_`, `-`, at most 40):

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `steps` | array | required | The steps, in order |
| `timeout_minutes` | number | `120` | Time limit for each lane |
| `lanes` | map | `{}` | `<lane>: { executors: [...] }`: an executor order for that lane. Every lane named here must be used by a step |

Each step:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `name` | string | required | Letters, digits, `.`, `_`, `-`. Names starting with `lair-` are reserved |
| `run` | array | required | The argv. Arguments may not contain `${{`, newlines or control characters |
| `lane` | string | `default` | Steps of one lane run in order on one executor |
| `timeout_minutes` | number | `30` | Time limit for the step |
| `continue_on_failure` | boolean | `false` | Run the next steps even when this one fails (the job still fails) |
| `env` | map | — | Extra environment variables. Names starting with `GITHUB_`, `RUNNER_` or `LAIR_` are reserved |

### Executor options

`executors`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `order` | array | `[github, nodes, local]` | Executor kinds in order; leave one out to never use it |
| `retry_seconds` | number | `60` | While no executor can take a job, how often to try again |
| `github.repo` | string | the project's `github` | `owner/name` |
| `github.token_env` | string | `LAIR_GITHUB_TOKEN` | The environment variable that holds the token |
| `github.workflow` | string | `lair-gates.yml` | The workflow file name under `.github/workflows/` |
| `github.hosted` | boolean | `true` | Use GitHub-hosted runners |
| `github.hosted_runs_on` | string | `ubuntu-latest` | Their label |
| `github.self_hosted` | boolean | `true` | Use self-hosted runners (private repositories only) |
| `github.self_hosted_labels` | array | `[self-hosted]` | Labels a self-hosted runner must have, e.g. `[self-hosted, lair]` to keep Lair's jobs on dedicated runners |
| `github.monthly_minutes` | number | `0` | GitHub-hosted minutes a private repository may use per calendar month (0: none) |
| `github.pickup_timeout_minutes` | number | `10` | Cancel and fall back when no runner picks a job up in this time |
| `github.unavailable_minutes` | number | `30` | How long a refused executor is skipped |
| `github.poll_seconds` | number | `15` | Seconds between polls of a CI run |
| `github.checkout_action` | string | `actions/checkout@v4` | The checkout action, e.g. pinned to a commit |
| `local.max_parallel` | number | `1` | Local jobs at a time for this project |
| `local.min_free_ram_mb` | number | `1024` | Wait while free RAM is below this |
| `local.max_load_per_core` | number | `1.5` | Wait while the 1-minute load per core is above this |
| `local.capacity_retry_seconds` | number | `30` | Seconds between capacity checks while waiting |
| `local.workdir` | `worktree` \| `repo` | `worktree` | `worktree`: a clean `git worktree` at the commit, removed afterwards. `repo`: the repository itself, which must be at the commit |
| `local.worktree_dir` | string | `data/pipelines/worktrees` | Where worktrees go |

Memory pressure is read from `/proc/pressure/memory` on Linux (`some avg10` of 20% or more) and `kern.memorystatus_vm_pressure_level` on macOS. Local steps get Lair's environment without `LAIR_NODE_TOKEN`, `LAIR_GITHUB_TOKEN` (or your `token_env`), `GITHUB_TOKEN` and `GH_TOKEN`.

Unknown keys and invalid values are config errors; a project with an invalid block has no pipelines, and `GET /api/pipelines/status` shows the errors. Lair reads these blocks at startup.

### Pipeline API

`?project=` defaults to the default project. Starting and cancelling runs are refused (HTTP 403) for a `read_only: true` project.

- `GET /api/pipelines/status`: executor order and availability (with the reason and the time an executor is unavailable until), the repository's visibility and runners, warnings, minutes used this month and the budget, and decisions raised
- `GET /api/pipelines/workflow`: the workflow file to commit, with setup steps
- `GET /api/pipelines/runs?limit=50`, `GET /api/pipelines/runs/<id>`: runs with their steps (and where each ran), jobs, attempts, logs and minutes
- `POST /api/pipelines/runs` with `{"pipeline": "gate", "sha": "<40 hex>"}` or `{"pipeline": "gate", "branch": "main"}` (default: the repository's `HEAD`): starts a run, HTTP 202
- `POST /api/pipelines/runs/<id>/cancel`: cancels a run; CI runs in flight are asked to cancel

## Process manager

Define processes for Lair to manage:

```yaml
processes:
  backend:
    name: Backend Server
    command: ["npm", "run", "start"]
    cwd: /path/to/repo
    restart: on-failure
    restart_delay: 1000
    max_restarts: 3
    health_check:
      type: http
      url: http://localhost:3000/health
      interval: 30000
      timeout: 5000
      action: restart
    autostart: true
```

### Process options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `name` | string | (key) | Display name for the process |
| `command` | array | required | Command and arguments to run |
| `cwd` | string | — | Working directory |
| `env` | object | `{}` | Environment variables |
| `restart` | `always` \| `on-failure` \| `never` | `never` | Restart policy |
| `restart_delay` | number | `1000` | Milliseconds before restart |
| `max_restarts` | number | `3` | Maximum restart attempts |
| `backoff_multiplier` | number | `2` | Exponential backoff multiplier |
| `max_backoff` | number | `60000` | Maximum backoff in milliseconds |
| `autostart` | boolean | `false` | Start on Lair startup |
| `depends_on` | array | `[]` | Process IDs that must start first |
| `log_max_lines` | number | `1000` | Log buffer size |
| `log_file` | string | — | Path to write logs |

### Health check options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `type` | `file_modified` \| `http` \| `tcp` \| `command` \| `none` | `none` | Check type |
| `path` | string | — | File path for file_modified check |
| `url` | string | — | URL for http check |
| `host` | string | — | Host for tcp check |
| `port` | number | — | Port for tcp check |
| `command` | array | — | Command for command check |
| `interval` | number | `30000` | Check interval in milliseconds |
| `timeout` | number | `5000` | Check timeout in milliseconds |
| `action` | `restart` \| `alert` \| `none` | `none` | Action on failure |
| `retries` | number | `1` | Retries before action |

## Watchdog

> Off by default. With `enabled: true` and the default `mode: observe`, the watchdog detects, records and escalates, and never runs any of your commands.

The watchdog ([design](design/autonomy.md#2-progress-watchdog-and-playbook-engine-module-watchdog)) checks each project every `interval_seconds` for the failures in the table below. It reads the project's files (`queue_file`, `agents_dir`, `gates_dir`), the process table (`ps`), and the read-only commands you configure (`ready_tasks_cmd`, `merged_cmd`, `docker inspect`). Each failure it finds is a **breach**, stored in `data/watchdog.db`. A breach stays open while it is still detected and is resolved once it is not.

What happens to an open breach:

- **Act**: when `mode: act` is set, the project is not `read_only`, and the breach's playbook has `act: true`, the playbook runs. It **diagnoses** (re-checks the breach on fresh data), **acts** (runs your `watchdog.actions.<action>` command) and **verifies**. A breach that is still open is retried after `cooldown_minutes`, up to `max_attempts` times, and then escalated. An attempt is a run that reached its act step: a run that stopped at diagnose (for example because `ps` failed) does not use one up.
- **Observe**: in every other case the playbook is recorded as `observed`, together with the command it would have run, and the breach is escalated.
- **Escalation**: happens once per breach. Lair appends an `- OWNER? ...` entry with the evidence (and the command output, if a command ran) to `escalation_file`, or to `inbox_file` when `escalation_file` is not set. With neither set, the escalation is kept in the store only. A breach that clears and comes back within `reescalate_minutes` of the last escalation for the same subject is recorded as suppressed and not written again.
- **A failed probe**: when a detector fails during a tick (`ps` fails, `merged_cmd` exits non-zero, ...), its open breaches are left alone for that tick. Nothing is resolved, run or escalated on data that could not be read.

Lair decides what to do and calls your commands; it never stops, kills or restarts anything itself. Any process id it passes to a command (`{pid}`) belongs to a process that `agent_command` matched to a configured agent. Right before each command runs, Lair checks again on fresh data. It refuses to restart a WAITING agent, to release a live agent's claim, to break a lock whose holder is alive, or to run any command on a container whose [delivery](#delivery) service is held. When the server stops, a verify delay in progress is cut short and no further command starts.

**Local agents only.** The process-based checks (`duplicate_agent`, `agent_hung`, `orphan_claim`, and the agents counted by `idle_capacity`) read this machine's `ps`. They only judge agents that run here: an agent whose `dragons.<id>.machine` is unset, or names a `machines:` entry of `type: local` (`local` also counts when it isn't listed). An agent on an `ssh` machine, or on a machine that isn't listed, is unknown here and never treated as dead. Its claim is never released, `idle_capacity` counts it as running while it has a claim, and local processes that match its id (an `ssh` wrapper, say) are ignored.

```yaml
watchdog:
  enabled: true
  mode: act                  # observe (default) | act
  agent_command: "agent-cli chat .*--agent {agent}"
  max_agents: 4
  locks:
    - name: gate-lock
      path: /home/user/my-project/work/gates/lock   # a directory with a pid file, or a file
  containers:
    - name: backend
  actions:
    restart_agent: ["./work/bin/agent-restart.sh", "{agent}", "{pid}"]
    release_claim: ["./work/bin/agent-release.sh", "{agent}"]
    break_lock: ["./work/bin/lock-break.sh", "{lock}"]
    requeue_gate: ["./work/bin/gate-requeue.sh", "{gate}"]
  playbooks:
    agent_stuck: { act: true }
    orphan_claim: { act: true }
    stale_lock: { act: true, max_attempts: 1 }
    gate_owner_gone: { act: true }
```

### Detectors and playbooks

| Detector | Breach when | Playbook | Action | Verify |
|----------|-------------|----------|--------|--------|
| `lock_holder_dead` | A configured lock's recorded holder pid is not running, or the lock has no pid and is older than `lease_minutes`, while an agent is WAITING or a gate request is queued | `stale_lock` | `break_lock` | the lock is gone or held by a live process |
| `duplicate_agent` | More than one process matches `agent_command` for one agent id (a wrapper and its child count once). One breach for each process except the oldest | `duplicate_agent` | `stop_duplicate` | one process left |
| `agent_hung` | The agent's process is alive, but neither its newest log nor the process itself has changed for `hung_minutes`, **and** the agent is not WAITING. WAITING means its latest queue line is a `WAITING` line naming a gate id that has no `<gate-id>.rc` result yet; such an agent is never hung | `agent_stuck` | `restart_agent` | the old pid is gone and the agent has a live process |
| `orphan_claim` | A claim `agents_dir/<id>.running` older than `claim_grace_minutes` whose agent has no live process. A live agent's claim is never touched | `orphan_claim` | `release_claim` | the claim is gone |
| `infra_signature` | The same normalised failure text (timestamps, hashes, numbers and the gate's own ids removed) in at least `infra_min_tracks` finished, failed gates of different tracks on one lane within `infra_window_minutes` | `lane_broken` | `mark_lane_broken` | later ticks |
| `gate_owner_gone` | A running gate request (`.req.run`) whose runner pid (in the `.req.run` file, else `gates_dir/runner-<lane>.pid`) is not running, or that has no runner pid at all, and whose log has been silent for `gate_lease_minutes` | `gate_owner_gone` | `requeue_gate` | the request is no longer running |
| `idle_capacity` | Ready work (queued gate requests plus `ready_tasks_cmd` tasks) and free capacity (no agent running, or fewer than `max_agents`), with nothing started (no claim, running gate or agent process) for `idle_minutes` | `idle_capacity` | `fill_capacity` | later ticks |
| `progress_stall` | No merge for `stall_hours` while work is pending (gate requests, ready tasks or claims). The queue file's last merge is its last `- MERGED ...` line, and only a full ISO time on it counts (`2026-01-01T12:00:00Z`): an `HH:MMZ` time has no date, so when the last MERGED line has none, the queue's last merge is unknown. A time printed by `merged_cmd` also counts. With no known merge it reports nothing | `no_merges` | `triage_stall` | later ticks |
| `crash_loop` | A configured container's `RestartCount` (from `docker inspect`) rose by `max_restarts` or more within `window_minutes`, or [delivery](#delivery) marked one of its services crash-looping. A held delivery service's container is left alone | `crash_loop` | `stop_container_restarts` | later ticks |

A detector without the config it needs is inactive: the three process-based detectors need `agent_command`, `lock_holder_dead` needs `locks`, and `crash_loop` needs `containers` or an enabled [delivery](#delivery) block. A "later ticks" verify means the breach is resolved when it is no longer detected, or escalated once its attempts are used up.

### Watchdog options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Run the watchdog for this project |
| `mode` | `observe` \| `act` | `observe` | `observe` never runs an action. `act` runs the playbooks that have `act: true`, unless the project is `read_only: true` |
| `interval_seconds` | number | `60` | Seconds between checks |
| `command_timeout_seconds` | number | `120` | Timeout for each command Lair runs |
| `agent_command` | string | — | Regular expression matched against each process's command line, where `{agent}` stands for the agent id (matched as a whole word). Agent ids come from `dragons:` and `agents_dir/dragons.txt` |
| `hung_minutes` | number | `45` | `agent_hung`: silence limit |
| `claim_grace_minutes` | number | `5` | `orphan_claim`: minimum claim age, so a starting agent isn't flagged |
| `max_agents` | number | — | `idle_capacity`: capacity is free below this. When unset, capacity is free only when no agent runs |
| `idle_minutes` | number | `10` | `idle_capacity`: how long nothing may start |
| `stall_hours` | number | `4` | `progress_stall`: hours without a merge |
| `gate_lease_minutes` | number | `30` | `gate_owner_gone`: how long the log may be silent |
| `infra_window_minutes` | number | `60` | `infra_signature`: window for finished gates |
| `infra_min_tracks` | number | `3` | `infra_signature`: different tracks with the same failure |
| `ready_tasks_cmd` | array | — | Prints ready task ids, one per line (or a JSON array) |
| `merged_cmd` | array | — | Prints merge times as ISO-8601 timestamps, e.g. `["gh", "pr", "list", "-R", "org/repo", "--state", "merged", "--json", "mergedAt", "-L", "1"]` |
| `docker_cmd` | array | `["docker"]` | The container CLI used for `inspect` |
| `escalation_file` | string | `inbox_file` | Where escalations are appended |
| `reescalate_minutes` | number | `60` | A breach whose subject (the same lock, agent, claim, ...) was escalated less than this long ago is not written again. `0` writes every one |
| `disabled_detectors` | array | `[]` | Detector ids to skip |
| `locks` | array | `[]` | `{name, path, pid_file: "pid", lease_minutes: 30}`. `path` is a lock directory (its holder's pid is in `<path>/<pid_file>`) or a lock file (holding the pid). A pid is written as `1234` or `pid=1234` |
| `containers` | array | `[]` | `{name, max_restarts: 3, window_minutes: 10}` |
| `actions` | map | `{}` | The commands, as argv arrays (no shell). See below |
| `playbooks` | map | `{}` | Per-playbook settings. See below |

Unknown keys, an unknown placeholder in an action, or `act: true` for a playbook whose action is not set are config errors. A project with an invalid `watchdog:` block is not watched, and `GET /api/watchdog/status` shows the errors. Lair reads the watchdog config at startup.

### Actions

Each action is an argv array, and `{placeholder}`s are replaced inside each argument. Every action also gets `{project}`. Values come from your files (log text, file names), so a value that would start an argument with `-` (and so read as an option) is refused: the step fails instead of running. Inside an argument, as in `--signature={signature}`, such a value is passed as data. The `{signature}` text never starts with a dash.

| Action | Placeholders |
|--------|--------------|
| `break_lock` | `{lock}` (path), `{lock_name}`, `{pid}` (empty when the lock has none) |
| `stop_duplicate` | `{agent}`, `{pid}` (the duplicate), `{keep_pid}` (the oldest, kept) |
| `restart_agent` | `{agent}`, `{pid}`, `{log}` (newest log path, or empty). It must stop the hung session and start a fresh one |
| `release_claim` | `{agent}`, `{claim}` (path) |
| `mark_lane_broken` | `{lane}`, `{signature}`, `{gates}` (comma-separated gate ids) |
| `requeue_gate` | `{gate}`, `{lane}`, `{file}` (the `.req.run` path), `{pid}` |
| `fill_capacity` | `{free}`, `{ready}` (ready tasks), `{queued}` (queued gate requests), `{running}` |
| `triage_stall` | `{hours}` (since the last merge), `{last_merge}` |
| `stop_container_restarts` | `{container}`, `{restarts}` |

### Playbook settings

`watchdog.playbooks.<id>` for `stale_lock`, `duplicate_agent`, `agent_stuck`, `orphan_claim`, `lane_broken`, `gate_owner_gone`, `idle_capacity`, `no_merges`, `crash_loop`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `act` | boolean | `false` | Opt this playbook in to act mode |
| `max_attempts` | number | `2` (`1` for `lane_broken`, `no_merges`, `crash_loop`) | Runs per breach before escalating |
| `cooldown_minutes` | number | `10` (`60` for `lane_broken` and `no_merges`, `30` for `crash_loop`) | Minutes between attempts |
| `verify_delay_seconds` | number | `0` (`30` for `agent_stuck`, `5` for `duplicate_agent`) | Wait before verifying |

### Watchdog API

Read-only routes. `?project=` defaults to the default project:

- `GET /api/watchdog/status`: mode, why act mode is off, config errors, the last tick, SLO status per detector (`ok`, `breached`, `inactive`, `error`) and the playbook settings
- `GET /api/watchdog/breaches?status=open|resolved|all&limit=100`
- `GET /api/watchdog/runs?limit=100`: playbook runs with each step's output and the argv that ran (or, when observed, would have run)
- `GET /api/watchdog/escalations?limit=100`

## Delivery

> Off by default. With `enabled: true` Lair reads your environments' status, and runs Up, Down, Restart and Deploy when you ask from the Delivery view. It deploys on its own only with `deploy.auto: true`.

Delivery ([design](design/autonomy.md#7-delivery-module-delivery-platformmd-milestone-m4-brought-forward-for-environment-1)) manages a project's **environments**. An environment is a docker compose project, such as the developer's own running stack. Every `interval_seconds` Lair reads each configured service's containers (`docker compose ps`, `docker inspect`) and its health check, and shows them in the Delivery view: state (`running`, `stopped`, `unhealthy`, `restarting` or `unknown`), health, restart count and the last error lines of its log. From the view you can bring the whole environment, or one service, up, down or restart it. Down, Restart and Deploy ask for confirmation first, and Down asks for a reason.

Lair shows and acts on the services you list under `services` only. Other services of the same compose project are left alone: no command names them, an environment Down doesn't stop them, and an Up doesn't start them (every start uses `--no-deps`).

What Lair does, and what it never does on its own:

- **Unknown state.** When the environment can't be read (the docker CLI is missing, the daemon is down, `docker compose ps` fails), every service shows as `unknown` with the error, never a guessed `stopped` or the last `running`. Up, Restart and Deploy then answer `409` until a read succeeds; Down still works, because holding is always safe. The status route never runs docker itself: it shows the latest read, and `not read yet` before the first one.
- **Up** starts the services in `start_order`, one at a time, and waits for each one to be healthy before the next (`start_timeout_seconds`). If a service doesn't become healthy, the services after it are not started.
- **Held services.** A service you take **Down** is *held*, with your reason. Lair never starts a held service: an environment Up skips it, a deploy skips it, and the watchdog leaves its container alone. It stays held, across restarts of Lair (the hold is stored in `data/delivery.db`), until you **Release** it. An environment Down stops every configured service (`docker compose stop`, never `docker compose down`, so containers and unmanaged services stay) and holds them; the next environment Up releases those holds again. A service you took down on its own stays held. Down works even while another operation runs (a build, a health wait): the service is held at once and stopped, and that operation re-checks holds before each command, so it never starts or recreates the service again. If the Down lands while that operation is already starting the service, Lair stops it again as soon as it sees the hold: a held service never stays running.
- **Crash loops.** A service whose restart count (Docker's restart policy restarting it) rises by `crash_loop.max_restarts` or more within `crash_loop.window_minutes` is marked *crash-looping*, with its last error lines. Lair then stops restarting it: an environment Up or Restart and an automatic deploy skip it. When you Up, Restart or Deploy that service on its own, the mark is cleared, and Up and Restart recreate the container (`--force-recreate`), so it gets the compose file's settings back, including a restart policy the watchdog's playbook set to `no`. The mark also clears itself after a whole window with no restarts, while the service runs healthy. The watchdog's `crash_loop` detector reports these marks as breaches, so its `crash_loop` playbook stops Docker's own restarts (`watchdog.actions.stop_container_restarts`) or escalates them to your inbox, with the error lines as evidence (see [Watchdog](#watchdog)).
- **Deploy after a merge** (`deploy.auto: true`). Lair never fetches on its own: `deploy.ref` moves when something updates it. To follow a remote branch, set `ref: origin/main` and a `fetch_cmd` that fetches it; Lair runs `fetch_cmd` on every tick, then reads `ref`. When `ref` points at a new commit, Lair diffs it (`git diff --name-only`) against the commit each service was last deployed at, and deploys every service with `build: true` whose `paths` changed. The first commit Lair sees is taken as what already runs. A commit is marked seen only once its deploy has started, or when no service needs it; a failed `git diff`, or an operation of yours in the way, leaves it for the next tick. For each service, in start order, Lair:
  1. tags the image the service runs now as `<image>:lair-previous`;
  2. rebuilds the image (`docker compose build <service>`);
  3. rolls the service (`docker compose up -d --no-deps --no-build <service>`);
  4. waits up to `deploy.health_timeout_minutes` for it to be healthy;
  5. if it isn't healthy in time, points the image back at `lair-previous` and recreates the container (`--force-recreate`), which is a **rollback**. The services after it are not deployed. A service held meanwhile is only re-tagged, not started.

  A failed build changes nothing that runs. An automatic deploy never starts a service that isn't running, and skips held and crash-looping services. A service that was rolled back, skipped or not reached shows as **behind**, and the next automatic deploy includes it again, even when the next merge doesn't touch it. The Deploy button on a service, or on the environment (which skips held services), runs the same steps by hand; a service deployed by hand counts as deployed at the latest commit Lair has seen, so it is no longer behind. On a `read_only: true` project there are no actions at all, by hand or automatic.
- **A stop of Lair** kills the commands in progress (a build included) instead of waiting for them, and marks the operation `interrupted`. When Lair starts again, a deploy that was interrupted after it built or rolled a service, but before it saw the service healthy, is rolled back to `lair-previous` in a recorded `recover` operation. On the next tick Lair tries that commit once more; if it fails again, the service stays behind until the next merge. A build that was killed before it finished, with no roll, left the service on its old image, so there is nothing to roll back.

Every command is an argv array (no shell), built from this config only. The environment and service names in a request must be configured ones: a request only picks one of them. Before anything is stored or shown, credentials are redacted from commands, their output and log lines: `scheme://user:password@` URLs, common token shapes (GitHub, GitLab, npm, Slack, Stripe, AWS, Google API keys, JWTs), PEM private keys, `Authorization:` headers of any scheme, and the values of keys named like a secret (`password`, `DB_PASSWORD`, `token`, `access_token`, `api_key`, `client_secret`, ...). Whole key names are matched, so `tokens: 1500` or `token_count=3` stay as they are.

Known limits:

- A deploy assumes each service has an image of its own. A service whose image repository another configured service also runs is refused (a rollback re-tags the repository, which would move the other service's image too). Lair can't see services it doesn't manage: if one of them runs the same image repository, a rollback moves its image too, and its next recreate uses the rolled-back image.
- Each deployed image repository keeps one extra tag, `<image>:lair-previous`, overwritten by the next deploy. Lair doesn't prune images.
- A hold is matched to a container by the names Lair last read for the service (kept in the store), so a custom `container_name` works after a restart too. A service never read is matched by Compose's default name, `<project>-<service>-<n>`.

```yaml
delivery:
  enabled: true
  environments:
    local:
      compose_files: ["/home/user/shop/compose.yaml"]
      project_name: shop-local
      start_order: [db, api, web]
      services:
        db:
          health: { type: container }        # the image's Docker HEALTHCHECK
        api:
          health: { type: http, url: "http://localhost:8080/health" }
          build: true
          paths: ["api/", "shared/"]
        web:
          health: { type: http, url: "http://localhost:3000/", expect_status: 200 }
          build: true
          paths: ["web/"]
      crash_loop: { max_restarts: 3, window_minutes: 10 }
      deploy:
        auto: true
        # Lair never fetches: fetch_cmd moves origin/main, then Lair reads it
        ref: origin/main
        fetch_cmd: ["git", "-C", "/home/user/shop", "fetch", "--quiet", "origin", "main"]
        # Bring the working tree the images are built from to the new commit
        prepare_cmd: ["git", "-C", "/home/user/shop", "merge", "--ff-only", "{sha}"]
        health_timeout_minutes: 5
```

### Delivery options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Manage this project's environments |
| `interval_seconds` | number | `30` | Seconds between reads (and restart-count samples) |
| `docker_cmd` | array | `["docker"]` | The container CLI. Lair runs `<docker_cmd> compose ...`, `<docker_cmd> inspect` and `<docker_cmd> tag` |
| `command_timeout_seconds` | number | `300` | Timeout for each command except builds and `prepare_cmd` (`fetch_cmd` included) |
| `build_timeout_seconds` | number | `1800` | Timeout for `docker compose build` and `prepare_cmd` |
| `environments` | map | `{}` | Environment name (letters, digits, `_` and `-`, starting with a letter) to its settings, below |

### Environment options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `compose_files` | array | required | Compose files, passed as `-f <file>` each. Relative paths resolve against Lair's working directory |
| `project_name` | string | required | The compose project name (`-p`): lowercase letters, digits, `-` and `_`. Containers are found by it, so use the name the stack already runs under |
| `project_directory` | string | — | Passed as `--project-directory` |
| `services` | map | required | Service name to its settings, below. Lair shows and acts on these services only; other services of the compose project are left alone |
| `start_order` | array | the order of `services` | Services Up and Restart start first, in this order. Services not listed follow, in the order of `services`. An environment Down stops them in reverse |
| `start_timeout_seconds` | number | `120` | How long Up, Restart and a rollback wait for each service to be healthy |
| `crash_loop.max_restarts` | number | `3` | Restarts within the window that mark a crash loop |
| `crash_loop.window_minutes` | number | `10` | The window |
| `deploy.auto` | boolean | `false` | Deploy changed services when `ref` moves |
| `deploy.repo` | string | the project's `repo` | The repository to watch |
| `deploy.ref` | string | `main` | The branch or ref to watch, e.g. `origin/main` with a `fetch_cmd` |
| `deploy.fetch_cmd` | array | — | Runs on every tick before `ref` is read, with `command_timeout_seconds` (ticks are serial, so keep it short). Lair itself never fetches |
| `deploy.prepare_cmd` | array | — | Runs before an automatic deploy builds anything, for example to update the working tree the images are built from. Placeholders: `{sha}` (the new commit), `{ref}`, `{environment}`, `{project}` |
| `deploy.health_timeout_minutes` | number | `5` | Roll back a deployed service that isn't healthy within this many minutes |

### Service options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `health` | map | `{type: container}` | `{type: container}`: the image's Docker `HEALTHCHECK` (a container without one counts as healthy while it runs). `{type: http, url, expect_status, timeout_seconds: 5}`: a GET to `url` (not following redirects). Without `expect_status`, any `2xx` or `3xx` answer is healthy |
| `build` | boolean | `false` | The image is built by Compose (the service has a `build:`), so a deploy can rebuild it |
| `paths` | array | `[]` | Repository paths (directories or files, relative to the repository root) whose changes deploy this service after a merge. Only for `build: true` |

Unknown keys, unsafe names, a value that starts with `-`, a `start_order` entry that isn't a service, or `deploy.auto` with no service that has `build: true` and `paths` are config errors. A project with an invalid `delivery:` block is not managed, and `GET /api/delivery/status` shows the errors. Lair reads the delivery config at startup.

### Delivery API

`?project=` defaults to the default project. Actions answer `202` with the operation, which runs in the background, one at a time per environment (a second one gets `409`, except a Down, which runs beside it). A `read_only` project answers `403`.

- `GET /api/delivery/status`: each environment's services (state, health, restart count, containers, hold, crash loop, last error lines, the commit it was deployed at and whether it is behind), the read error if any, the operation in progress and the automatic deploy state. It never runs docker
- `GET /api/delivery/operations?environment=&limit=50`: operations with every command they ran, its exit code and output (redacted)
- `GET /api/delivery/operations/:id`
- `POST /api/delivery/environments/:environment/up|down|restart|deploy`
- `POST /api/delivery/environments/:environment/services/:service/up|down|restart|deploy|release`

POST bodies are JSON. `down`, `restart` and `deploy` need `"confirm": true`. `down` needs a `"reason"`. An environment `deploy` takes `"services": [...]` (default: every service with `build: true`) and skips held ones. Up, Restart and Deploy of a held service, by name, answer `409` until it is released, and so does any Up, Restart or Deploy while the environment can't be read.

## Example complete configuration

```yaml
name: Example
repo: /home/user/example-repo
github: example/example-repo
queue_file: /home/user/example-repo/work/queue.md
agents_dir: /home/user/example-repo/work/agents
gates_dir: /home/user/example-repo/work/gates

read_only: false

machines:
  local:
    name: Workstation
    type: local
    runners: [heavy, light]

orchestrator:
  launchd_label: com.example.orchestrator

merge_bar:
  required_steps: [lint, test, build]
  require_review: true

dragons:
  kiro-A:
    name: Smaug
    model: claude-opus-4.5
    machine: local

dragon_start_cmd: ["./work/bin/dragon-start.sh", "{dragon}", "{task}"]
dragon_stop_cmd: ["./work/bin/dragon-stop.sh", "{dragon}"]
```

## Configuration lookup

Lair looks for project configurations in this order:

1. `projects/local/<name>.yaml`, then `projects/local/<name>.yml` — Private configs (gitignored)
2. `projects/<name>.yaml`, then `projects/<name>.yml` — Public configs

The first matching file is used. The server and the fleet bus (`npm run bus`) both load files ending in `.yaml` or `.yml`. Start Lair from the repository root: `projects/` and `data/` are found from the current directory, and the relative paths in `projects/example.yaml` (such as `./fixtures/queue.md`) assume it.

Project names (the file name without `.yaml` or `.yml`) must start with a letter or digit and contain only letters, digits, `.`, `_` and `-`; files with other names are not listed. API requests with an invalid or unknown `?project=` are refused with HTTP 400.

## Environment variables

| Variable | Used by | Description |
|----------|---------|-------------|
| `LAIR_HOST` | server | Bind address (default `127.0.0.1`). The host is also added to the allowed browser `Origin`s and `Host` headers (ports 4777 and 5173), so a browser that opens `http://<LAIR_HOST>:4777` gets the full dashboard. A wildcard (`0.0.0.0`, `::`) listens on every interface and **turns the `Host` check off**, but adds no allowed `Origin`: a browser on another machine gets only the read-only GET requests, while its POSTs (every control) get HTTP 403 and its WebSocket is refused. To use the dashboard from another machine, set the address that machine's browser opens instead of a wildcard. Lair has no authentication, so don't use anything but loopback on an untrusted network |
| `LAIR_NODE_TOKEN` | server, lair-node | Shared secret for remote lair-node daemons. The server accepts `/ws/node` connections from its own machine (loopback) without it; any other peer is refused unless `LAIR_NODE_TOKEN` is set on the server and the node presents the same value as `Authorization: Bearer <token>` or `?token=<token>`. lair-node sends it automatically when `LAIR_NODE_TOKEN` is set in its environment |
| `LAIR_PROJECT` | server | The default project: the one the dashboard opens first, the one API requests without `?project=` use, and the one whose `processes:` the process manager runs. It must name a project in `projects/` or `projects/local/` (for example `LAIR_PROJECT=myproject`); an invalid or unknown name logs a warning at startup and is ignored. Without it the default is `example` if it exists, else the first project found |
| `LAIR_CLIENT_DIR` | server | Directory of the built web UI to serve (default `dist/client`) |
| `LAIR_AGENT_ID` | lair-bus | The calling agent's ID (required) |
| `LAIR_GITHUB_TOKEN` | server | A fine-grained GitHub token for running gate pipelines on GitHub Actions (see [Gate pipelines](#gate-pipelines)). A project can name another variable with `executors.github.token_env`. Never passed to local steps |

The server refuses, with HTTP 403, browser requests whose `Origin` is not one of its own (`http://localhost`, `http://127.0.0.1` or `http://[::1]` on port 4777 or 5173, plus `LAIR_HOST`) and requests whose `Host` header names another host (DNS rebinding). Requests without an `Origin` header, such as `curl` or lair-node, are allowed. WebSocket handshakes get the same `Origin` check.
