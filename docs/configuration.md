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

- **Act**: when `mode: act` is set, the project is not `read_only`, and the breach's playbook has `act: true`, the playbook runs. It **diagnoses** (re-checks the breach on fresh data), **acts** (runs your `watchdog.actions.<action>` command) and **verifies**. A breach that is still open is retried after `cooldown_minutes`, up to `max_attempts` times, and then escalated.
- **Observe**: in every other case the playbook is recorded as `observed`, together with the command it would have run, and the breach is escalated.
- **Escalation**: happens once per breach. Lair appends an `- OWNER? ...` entry with the evidence (and the command output, if a command ran) to `escalation_file`, or to `inbox_file` when `escalation_file` is not set. With neither set, the escalation is kept in the store only.

Lair decides what to do and calls your commands; it never stops, kills or restarts anything itself. Any process id it passes to a command (`{pid}`) belongs to a process that `agent_command` matched to a configured agent. Right before each command runs, Lair checks again on fresh data. It refuses to restart a WAITING agent, to release a live agent's claim, or to break a lock whose holder is alive.

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
| `progress_stall` | No merge for `stall_hours` while work is pending (gate requests, ready tasks or claims). A merge is a `- MERGED ...` line in the queue file, or a time printed by `merged_cmd`. With no merge on record it reports nothing | `no_merges` | `triage_stall` | later ticks |
| `crash_loop` | A configured container's `RestartCount` (from `docker inspect`) rose by `max_restarts` or more within `window_minutes` | `crash_loop` | `stop_container_restarts` | later ticks |

A detector without the config it needs is inactive: the three process-based detectors need `agent_command`, `lock_holder_dead` needs `locks`, and `crash_loop` needs `containers`. A "later ticks" verify means the breach is resolved when it is no longer detected, or escalated once its attempts are used up.

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
| `disabled_detectors` | array | `[]` | Detector ids to skip |
| `locks` | array | `[]` | `{name, path, pid_file: "pid", lease_minutes: 30}`. `path` is a lock directory (its holder's pid is in `<path>/<pid_file>`) or a lock file (holding the pid). A pid is written as `1234` or `pid=1234` |
| `containers` | array | `[]` | `{name, max_restarts: 3, window_minutes: 10}` |
| `actions` | map | `{}` | The commands, as argv arrays (no shell). See below |
| `playbooks` | map | `{}` | Per-playbook settings. See below |

Unknown keys, an unknown placeholder in an action, or `act: true` for a playbook whose action is not set are config errors. A project with an invalid `watchdog:` block is not watched, and `GET /api/watchdog/status` shows the errors. Lair reads the watchdog config at startup.

### Actions

Each action is an argv array, and `{placeholder}`s are replaced inside each argument. Every action also gets `{project}`.

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

The server refuses, with HTTP 403, browser requests whose `Origin` is not one of its own (`http://localhost`, `http://127.0.0.1` or `http://[::1]` on port 4777 or 5173, plus `LAIR_HOST`) and requests whose `Host` header names another host (DNS rebinding). Requests without an `Origin` header, such as `curl` or lair-node, are allowed. WebSocket handshakes get the same `Origin` check.
