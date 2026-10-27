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

The Gates view reads `gates_dir/queue/` and `gates_dir/results/`:

- A gate request is `<lane>.<priority>.<gate-id>.req` (queued), `.req.run` (running), or `.req.<status>` for any other state the runners use (`.req.superseded`, `.req.stuck`, `.req.deferred-stacked`, ...: shown as that status). The lanes are whatever the file names say (`heavy`, `light`, `remote`, `quick`, `actions`, ...): a letter, then letters, digits, `_` or `-`, at most 32 characters. Every lane shows under Running, Queued and By Lane.
- A result is `results/<gate-id>.rc` (the exit code) with its `<gate-id>.log`. Recent Results lists the results written in the last 24 hours (by the `.rc` file's modification time), newest first.

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

By default, Lair runs in read-only mode. Enable controls by setting `read_only: false` and defining command templates. Running them from the dashboard (the command bar, the Dragons view) also needs the browser to be signed in as the owner (see [Owner-only routes](#owner-only-routes)):

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

Each key under `dragons` is the dragon's ID. IDs start with a letter, contain only letters, digits, `_` and `-`, end with a letter or digit, and are at most 64 characters: `kiro-A`, `aider-1` and `worker_b` all work. Entries with other IDs are skipped. Log files are matched to dragons by name: `<id>.log` or `<id>-<YYYYMMDDTHHMMSSZ>.log` in `agents_dir`. A dragon's last log time (the Dragons view, the Overview's "silent" check) is when its newest log file was last written (the file's modification time); a running dragon with no log is reported as "log time unknown", never as silent.

Dragons listed in `<agents_dir>/dragons.txt` (one per line: id, name, task) can be started and stopped from the dashboard too, without a `dragons:` entry. Such a dragon uses its name from `dragons.txt`, the model and adapter of `dragon_defaults` (below; without it, no model and the default adapter), and has no machine or instructions; add a `dragons:` entry to set them. When a dragon is in both, the `dragons:` entry is used. The same ID rules apply, and `dragons.txt` is re-read on every request, so new lines need no restart.

A dragon that Lair's [agents module](#agents) has an active run for shows as running in the Dragons view, with the run's state (starting, working, waiting on lock, hung, ...) and "managed by Lair"; stop it from the Agents view.

### Dragon defaults

```yaml
dragon_defaults:
  model: model-id
  adapter: claude-code
```

`dragon_defaults` gives a model and an adapter to every dragon that names none: each `dragons.txt` dragon, and a `dragons:` entry that leaves `model` or `adapter` out. A dragon's own value always wins. The Dragons view shows the effective model, with "(default)" when it came from a default. The agents module, the start dialog and start/stop requests use the same values. Both keys are optional:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `model` | string | — | A model id: letters, digits, `.`, `_`, `:`, `/`, `@` and `-`, not starting with `-`, at most 100 characters |
| `adapter` | string | — | A built-in adapter (`kiro`, `aider`, `claude-code`, `cursor-agent`) or one of the project's `agent_adapters` |

Any other key, or a value that doesn't fit, stops the project from loading, with an error that names the key.

### Dragon options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `name` | string | (agent id) | Display name for the agent |
| `model` | string | `dragon_defaults.model`, else `claude-sonnet-4` | AI model ID to use |
| `machine` | string | `local` | Machine ID where this agent runs |
| `adapter` | string | `dragon_defaults.adapter`, else `kiro` | Agent adapter ID (see [Agents](agents.md)) |
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

**Fallback.** A job GitHub refuses (billing, spending limit, Actions disabled, a workflow that fails to start), or that no runner picks up within `pickup_timeout_minutes`, is cancelled and goes to the next executor once GitHub reports that none of its steps started. If a runner took the job in the moment Lair cancelled it, the job stopped unfinished and also goes to the next executor: Lair's own cancel never makes a gate fail. The refused executor is unavailable for `unavailable_minutes` (shown, with the reason, in the Gates view). A job is never run twice: when the cancel came too late and the run finished, Lair keeps that run's result. A runner lost mid-run (the job ended cancelled or timed out with no failed step) gets one retry; the second time the result stands. In-flight jobs resume after a server restart, and leftover job worktrees are removed then.

**Minutes budget.** Before sending a private repository's job to a GitHub-hosted runner, Lair adds the lane's expected minutes (the most of its last five hosted runs, at least 1) to the minutes billed this calendar month (UTC). When that would go over `monthly_minutes`, it sends nothing there, raises a `spend` decision once per month in the [Decision Inbox](#decision-inbox) (event `decision.needed`), and uses the next executor. Answering it doesn't change the budget yet: raise `monthly_minutes` and restart. Billed minutes also go into the fleet budget as provider `github-actions:<project>`, in minutes.

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

Memory pressure is read from `/proc/pressure/memory` on Linux (`some avg10` of 20% or more) and `kern.memorystatus_vm_pressure_level` on macOS. Local steps get Lair's environment without `LAIR_NODE_TOKEN`, `LAIR_GITHUB_TOKEN` (or your `token_env`), `GITHUB_TOKEN` and `GH_TOKEN`. Each local step runs in its own process group: cancelling a run or reaching a timeout stops every process the step started, and anything a step leaves running when it ends is killed (on Windows, through `taskkill /T`). So, unlike on GitHub Actions, a background process does not survive into the next step.

Unknown keys and invalid values are config errors; a project with an invalid block has no pipelines, and `GET /api/pipelines/status` shows the errors. Lair reads these blocks at startup.

### Pipeline API

`?project=` defaults to the default project. Starting and cancelling runs need the owner's session (see [Owner-only routes](#owner-only-routes)), and are refused (HTTP 403) for a `read_only: true` project. Code inside the server starts runs with `PipelineManager.startRun`.

- `GET /api/pipelines/status`: executor order and availability (with the reason and the time an executor is unavailable until), the repository's visibility and runners, warnings, minutes used this month and the budget, and decisions raised
- `GET /api/pipelines/workflow`: the workflow file to commit, with setup steps
- `GET /api/pipelines/runs?limit=50`, `GET /api/pipelines/runs/<id>`: runs with their steps (and where each ran), jobs, attempts, logs and minutes
- `POST /api/pipelines/runs` with `{"pipeline": "gate", "sha": "<40 hex>"}` or `{"pipeline": "gate", "branch": "main"}` (default: the repository's `HEAD`): starts a run, HTTP 202
- `POST /api/pipelines/runs/<id>/cancel`: cancels a run; CI runs in flight are asked to cancel

## Process manager

Define processes for Lair to manage (starting, stopping and restarting them from the dashboard needs the owner's session, see [Owner-only routes](#owner-only-routes)):

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

## Decision Inbox

> Always on, nothing to configure. It is the one place Lair asks you something: pricing, legal, spend, accounts, credentials, go/no-go, and problems its own playbooks couldn't fix.

The Decision Inbox ([design](design/autonomy.md#1-decision-inbox-the-only-place-a-human-is-needed-module-decisions)) is the **Decisions** view. The number next to it in the nav is how many decisions wait for you, in red while one of them is overdue. It shows every project's decisions, open ones first: the soonest to expire, then the oldest. Decisions are kept in `data/decisions.db`, so they survive a restart.

Each decision shows:

- its **kind**, its title, and its **context**: what is blocked and why;
- the **options**, each with its consequences, and the **recommended** one with the reasoning;
- who raised it (a module, such as `watchdog`, and its own reference), and the work it blocks;
- when it expires, if it does, and what happens then;
- under **History**, its audit trail: raised, answered, overdue, expired, withdrawn and delivered, each with its time and who did it.

You answer by choosing an option, with an optional note. Answers to `spend` and `go_no_go` decisions ask you to confirm first.

**Only you answer.** The first time the server starts, it writes a random **owner token** to `data/owner.token` (readable only by your OS user) and prints a setup link, once, to its standard output (the terminal you ran `npm start` in, or your service manager's log):

```
[owner] Only you answer decisions. Open this link once in your browser to sign it in: http://127.0.0.1:4777/#owner-token=...
```

Open that link, or paste the token in the Decisions view, and that browser is **signed in as the owner**. It gets a random session that it keeps in the dashboard's own `localStorage`, which belongs to the dashboard's exact origin (scheme, host and port), so no other local server can read it. Under `npm run dev` the session stays in the page's memory instead, and a reload signs the browser out: the Vite dev server (port 5173) also serves every file of the checkout from the dashboard's origin, so an HTML file an agent commits there could read that origin's `localStorage`. The server stores only a keyed hash of the session. No cookie is used: browsers send cookies for `localhost` to every port, so any other local server the browser visits would get one.

An answer is accepted only with that session in the `X-Lair-Owner-Session` header, from the dashboard's own origin, in a same-origin browser request (`Origin` and `Sec-Fetch-Site: same-origin`). No CORS is granted for these routes, so a page on another origin can't send that header. Anything else gets HTTP 403 before its body is read, and the decision stays open: `curl`, a script, an agent, another local app, or a request with a forged `Origin` but no session. The work a decision gates can't approve itself. The audit trail records each answer as the owner's, with the address and browser it came from.

- **Signed-in browsers.** The Decisions view lists the browsers signed in as the owner, with when each signed in, when it was last used, and its user agent. You can sign any of them out there, including the one you're using. Signing out needs a signed-in browser. At most 20 sessions are kept; the least recently used one goes first.
- **Signing every browser out.** Delete `data/owner.token` and restart the server. The new token makes every old session invalid, and the server prints a new setup link.
- **Keep the setup link and the token from your agents.** Don't run the server where its output goes somewhere your agents can read, such as a shared terminal, a log file in the project, or an agent's own session. Run your agents as a separate OS user, without access to Lair's `data/` directory or the server's log. A program running as your OS user can read both, and with them sign itself in.
- **Browsers.** Answering needs a browser that sends `Sec-Fetch-Site`: current Chrome, Edge, Firefox and Safari do. Safari before 16.4 doesn't, so its answers are refused.
- **Links in a decision** are shown as text with a Copy button, never as links you click: whoever raised the decision chose them. Links to this machine or a private network are refused when the decision is raised: `localhost`, names under `.localhost`, `.local`, `.internal`, `.home.arpa`, `.lan` or `.arpa`, names without a dot, wildcard-DNS names that resolve to the address they contain or to 127.0.0.1 (`nip.io`, `sslip.io`, `xip.io`, `localtest.me`, `lvh.me`), and the addresses `127.0.0.0/8`, `::1`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `fc00::/7` and `fe80::/10`, however they are written (`2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1`, `user@127.0.0.1`, IPv4-mapped IPv6). Another public name can still resolve to a local address, so check an address before you open it.

| Kind | For | Can it have a default? |
|------|-----|------------------------|
| `pricing` | prices and plans | no |
| `legal` | terms, privacy policy, licences | no |
| `spend` | money: budgets, paid plans | no (and answers need confirming) |
| `account` | creating accounts with outside services | no |
| `credentials` | a token or password Lair needs | no |
| `go_no_go` | launching or releasing | no (and answers need confirming) |
| `security` | security trade-offs | no |
| `escalation` | a problem Lair's playbooks couldn't fix (the watchdog and the agents module raise these) | yes |
| `other` | anything else | yes |

**Waiting and resuming.** The module that raised a decision parks the work it blocks until you answer, then resumes with your answer. A module asks the same question (the same project, module and key) only once while it is open. If the module isn't listening when you answer (for example, Lair is restarting), the answer is kept and delivered when it is back.

**Expiry and defaults.** A decision may expire. A decision with a **default** gets that option as its answer when it expires unanswered, and its history says so. Kinds marked "no" above can't have a default: Lair never decides those for you. A decision without a default keeps waiting after it expires, and is marked overdue.

**Credentials.** A `credentials` decision has a password field and no note field (a note could end up holding the secret). The value goes to Lair's secret store and nowhere else: not to `data/decisions.db`, the history, a log line or any API response. The decision records only that you supplied it. It is handed to the secret store only once your answer has closed the decision, so a second, losing answer never stores anything; if the secret store fails, the decision is open again. If the server restarts before the module that asked has the answer, and the secret store forgot the value meanwhile (the built-in one does), the decision opens again too, so you supply it once more. Lair's built-in secret store keeps values in the server's memory only, never on disk, so after a restart the module that needs the value asks again. A persistent store (an OS keychain, a vault) can replace it through the `SecretStore` interface in `src/server/decisions/secrets.ts`.

**From your own tools.** Any module, script or agent can ask through the API below; only you answer. Two limits keep a flood of questions out: one module may have at most 50 open decisions per project (`LAIR_DECISIONS_MAX_OPEN`), and decisions raised over HTTP may have at most 20 open per project together, whatever module they name, since over HTTP the module name is only what the caller says (`LAIR_DECISIONS_MAX_OPEN_HTTP`). More are refused with HTTP 429 until some are answered. Modules inside the server count only against their own limit. A decision raised over HTTP shows that, so you know its module name is unchecked. Answering doesn't run anything by itself, so it also works on a `read_only` project: the module that asked decides what the answer allows. Server modules use the `DecisionProducer` interface (`raise`, `blockedOn`, `onResolved`, `withdraw`) from `src/server/decisions/`. Only they can withdraw a decision: HTTP callers have no identity yet, so there is no withdraw route.

**Modules that ask by event.** A module can also ask by emitting a `decision.needed` event in the server, in the design note's shape (`question`, string `options`, `recommended`, `why`, kinds `product`, `credential` and `release` for `pricing`, `credentials` and `go_no_go`). The Decision Inbox raises it as a decision of that module, with option ids made from the option texts. `on_timeout` is not carried over: such a decision has no expiry, so it waits for you. Gate pipelines ask this way, for their GitHub-hosted minutes budget (see [Minutes budget](#gate-pipelines)). **The pipelines module does not act on answers yet:** whatever you choose, it keeps the budget it has. To raise it, change `executors.github.monthly_minutes` and restart. Your answer is kept, and is delivered to the pipelines module once it listens for answers.

### Decision Inbox API

`?project=` is validated as on every route. Bodies are JSON.

- `GET /api/decisions?project=&status=open|answered|expired|withdrawn|closed|all&limit=100`: open first, by urgency. Without `?project=`, every project's decisions
- `GET /api/decisions/summary?project=`: `{open, overdue, secretStore}`
- `GET /api/owner/session`: `{signedIn, session}` for the `X-Lair-Owner-Session` header sent
- `POST /api/owner/sessions`: `{token}`, from the dashboard only: signs this browser in and returns `{session, info}`, the session value only this once. `GET /api/owner/sessions` lists the signed-in browsers and `POST /api/owner/sessions/:id/revoke` signs one out; both need a signed-in browser
- `GET /api/decisions/:id`: one decision with its audit trail
- `POST /api/decisions?project=`: raise a decision (201, or 200 with the open one when the same key is already open). The project comes from `?project=`, else the default project:

  ```json
  {
    "kind": "spend",
    "title": "Raise the monthly hosting budget",
    "context": "The staging deploy needs a larger database plan.",
    "options": [
      { "id": "approve", "label": "Approve the larger plan", "consequences": "Costs more each month; the deploy goes ahead." },
      { "id": "decline", "label": "Keep the current plan", "consequences": "The deploy stays blocked." }
    ],
    "recommended": { "optionId": "approve", "reasoning": "Staging can't start on the current plan." },
    "source": { "module": "deploy-script", "ref": "staging" },
    "key": "budget:staging",
    "blocks": ["deploy:staging"],
    "expiresAt": "2026-01-02T12:00:00Z"
  }
  ```

  `blocks`, `links` (`[{label, url}]`, http or https, not to this machine or a private network), `expiresAt` and `defaultOptionId` are optional. A default needs `expiresAt`, and is refused for the kinds above that can't have one. A `credentials` decision also needs `secretName` and an option with `"suppliesSecret": true`.
- `POST /api/decisions/:id/answer`: `{optionId, note?, confirm?, secret?}`, with an owner session (see "Only you answer"). `confirm: true` is required for `spend` and `go_no_go`; `secret` goes only with an option that supplies it, and `credentials` decisions take no `note`

Errors: 400 for invalid input, 403 for a cross-site request or an answer without an owner session, 404 for an unknown decision, 409 when it is no longer open, 429 when a module, or HTTP callers together, have too many open decisions, 503 when the secret store can't take a value.

## Owner-only routes

Every route that changes something only you should change needs the owner's session, the same one the Decision Inbox uses (see "Only you answer"): the `X-Lair-Owner-Session` header, from the dashboard's own origin, in a same-origin browser request. Without it the answer is HTTP 403, before the request's body is read, and nothing changes. `curl`, scripts, agents and other local programs can still read: every `GET` stays open, except the two that read prompt files from disk (`/api/agents/prompts`). No CORS is granted under these prefixes (`OWNER_ONLY_PREFIXES` in `src/server/human-auth/cors.ts`). The dashboard's views send the session once this browser is signed in, and show "sign in from Decisions" until it is.

| Prefix | Owner only | Open |
|--------|------------|------|
| `/api/decisions` | answering a decision | listing, the summary, raising |
| `/api/owner` | listing and signing out browsers | the session check, signing in with the token |
| `/api/review` | the owner's review, resolving findings, releasing holds, merging | reading, agent reviews, adding holds, gate results |
| `/api/agents` | starting a run, releasing a claim, a fresh session, an early check, listing and reading prompt files | status, runs, recoveries |
| `/api/controls` | every `POST`: ask, instruct, tick, pause, resume, agent run/stop/release, gate submit/stuck, merge, dragon start/stop | status, inbox, audit, dragon config |
| `/api/bus/send` | sending a message (it is sent as `owner`) | the board and the event stream (`/api/bus/board`, `/api/bus/events`) |
| `/api/processes` | start, stop, restart | the list, a process, its logs |
| `/api/settings` | saving the config, testing a machine | reading the settings |
| `/api/scheduler`, `/api/tasks` | scheduler start, stop and tick; creating, cancelling and retrying tasks | status, tasks, jobs, nodes |
| `/api/fleet` | adding, removing, testing and installing machines; healing and budget settings; provider budgets and unpausing | the overview, machines, healing events, budgets |
| `/api/delivery` | Up, Down, Restart, Deploy, Release | status and operations |
| `/api/pipelines` | starting and cancelling runs | status, the workflow file, runs |

The watchdog's routes are all reads; it acts only inside the server. Lair's own work doesn't go through these routes either: delivery's automatic deploys, the scheduler, the healer and the watchdog's playbooks run inside the server, server code starts pipeline runs with `PipelineManager.startRun` and creates tasks with the job manager, and agents use the fleet bus (`npm run bus`), which works on the bus database directly. The `lair-node` daemon connects over `/ws/node`, not these routes.

## Watchdog

> Off by default. With `enabled: true` and the default `mode: observe`, the watchdog detects, records and escalates, and runs none of your commands unless you approve one in the [Decision Inbox](#decision-inbox).

The watchdog ([design](design/autonomy.md#2-progress-watchdog-and-playbook-engine-module-watchdog)) checks each project every `interval_seconds` for the failures in the table below. It reads the project's files (`queue_file`, `agents_dir`, `gates_dir`), the process table (`ps`), and the read-only commands you configure (`ready_tasks_cmd`, `merged_cmd`, `docker inspect`). Each failure it finds is a **breach**, stored in `data/watchdog.db`. A breach stays open while it is still detected and is resolved once it is not.

What happens to an open breach:

- **Act**: when `mode: act` is set, the project is not `read_only`, and the breach's playbook has `act: true`, the playbook runs. It **diagnoses** (re-checks the breach on fresh data), **acts** (runs your `watchdog.actions.<action>` command) and **verifies**. A breach that is still open is retried after `cooldown_minutes`, up to `max_attempts` times, and then escalated. An attempt is a run that reached its act step: a run that stopped at diagnose (for example because `ps` failed) does not use one up.
- **Observe**: in every other case the playbook is recorded as `observed`, together with the command it would have run, and the breach is escalated.
- **Escalation**: happens once per breach, as an `escalation` decision in the [Decision Inbox](#decision-inbox), with the evidence (and the command output, if a command ran). Until you answer, the breach is parked: no playbook runs and nothing is escalated again. **Run once** (offered when the playbook's command is configured and the project isn't `read_only`) runs the breach's playbook one more time, also in observe mode; if that run fails, Lair asks again. **Leave it to me** stops all action on the breach. A breach that clears on its own withdraws its open decision. When `escalation_file` is set, Lair also appends an `- OWNER? ...` entry there. If the decision can't be raised, the entry goes to `escalation_file`, or to `inbox_file` when that isn't set, and is otherwise kept in the store only. A breach that clears and comes back within `reescalate_minutes` of the last escalation for the same subject is recorded as suppressed and not escalated again.
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
| `escalation_file` | string | — | A file that also gets each escalation as an `- OWNER? ...` entry. Escalations are decisions in the [Decision Inbox](#decision-inbox); when one can't be raised, the entry goes here, or to `inbox_file` |
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
- `GET /api/watchdog/escalations?limit=100`: each with the `decisionId` it raised in the Decision Inbox

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

`?project=` defaults to the default project. Actions answer `202` with the operation, which runs in the background, one at a time per environment (a second one gets `409`, except a Down, which runs beside it). A `read_only` project answers `403`. Every action needs the owner's session (see [Owner-only routes](#owner-only-routes)); without it the answer is `403` and nothing runs or is held.

- `GET /api/delivery/status`: each environment's services (state, health, restart count, containers, hold, crash loop, last error lines, the commit it was deployed at and whether it is behind), the read error if any, the operation in progress and the automatic deploy state. It never runs docker
- `GET /api/delivery/operations?environment=&limit=50`: operations with every command they ran, its exit code and output (redacted)
- `GET /api/delivery/operations/:id`
- `POST /api/delivery/environments/:environment/up|down|restart|deploy`
- `POST /api/delivery/environments/:environment/services/:service/up|down|restart|deploy|release`

POST bodies are JSON. `down`, `restart` and `deploy` need `"confirm": true`. `down` needs a `"reason"`. An environment `deploy` takes `"services": [...]` (default: every service with `build: true`) and skips held ones. Up, Restart and Deploy of a held service, by name, answer `409` until it is released, and so does any Up, Restart or Deploy while the environment can't be read.

## Reviews and policy merge

The `review:` block turns on risk tiers, recorded reviews, the test integrity check and policy merge for a project ([design](design/autonomy.md#5-reviews-and-policy-merge-module-review-extends-policy)). It is off unless `enabled: true`, and it never merges a project with `read_only: true`. The Reviews view shows each open PR's tier, required and present reviews, findings, the gate at the head, and the merge button with the reasons it is disabled. The PRs view takes its readiness from the same evaluation: a PR is "Merge ready" only when the review module allows the merge at its head, and otherwise shows "Waiting:" with the first reason. Without `review.enabled` that view's first group is "Gate passed": it means only that a gate passed at the head.

```yaml
review:
  enabled: true
  repo: example-org/example-repo     # default: github
  token_env: GITHUB_TOKEN            # or token_cmd: ["gh", "auth", "token"]
  authors:
    branch_pattern: "agent/{agent}/**"
  tiers:
    default: amber
    rules:
      - { id: migrations, tier: red, kinds: [migration] }
      - { id: auth, tier: red, kinds: [auth, billing] }
      - { id: hotfix, tier: red, labels: [hotfix] }
      - { id: big, tier: amber, min_lines: 500 }
      - { id: docs, tier: green, paths: ["docs/**", "*.md"] }
  reviewers:
    red: [{ any_of: [human, "agent:lead-reviewer"] }]
    amber: [peer]
    green: [self]
  merge:
    gate:
      source: checks
      required:                      # check runs by name, from GitHub Actions unless app says otherwise
        - "build (22)"
        - { name: "build (24)", app: github-actions }
    method: auto                     # auto | host | local
    local_strategy: ff-only          # ff-only | squash
    identity: { name: Release Bot, email: 12345+release@users.noreply.github.com }
    allowed_emails: ["*@users.noreply.github.com"]
```

### Risk tiers

Every changed file gets the highest tier of the file rules (`paths`, `kinds`) that match it, or `tiers.default` when none does; a renamed file also counts under its old path. Size rules (`min_lines`, `min_files`) and `labels` apply to the whole change. The PR's tier is the highest of all of them, and the status lists every rule that matched and why (`kind migration: db/migrations/0002.sql`, `label hotfix`, `612 changed lines (at least 500)`). A rule's conditions must all hold, and it needs at least one.

Globs use `**` (any directories), `*`, `?` and `{a,b}`; a glob without `/` matches the file name at any depth (`package.json` matches `web/package.json`). File kinds are named glob lists. The built-in ones are `migration`, `auth`, `billing`, `workflow` (CI), `dependency` (manifests and lock files), `docs` and `test`; `tiers.file_kinds` adds kinds or replaces these lists. Without `tiers.rules`, Lair uses: migrations, auth, billing, CI workflows and the `security` label red; dependencies and changes of 500 lines or more amber; docs and tests green; anything else the default tier.

### Required reviews

`reviewers.<tier>` lists the reviews a tier needs. Each entry is one reviewer, so two entries need two different reviewers:

| Entry | Filled by |
|-------|-----------|
| `human` | A review with `kind: human` from someone other than the author |
| `agent:<id>` | That reviewer agent (never the author) |
| `peer` | Any reviewer, agent or human, other than the author |
| `self` | The author's own review (its self-check) |
| `{any_of: [...], different_model: true}` | Any of the listed ones; with `different_model`, an agent on a model other than the author's (a human always qualifies) |

Defaults: `red: [human]`, `amber: [peer]`, `green: [self]`. Only an `approve` given at the PR's current head sha counts; a push makes every older review stale, and a reviewer's later review replaces its earlier one. The author is the agent Lair's own modules registered for the PR (the agent assigner or intake; never settable over HTTP), else the agent id that `authors.branch_pattern` finds in the PR's branch; its model comes from `dragons:` or `authors.models`. `branch_pattern` is a template, not a regular expression: `{agent}` (exactly once) is an agent id, `*` matches within one path segment and `**` (at most once) across segments, and everything else is literal, so `agent/{agent}/**` reads `worker-a` from `agent/worker-a/fix-login`. Branch names longer than 255 characters never match. With no author, `peer`, `self` and `different_model` can't be satisfied, and the status says so.

A review has a fixed schema: a reviewer, the full `head_sha`, `verdict` (`approve` or `request_changes`) and `findings[]` of `{severity, file, line, text, blocking}`. Who may review:

- **An agent** posts `{reviewer: {id, kind: agent, model?}, ..., assignment_token}`: the token of an assignment Lair issued for that PR, head and agent (see below). Without one, or with another agent's, another PR's or another head's, it is refused with 403.
- **A human** reviews only as the owner: from the dashboard, in a browser signed in with the owner token (the same owner session as the Decision Inbox, `src/server/human-auth/`). A `kind: human` review on the agents' route is refused; the owner's route refuses any request without that session.

An approval can't carry blocking findings. An open blocking finding blocks the merge, even after a push, until its reviewer reviews again or the owner resolves it (never in the PR's author's name). Resolving findings, releasing holds and merging are the owner's too; adding a hold is open to anyone, since it only stops merges. Every review, resolution and merge records the request's remote address and user agent, and the owner session for the owner's actions.

### Test integrity check

Lair checks every PR, in every tier, at each new head, and records the result as a review by `lair:test-integrity`. Its checks are heuristics, so only its `high` and `critical` findings block, and only in `integrity.blocking_tiers` (default `[red]`); the rest are advisory. Only the owner can dismiss one. It flags, with file and line (severity in brackets):

- `self-asserting-test` [high]: a test whose assertions can only check values it built itself or fakes' recorded calls, because it imports no production module that it actually uses (its imports are test libraries, fakes, type-only, mocked with `vi.mock`/`jest.mock`, or never referenced). Checked for JavaScript/TypeScript and Python, where a test must import what it tests. Relative imports count as production code, and so do other packages unless they are known test libraries; add your own package prefixes (such as `@/`) to `integrity.production_imports`;
- `skipped-test` [high], `focused-test` [medium]: an added skip, disable or `.only` (Jest, Vitest, Mocha, pytest, unittest, JUnit, Go, Rust, .NET);
- `assertion-weakened` [high], `tolerance-widened` [medium], `assertion-removed` [medium]: an exact check replaced by a weaker one (`toBe(42)` becoming `toBeDefined()`, `toHaveBeenCalledWith(...)` becoming `toHaveBeenCalled()`, `assertEqual` becoming `assertTrue`), a wider tolerance, or fewer assertions than before;
- `test-removed` [high]: fewer test cases than before, or a deleted test file. A deleted file whose test cases all appear in a test file the same PR adds (a move the host didn't detect as a rename) is reported as [low] instead;
- `suite-loosened` [high]: exclusions added to a test runner config, or a coverage threshold lowered;
- `error-swallowed` [medium]: an empty `catch` or `except: pass` added in test code.

What it can't see (a review still has to):

- it reads imports, not behaviour: a production import that the test uses only through `vi.spyOn`, or partly mocks, counts as exercised, and so does a test of fakes that also calls one real helper;
- a file that imports a browser or HTTP driver (`@playwright/test`, `playwright`, `cypress`, `puppeteer`, `selenium-webdriver`, `webdriverio`, `supertest`) is taken to drive a running app and skips `self-asserting-test`;
- other languages get every check except `self-asserting-test`, and it pairs a removed assertion with the added one in the same place, so a reordered test can show a false `assertion-weakened`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `integrity.enabled` | boolean | `true` | Run the check |
| `integrity.blocking_tiers` | array | `[red]` | Tiers whose findings block |
| `integrity.test_files` | array | the `test` kind | Globs for test files |
| `integrity.production_imports` | array | `[]` | Import prefixes that are the project's own code |
| `integrity.ignore` | array | `**/e2e/**`, `**/cypress/**`, `**/playwright/**`, `*.e2e.*`, `*.cy.*` | Paths it skips (end-to-end suites drive a running app) |

### Merge policy

A merge happens only when all of these hold, and a refusal lists each one that doesn't:

- the PR is open, not a draft, and targets the default branch (`default_branch`, else the host's);
- every gate in `merge.gate.required` passed at exactly the head sha (a pending, skipped or older result doesn't count);
- the tier's required reviews are present at the head, nobody's latest review at the head requests changes, and no blocking finding is open;
- the host reports the branch mergeable and, with `require_up_to_date`, it contains the target branch's tip;
- no hold applies: a hold added through the API, or, with `hold_when_default_red`, a failed required gate on the default branch's tip. While it is red nothing merges, unless `hold_exempt_labels` is set (it is empty by default) and the PR carries one of those labels **and** is a plain revert: its title starts with `Revert "` and every commit says `This reverts commit <sha>`. A label alone is easy to add, so it is never enough.

The merge request must confirm (`confirm: true`) and name the head sha it was shown; if the head moved since, it is refused.

`merge.gate.source: checks` reads the host's check runs at the head. Each `required` entry is `{name, app}` (or just the name, meaning `app: github-actions`), and only a check run by that name **created by that app** (its slug or numeric id) counts. Commit statuses count only when posted by an account in `status_creators` (empty by default). This matters because anyone whose token can write statuses, or who can install an app, can post a "success" under any name; results from other apps and accounts are ignored, and the status says how many were. The red default branch hold reads the same source.

`merge.gate.source: signed` reads gate results that a Lair node signed and posted to `POST /api/review/gate-results`, verified with `node_keys` (node id to public key) and `pipeline_versions` (pipeline id to version); a result's `projectId` must be the Lair project name. A result can't be forged without a node's key, so prefer `signed` for projects with red-tier code (money, auth, migrations), where a forged check is most costly.

### Merge method

- `local`: a fresh clone of the target branch, `local_strategy` `ff-only` (the target must not have moved) or `squash` (one commit by `identity`, which a squash requires), then a push. Squash commits are not signed. Over https the host token is passed to git in the environment, never in a URL or argv.
- `host`: the host's own merge (`host_method`: `squash`, `merge` or `rebase`) at the exact head sha. It is refused unless `host_email_private: true` says the host account's commit email is private, because the host writes the new commits with identities Lair can't fully check. On GitHub:
  - `squash`: one commit **authored** as the account that opened the PR, **committed** by GitHub (`noreply@github.com`);
  - `merge`: the PR's commits, plus a merge commit authored as the account that owns the token and committed by GitHub;
  - `rebase`: the PR's commits with their authors kept, re-committed by GitHub.

  Lair checks the PR's commits as below and, for `squash` and `merge`, the authoring account's *public* email (refused if it shows one outside `allowed_emails`). An account with no public email may still commit with a private one, which only `host_email_private` can vouch for.
- `auto` (the default): `host` when `host_email_private: true`, otherwise `local`. A private repository is no exception: a repository made public later publishes its whole history.

Before anything is published, Lair checks every commit that would land on the target branch: its author and committer emails, and any address in its message (such as `Co-authored-by:` trailers), must match `allowed_emails` (globs, case-insensitive). The default is `identity.email` plus `*@users.noreply.github.com`. A commit that doesn't match stops the merge before the push, the refusal names the commit and a masked address, and Lair raises a `security` decision.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `merge.gate` | object | required | `{source: checks, required: [{name, app}], status_creators}` or `{source: signed, required: [pipeline ids], node_keys, pipeline_versions}` |
| `merge.require_up_to_date` | boolean | `true` | The PR must contain the target branch's tip |
| `merge.method` | `auto` \| `host` \| `local` | `auto` | See above |
| `merge.host_method` | `squash` \| `merge` \| `rebase` | `squash` | The host merge's method |
| `merge.local_strategy` | `ff-only` \| `squash` | `ff-only` | The local merge's strategy |
| `merge.host_email_private` | boolean | unknown | Set `true` only when the host account's commit email is private; required for host merges |
| `merge.identity` | `{name, email}` | — | Who a local squash commit is by |
| `merge.allowed_emails` | array | identity + noreply | Addresses allowed in published commits |
| `merge.clone_url` | string | from `repo` | What the local merge clones and pushes to |
| `merge.work_dir` | string | `data/review` | Where temporary clones go |
| `merge.hold_when_default_red` | boolean | `true` | Hold merges while the default branch's gate is red |
| `merge.hold_exempt_labels` | array | `[]` | Labels that let a proven revert merge while it is red |

Other keys: `provider` (`github`), `api_url` (default `https://api.github.com`), `token_env` (default `GITHUB_TOKEN`), `token_cmd` (an argv printing the token, used when `token_env` is unset), `default_branch`, `authors.models` (agent id to model). Unknown keys are config errors; a project with an invalid `review:` block has reviews off, and `GET /api/review/status` shows the errors.

### Reviewers and the Decision Inbox

`POST /api/review/prs/:number/request-reviews` asks for every missing review at the head, once per head: a named or peer reviewer agent, or the author's self-check, through the agent assigner, and a human through the Decision Inbox. Each agent assignment carries a random token, which the assigner must hand only to the agent doing the review; Lair stores only its hash. An assignment for a named agent (or the author's self-check) is that agent's; one for any peer binds to the first agent, other than the author, that reviews with it. A slot is asked for again at the same head only after its assignee reviewed without filling it (for example on the author's model when `different_model` is set). Until those modules are wired in, the requests are published on the event bus as `review.assignment_requested` and `review.decision_requested`. The assignment event carries the token, and the event bus is internal to the server: it is not served over HTTP. Other events: `review.submitted`, `review.invalidated` (a push made reviews stale), `review.merged`, `review.merge_refused`.

### Review API

`?project=` defaults to the default project. Routes marked (owner) need the owner's session (`X-Lair-Owner-Session`, from the dashboard), and `/api/review` is in `OWNER_ONLY_PREFIXES`, so no CORS is granted for it:

- `GET /api/review/status`: on or off, config errors, repository, read-only
- `GET /api/review/prs`: open PRs with the tier and verdict of their last evaluation at the current head
- `GET /api/review/prs/:number`: the evaluation: tier and matched rules, required and present reviews, reviews, findings, the gate at the head, holds, every condition, and the merge plan
- `POST /api/review/prs/:number/reviews` (agents) with `{reviewer, head_sha, verdict, summary, findings, assignment_token}`, and `POST /api/review/prs/:number/request-reviews`
- `POST /api/review/prs/:number/owner-review` (owner) with `{reviewer: name, head_sha, verdict, summary, findings}`
- `POST /api/review/prs/:number/merge` (owner) with `{confirm: true, head_sha, by}`: 200 when merged, 409 with the reasons when refused, 403 without the owner's session or for a read-only project
- `POST /api/review/findings/:id/resolve` (owner) with `{by: name, status: resolved|dismissed, note}`
- `GET /api/review/holds`, `POST /api/review/holds` with `{reason, pr?, by}`, `POST /api/review/holds/:id/release` (owner) with `{by}`
- `POST /api/review/gate-results` (a signed gate result), `GET /api/review/merges`

## Agents

> Off by default. With `enabled: true`, Lair starts the agent runs you request itself (one process per run, no shell) and supervises them: claims, locks, session recovery, failover and budgets ([design](design/autonomy.md#6-agents-budgets-failover-and-session-recovery-module-agents)). A `read_only: true` project is shown but never started, stopped, released or broken.

A run is requested for an agent (a `dragons:` entry or a `dragons.txt` line) and a task, with a prompt: by the owner (`POST /api/agents/runs`, with an owner session) or by another Lair module, in-process. Lair starts it with the agent's adapter (`start_cmd`, see [Agents](agents.md#agent-adapters)), its model, and the prompt file (`prompts_dir`). The process's output goes to `agents_dir/<agent>-<UTC>.log`, the log the dashboard and the watchdog read. The command must run the agent in the foreground: Lair supervises the process it started, so a launcher that starts the agent in the background and exits looks like an agent that died on start. A request's `model`, when given, must be one the project names for that agent (its own, or a fallback's).

**The agent's environment is built, not inherited.** It gets `PATH`, `HOME`, `USER`, `LANG`, `TMPDIR`, `TERM` and `SHELL` from the server's environment, the variables listed in `env_passthrough` (a provider API key its CLI needs, say), and its run's own: `LAIR_RUN_ID`, `LAIR_TASK`, `LAIR_AGENT`, `LAIR_SESSION_ID`, `LAIR_SESSION_MODE` (`new`, `resume`, `fresh`), `TASK`, `MODEL`, and the adapter's `session_id_env` set to the session id. Nothing else of the server's environment reaches an agent: no `LAIR_NODE_TOKEN`, no other `LAIR_*` variable in any letter case (`env_passthrough` refuses them), and nothing else you exported before starting Lair.

- **Claims.** A task is claimed by exactly one run. The claim is owned by a process: the Lair server while the run starts, then the agent's process. An owner is a pid **and** that process's start time, so a pid the system gave to another process is not the owner. A second request for a claimed task is refused (HTTP 409) while the owner lives; a claim whose owner is dead is released and logged. An owner is only judged dead on a process reading taken after its claim was read, so one that claimed a task a moment ago is never mistaken for a dead one. A run that loses its claim (released from the Agents view, say) stops itself. One agent runs one task at a time. Task ids are 1 to 128 letters, digits, `.`, `_`, `-`, `/`, `:` or `#`, start with a letter or digit, and have no `.` or `..` segment.
- **Locks.** `agents.locks` are lock files every run takes before it starts (`hold: launch`, released once the agent runs) or for as long as the agent runs (`hold: run`, owned by the agent's process). Lair writes `pid=<pid>`, `started=<ISO time>` and `owner=<who>` and creates the file exclusively. A lock whose holder is dead (not running, or its pid now belongs to a process that started later) is broken: at once when a run waits on it, and on the second check in a row that finds it dead when none does (an external launcher's lock, say). A holder is only judged dead on a process reading taken after its lock was read. Every break is logged as a `lock_broken` event with the holder, and counted. Legacy locks are read too: a file holding only a pid, or a directory with a `<pid_file>` (as the watchdog's locks), is broken when that pid is dead; one with no pid at all is broken once it is `stale_minutes` old, and only when a run waits on it, unless the lock sets `break_without_waiter: true`. A lock directory is removed only when it holds nothing but its pid file (nothing is deleted recursively); one with other files is left in place. A run that waits on a lock shows the lock, its holder pid and whether it is alive, and, for a lock with no pid, when it will be broken.
- **Never started.** A run with no live agent process `start_timeout_minutes` after Lair began starting it (time over budget or with no usable profile doesn't count) is `never_started`, with the reason: the lock it waited on and its holder, or the spawn error. It is retried after `retries.backoff_seconds`, doubling up to `retries.max_backoff_seconds`, `retries.max_retries` times; then the task is escalated.
- **Hung, dead on start, crashed.** A running agent is hung by the watchdog's rule (`agent_hung`: its newest log and its process silent for `hung_minutes`), and an agent WAITING on a gate that has no result yet is never hung. A hung agent gets SIGTERM, then SIGKILL after `stop_grace_seconds`. A process that ends with exit code 0 completed. One that ends within `dead_on_start_seconds`, or with an empty log, died on start; any other end is a crash. A run that ended while Lair was restarting has no exit status: if the agent's latest queue line is `DONE <task>` it completed, otherwise it is escalated, never restarted (it may have finished). Every failure restarts the task: with the same session (the adapter's `resume_flag`) up to `recovery.same_session_restarts` times, then in a fresh session up to `recovery.fresh_sessions` times, then it is escalated. A fresh session moves the agent's `session_dir` aside to `<dir>.aside-<UTC>` (it is never deleted) and starts from a resume summary written into the prompt: the task card, the previous attempts, the branch state (`branch_state_cmd`), the agent's latest queue lines and its last gate's log, and the previous session's last output. Restarts wait `recovery.backoff_seconds`, doubling up to `recovery.max_backoff_seconds`.
- **Failover.** An agent's profiles are its own adapter and model, then `agents.fallbacks.<agent>` in order. A run whose log's last lines match a rate limit or provider error (`failover.*_patterns`) when it exits, or whose log has been silent for `failover.silence_seconds` on such a last line, is stopped and the task moves to the next profile, with a resume summary, as a `failover` event (from, to, the line). The agent's own output triggers this, so it is bounded: a task fails over at most `failover.max_failovers` times and is then escalated, and its restart counters carry over (failing over never buys more restarts). The provider that failed is skipped for `failover.cooldown_minutes` by the agent whose run hit it, and by every agent only once runs of two or more agents hit it within that time; a provider the fleet budget has paused or rate limited is skipped too. Only when every profile is unusable is the owner asked (once), and the task waits for the first cooldown to end. Make fallbacks no dearer than the primary: a failing agent moves its work to them.
- **Budgets.** Token and cost limits per UTC day and month, for the project (`budgets.project`) and for each agent (`budgets.agent`, overridden per metric by `budgets.per_agent.<id>`). Usage comes from the fleet budget: every cost recorded there with a project (and agent) is counted, including the usage Lair reads from run logs with `usage_patterns` (named groups `tokens` and `cost`, each match adds), which it records through the fleet budget. A soft limit is a `budget_warning`, once per period. A hard limit stops new runs and restarts for that scope (running agents continue) and raises a `spend` decision, once per period. **These budgets are advisory** while usage comes from run logs: the agent writes that text, so it can under-report (amounts are never counted below zero). They become reliable once providers or adapters report usage to the fleet budget themselves; keep a spending limit at the provider too.
- **Decisions.** They go to the [Decision Inbox](#decision-inbox) as module `agents`, and the owner's answer is carried out:
  - an escalated task (`escalation`, one per escalation of a task): `fresh_session` starts it again in a fresh session (if that fails too, Lair asks again), `release` leaves it unclaimed;
  - every profile failing (`escalation`, once per task): `wait` keeps it waiting for the cooldown, `stop` ends the waiting run and frees the task;
  - a hard budget limit (`spend`, once per scope, metric and period; answering needs `confirm: true`): `allow` lets new runs and restarts in that scope start past the limit until the period ends, `wait` keeps them waiting;
  - a task [fill](#fill) holds for you (`escalation`, once per hold): `start_again` lets fill start it again, `keep_held` keeps it held.
  When the inbox refuses a decision (its open-decision cap, say), it is written to `inbox_file` as an `- OWNER? ...` entry with the evidence instead.
- **The watchdog.** The watchdog's `agent_hung` and `orphan_claim` detectors leave an agent with an active run here to this module (their SLO detail says so), so one failure is never handled twice.
- **Restarts and hosts.** When Lair stops, the agents keep running; after a restart it finds them again by pid and start time and carries on supervising them. Liveness is read from this machine's process table, so one data directory (`data/agents.db`) and its lock files belong to one host: don't share them between machines, or one host would judge the other's processes dead.

```yaml
agents:
  enabled: true
  session_dir: "{agents_dir}/sessions/{agent}"
  branch_state_cmd: ["git", "-C", "{repo}", "status", "--short", "--branch"]
  env_passthrough: [EXAMPLE_PROVIDER_API_KEY]   # what the agents' CLIs need, nothing more
  locks:
    - name: session-store
      path: /home/user/my-project/work/session.lock
      hold: launch
  fallbacks:
    worker-a:
      - { adapter: other-cli, model: example-model-b, provider: provider-b }
  providers:
    my-agent: provider-a          # adapter id -> provider (default: the adapter id)
  usage_patterns:
    - "tokens used: (?<tokens>[0-9,]+)"
    - "cost: \\$(?<cost>[0-9.]+)"
  budgets:
    project: { monthly_cost: { soft: 400, hard: 500 } }
    agent: { daily_cost: { soft: 15, hard: 20 } }
    per_agent:
      worker-a: { daily_tokens: { hard: 2000000 } }
```

### Agents options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Run the agents module for this project |
| `interval_seconds` | number | `15` | Seconds between checks |
| `start_timeout_minutes` | number | `10` | A run with no live agent process this long after starting began is never-started |
| `dead_on_start_seconds` | number | `60` | A process that ends this soon after it started died on start |
| `hung_minutes` | number | `watchdog.hung_minutes` (`45`) | Silence limit for a running agent |
| `stop_grace_seconds` | number | `30` | SIGTERM, then SIGKILL after this long |
| `pid_start_tolerance_seconds` | number | `5` | How far a process's start time may be from its owner's recorded one |
| `session_dir` | string | — | The agent's session directory, moved aside for a fresh session. `{agents_dir}`, `{agent}` and `{repo}` are replaced; relative to `repo` |
| `branch_state_cmd` | array | — | Prints the branch state for a resume summary. `{task}`, `{agent}`, `{repo}` |
| `command_timeout_seconds` | number | `30` | Timeout for `branch_state_cmd` |
| `env_passthrough` | array | `[]` | Variables of the server's environment an agent also gets (never `LAIR_*`) |
| `recovery.same_session_restarts` | number | `2` | Restarts with the same session after a failure |
| `recovery.fresh_sessions` | number | `1` | Then restarts in a fresh session, then escalate |
| `recovery.backoff_seconds` | number | `30` | First restart delay, doubling |
| `recovery.max_backoff_seconds` | number | `1800` | Longest restart delay |
| `retries.max_retries` | number | `3` | Never-started retries, then escalate |
| `retries.backoff_seconds` | number | `60` | First retry delay, doubling |
| `retries.max_backoff_seconds` | number | `3600` | Longest retry delay |
| `locks` | array | `[]` | `{name, path, pid_file: "pid", hold: launch \| run, stale_minutes: 30, break_without_waiter: false}` |
| `failover.rate_limit_patterns` | array | see below | Regular expressions (case-insensitive) for a rate limit |
| `failover.provider_error_patterns` | array | see below | Regular expressions (case-insensitive) for a provider error |
| `failover.silence_seconds` | number | `120` | A live run fails over only when its log's last line matches and the log was silent this long |
| `failover.cooldown_minutes` | number | `30` | A provider that failed is skipped this long |
| `failover.max_failovers` | number | `3` | Failovers per task; the next one is escalated |
| `fallbacks` | map | `{}` | Agent id -> profiles `{adapter, model, provider}` to fail over to, in order |
| `providers` | map | `{}` | Adapter id -> provider name, for cooldowns and the fleet budget |
| `usage_patterns` | array | `[]` | Regular expressions with `(?<tokens>...)` and/or `(?<cost>...)`, read from run logs |
| `budgets.project`, `budgets.agent`, `budgets.per_agent.<id>` | map | — | `daily_tokens`, `daily_cost`, `monthly_tokens`, `monthly_cost`, each `{soft, hard}` |
| `fill` | map | off | Start runs from a task list: see [Fill](#fill) |

The default patterns look for an error, not the words alone, so an agent writing about rate limiting in its own work doesn't trigger a failover: a rate limit is `rate limit ... exceeded|reached|error|retry`, `exceeded|reached|hit ... rate limit`, `error|status|http 429`, `429 too many requests`, `quota exceeded|exhausted` or `usage limit reached|exceeded`; a provider error is `overloaded_error`, `model is overloaded|unavailable`, `api error ... 5xx` or `status|http 500|502|503|504|529`. Tune them to your adapters' output.

Unknown keys, invalid regular expressions, a usage pattern without a named group, a fallback naming an unknown adapter, a `LAIR_*` name in `env_passthrough`, a soft limit above its hard limit, or a `fill` block that is enabled but incomplete (see below) are config errors: the project's agents module doesn't start, and `GET /api/agents/status` shows the errors. Lair reads the config at startup.

### Fill

> Off by default. With `fill.enabled: true`, Lair starts agent runs itself from a task list, so the project needs no launcher loop of its own. Fill only asks for runs: they are started and supervised like any other run (claims, locks, never-started retries, recovery, failover, budgets and escalation all apply unchanged).

`tasks_file` holds one task per line, `<agent>|<name>|<task>|<description>`: the agent id, a display name, the task id and a description (it may be empty and may contain `|`). Blank lines and lines starting with `#` are skipped. Every `interval_seconds` fill reads the file and looks at each line in order:

- An agent that isn't in `fill.agents` is never started (`not allowlisted`). The allowlist is required, so you can move agents over one at a time while another launcher still runs the rest.
- A task with an active run of the line's agent is `started`; one with another agent's run or another claim on it is `claimed`. Neither is started again.
- A task that is `done` is not started again: `done_pattern` matches a queue line (`queue_file`) written since the task was last started (the whole file for a task Lair never ran). Lines are matched as the module's own DONE check reads them: trimmed, and case-insensitively, but the task id must be in the matched text exactly as written (task ids are case-sensitive). Once fill has seen a task done it keeps that in the store, so rotating or truncating the queue file, or a done line falling out of the 4 MB fill reads, never restarts a finished task. Editing the task's line in `tasks_file` drops what was kept, but the next check finds the done line again while it is still in the queue file. Agents write the queue file, so a done line only keeps fill from starting a task again; it proves nothing else. To overrule a done line you don't trust, request a run of the task yourself (Agents view): that is a new start, so only lines written after it count, and fill carries the task on from there.
- A run that exits 0 without writing the done line (an adapter that stops on a usage limit with exit code 0, say) is started again with fill's prompt (built from `prompt_files` again, not the prompt of a run you requested), after `backoff_seconds`, doubling up to `max_backoff_seconds` (`held: backoff`, with the time). After `max_completions_without_done` such runs in a row, fill holds the task (`held: no_done`) and raises one decision in the [Decision Inbox](#decision-inbox) with those runs and the last run's last output lines: "Let fill start it again" (it counts from zero) or "Keep it held" (recommended).
- A task whose last run ended in any other way than completing is `held: owner`: it is yours to resume, and fill never restarts it by itself. A run that was escalated has its own decision already (`escalation`, see Decisions above), and one you stopped or whose claim you released is your own doing; a run whose claim was lost to another holder, without you releasing it, gets one decision from fill. A run that dies is restarted by the module's recovery, not by fill, so there is never a second run of one task.
- You lift an `owner` or `no_done` hold with the decision's answer, or with "Release hold" in the Agents view (`POST /api/agents/fill/release`, owner only); requesting a run of the task yourself works too. Either lifts the hold only while the run it is about is still the task's latest: once the task has moved on (you answered its escalation with a fresh session, say), the release is refused and the next check shows where the task is now.
- Otherwise the task is started when its agent has no active run, fewer than `max_active` runs fill started are active, and `capacity_cmd` (when set) exits 0. Its prompt is the contents of `prompt_files`, in order, separated by a blank line (`default_instructions` and the agent's `instructions` come first, as for every run). It is requested through the module's in-process request, never over HTTP. A line that waits for any of these is `held`, with the reason: `busy`, `max_active`, `capacity` (the capacity command's first output line), `prompt` (a refused prompt file), `read_only`, or `refused` (the refused request: over budget, say).
- A line that doesn't parse, names an invalid agent or task id, or repeats a task is `malformed`: it is reported, and the other lines are still filled.

The Agents view shows fill's lines, with each line's state, why it is held, and a "Release hold" button for the holds that are yours to lift.

**Prompt files stay inside `prompts_dir`.** In each path `{prompts_dir}`, `{agent}` and `{task}` are replaced, and a relative path is relative to `prompts_dir`. A path with a `..` segment is a config error; at run time a path outside `prompts_dir`, a symlink that leads out of it (one that stays inside is fine), anything but a regular file, or a file over 200 KB is refused and the line is held with the reason. Their text is used as it is: placeholders are not replaced inside it (the agent gets `LAIR_TASK` and `LAIR_AGENT` in its environment), and a line's description is shown in the status, never put into a prompt. Keep `tasks_file` and `prompts_dir` where the agents can't write (not in the repository they work in): whoever edits them chooses what the allowlisted agents work on.

**The capacity command** is an argv, run without a shell before each start, with `command_timeout_seconds` as its timeout. Exit 0 means there is capacity; any other exit code, or a timeout, holds every line that would start in that check, with its first output line as the reason.

`agents.fill_started` and `agents.fill_held` events go on the event bus (and into the agents store): one when fill starts a task, and one when a line becomes held or is held for another kind of reason, not on every check. `fill_done` (a task seen done) and `fill_released` (you lifted a hold) are kept in the agents store. Bounds: the tasks file is read up to 256 KB, 200 tasks and 2,000 characters a line; the queue file's last 4 MB are searched, each line cut at 1,000 characters. A queue file that was rewritten (not appended to) since a task's start is searched whole. Task ids are not reused: a task that is done stays done.

```yaml
agents:
  enabled: true
  fill:
    enabled: true
    tasks_file: /home/user/lair-work/my-project-tasks.txt   # outside the repo the agents work in
    agents: [worker-a, worker-b]             # the only agents fill starts
    prompt_files:
      - "{prompts_dir}/restart-addendum.txt"
      - "{prompts_dir}/{agent}.txt"
    max_active: 2
    # The default: the task id ends at whitespace, so "- DONE feat-login-2" doesn't finish feat-login
    done_pattern: "^-\\s+DONE\\s+{task}(?=\\s|$)"
    capacity_cmd: ["/home/user/my-project/scripts/has-capacity"]
    max_completions_without_done: 3
    interval_seconds: 60
```

```text
# agent|name|task|description
worker-a|Alice|feat-login|Build the login form
worker-b|Bob|feat-search|Search page
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `fill.enabled` | boolean | `false` | Start runs from `tasks_file` (needs `agents.enabled: true`) |
| `fill.tasks_file` | string | — | Required when enabled. Lines `<agent>\|<name>\|<task>\|<description>`; relative to `repo` |
| `fill.agents` | array | `[]` | Required when enabled. The agent ids fill may start |
| `fill.prompt_files` | array | `[]` | Required when enabled. Files whose contents, in order, make the prompt. `{prompts_dir}`, `{agent}`, `{task}` |
| `fill.max_active` | number | `1` | Runs fill started that may be active at once (restarts and retries count) |
| `fill.done_pattern` | string | `^-\s+DONE\s+{task}(?=\s\|$)` | Regular expression for a queue line that reports the task done, matched case-insensitively against each trimmed line; the task id must be in the matched text exactly. Must contain `{task}`; `{agent}` too, if you like. Both are inserted as literal text. End the task id at whitespace, not `\b`, `:` or `-`: task ids can contain `-` and `:` |
| `fill.capacity_cmd` | array | — | Exit 0: capacity available; anything else holds, with its first output line as the reason |
| `fill.interval_seconds` | number | `60` | Seconds between fill checks |
| `fill.max_completions_without_done` | number | `3` | Runs in a row that exit 0 without the done line; then fill holds the task and asks you |
| `fill.backoff_seconds` | number | `60` | Wait after such a run before fill starts the task again, doubling |
| `fill.max_backoff_seconds` | number | `1800` | Longest such wait |

A fill block that is enabled without `agents.enabled`, `tasks_file`, `agents` or `prompt_files`, an invalid agent id in `agents`, a `prompt_files` entry with a `..` segment or an unknown placeholder, or a `done_pattern` without `{task}` or that isn't a regular expression is a config error.

### Agents API

`?project=` defaults to the default project.

- `GET /api/agents/status`: per agent its state (`idle`, `starting`, `working`, `waiting_on_lock`, `hung`, `stopping`, `never_started`, `failed_over`, `over_budget`, `failed`) with the detail (for a lock wait: the lock, its holder pid and whether it is alive), its current or latest run, its profiles, claims, budget and recent recoveries; the project's claims, locks (holder, how often broken) and budget; and `fill`: whether it is enabled and running, its last check (and error), how many of its runs are active, and each `tasks_file` line's state at that check (`started`, `done`, `held`, `claimed`, `not_allowlisted` or `malformed`, with the detail; a held line also has its `hold`, and `releasable` for the owner's holds)
- `GET /api/agents/runs?limit=100`, `GET /api/agents/recoveries?limit=100`: runs, and the recovery events (claim releases, lock breaks, never-started, hung, dead on start, crashes, restarts, fresh sessions, failovers, budget alerts, escalations, decisions) with their evidence
- `POST /api/agents/runs` `{agent, task, prompt, model?}`, with an owner session: claim the task and start it on the next check. 400 for a model the agent doesn't have, 409 when the task is claimed or the agent is busy, 403 without an owner session, over budget or `read_only`
- `POST /api/agents/claims/release` `{task, confirm: true}`, with an owner session: the run holding it stops itself
- `POST /api/agents/runs/<id>/fresh-session` `{confirm: true}`, with an owner session: stop the run and start the task again in a fresh session (also for a run that ended, when it is the task's latest)
- `POST /api/agents/tick`, with an owner session: check now, and run a fill check after it when fill is on (the service checks on its own every `interval_seconds`, fill every `fill.interval_seconds`)
- `POST /api/agents/fill/release` `{task, confirm: true}`, with an owner session: lift fill's `owner` or `no_done` hold on a task, so fill starts it again on its next check. 409 when the task isn't held for you at fill's last check, or has a newer run than the one that hold was about; 404 when fill is off
- `GET /api/agents/prompts`, with an owner session: the files in the project's `prompts_dir`, newest first (at most 200), each as `{name, size, modifiedAt, tooLarge}`. Names only, never paths
- `GET /api/agents/prompts/file?name=<file name>`, with an owner session: one of them, `{name, size, text}`. The name is one file name (letters, digits, `.`, `_` and `-`, starting with a letter or digit, no `..`; HTTP 400 otherwise). Only a regular file directly in `prompts_dir`, or a symlink to one there, is read: a symlink to anything outside it, a directory or any other kind of file is refused (HTTP 403), and a file over 200000 bytes, the most a run's prompt may hold, is refused (HTTP 413)

Every POST here is the owner's (starting a run, releasing a claim, a fresh session, an early check, releasing a fill hold), and so are the two prompt-file reads, which read files from disk: they need a browser signed in as the owner (see "Only you answer" in [Decision Inbox](#decision-inbox)), from the dashboard. Any other caller, an agent included, gets HTTP 403, so no process on this machine can put a prompt into a task, stop another agent's run, or read a file through Lair. `/api/agents` gets no CORS. Modules that start runs (the scheduler, the planner) do it in-process through `AgentsManager.requestRun`, not over HTTP. The two actions that stop work, and releasing a fill hold, also need `confirm: true` (HTTP 400 without); the Agents view asks before sending them.

**Starting a run from the Agents view.** The "Start a run" form (shown unless the project is `read_only`) takes the agent, the task id, the model (the agent's own and its fallbacks' models; empty for its default) and the prompt, which you can type or load from a file in `prompts_dir` ("Load a prompt" lists the files there, including the prompts Lair wrote for earlier runs). Start asks for confirmation, then sends `POST /api/agents/runs`; a refusal shows the server's reason with its status: 400 for an invalid task, prompt or model, 403 when this browser is not signed in as the owner, the project is `read_only` or the budget is spent, 409 when the task is claimed or the agent is busy. Until this browser is signed in as the owner (from Decisions), the form is disabled and says so.

## Triage

> Off by default. With `enabled: true` and the default `mode: observe`, triage parses, classifies and records the gate results it gets, and runs none of your commands.

Triage ([design](design/autonomy.md#3-failure-triage-bisect-and-revert-module-triage)) answers "why did this gate fail, and what now?". It stores everything in `data/triage.db`.

**Where results come from.** Every local process can reach the server, including the agents whose work triage judges, so triage only believes results from a trusted source:

- **In-process (trusted):** the gate pipelines (`pipelines:`, [Gate pipelines](#gate-pipelines)) hand over each finished job's result as a `gate.completed` event, with its run id (which answers a re-check that started that run). Only in-process results may name the author agent, the PR and the base commit. The pipelines send neither the test reports nor the agent yet: their failures are read from the steps' console output and are not routed to an agent.
- **Signed (over HTTP):** `POST /api/triage/results` takes only a `SignedGateResult` from a node listed in `trusted_nodes` (its Ed25519 public key file), verified with the gates module's signature check. Test reports must be covered by the signature: the signed result lists each report's SHA-256 in `result.reports`. Only `recheckId` is read from the rest of the body: the base commit comes from `git merge-base`, the changed files from `git diff`, and no agent is routed to.
- An unsigned result, a tampered one, one from an untrusted node, or one signed for another project gets HTTP 403.
- **The branch is a label.** A result for `default_branch` counts as that branch's run only when its commit is in the branch's history (the local branch, or a remote's branch of exactly that name). Otherwise it is triaged as a change, with a note. A green run ends an incident only at a commit that contains the red one.

**Status: informational.** Nothing reads a failure's `blocking` yet: the merge policy will once it consumes triage (docs/design/autonomy.md §5). Until then triage records verdicts, asks for re-checks, opens tasks and decisions, and reverts per `bisect.revert`.

1. **Causes.** JUnit XML reports (JUnit, Surefire, Gradle, pytest `--junitxml`, the vitest and jest JUnit reporters) and the console output of every failed step (Gradle, vitest, jest, pytest) are parsed into causes: the error, its `Caused by` chain, field errors, the failing tests and the project's source locations. A context or bootstrap failure (an application context that can't start, a setup error, a test file that can't load) is **one** cause, however many tests it failed: later tests that only say "failure threshold exceeded" join the first failure's cause. A failed step that no parser reads becomes one cause with its exit code and the error lines of its output. Output is written by the code under test, so the parsers read at most the last 20,000 lines of a log, each cut to 2,000 characters, with patterns that run in linear time, and the XML reader matches a closing tag against at most the 64 innermost open elements.
2. **Passes.** A test passed at a commit only when a report lists it as passed, or a gate run ran (and passed) the step it failed in. A lint-only run proves nothing about a unit test.
3. **Classes**, decided per cause, in this order, each with the lines and facts that decided it:

| Class | When | Action (`actions.*`) | Blocks a change |
|-------|------|----------------------|-----------------|
| `infra` | An infrastructure pattern (below) matches the error, its `Caused by` chain or its log lines; a step was killed (exit 137 or 143) or timed out with nothing more specific; or a timeout while the machine's load per core was at least `overload_per_core` | `recheck`: ONE re-check of only the failed test classes (or, without tests, only the failed steps) at the same commit, when there is capacity, up to `recheck.max_retries`. Never a full re-run. It unblocks the failure only when its answer lists every requested test as passed (or, for steps, every requested step passed); an answer that only says "passed" is `unproven`. After the last re-check: back to the author when the base commit's own run passes, otherwise a decision for the human | Until a re-check passes |
| `flaky` | Every failing test of the cause passed at the same commit within `flaky.window_minutes` (before or after), or, off the default branch, is quarantined | Recorded. Flaky `flaky.ticket_after` times in a row (default 2): one reliability task with a deadline (`ticket_deadline_days`, default 7), and the test is quarantined (it runs, it no longer blocks a change), up to `flaky.quarantine_cap`. The quarantine ends at that deadline, after `release_after_passes` passes in a row (default 5), or when the owner releases it. On the default branch a quarantined test that fails still counts, and opens an incident | No |
| `pre-existing` | The same tests (or the same cause) failed in the base commit's own gate run of the same pipeline, no older than `base_max_age_hours`; or the default branch has an open incident with them and the base commit includes its red commit. Without a base result, nothing is pre-existing | `fix_task`: one fix task on the default branch per cause, however many changes hit it | No |
| `code` | Anything else, with the changed files it is near (the same file, a test of a changed file, or the same directory). Low confidence when there is no base result to compare with | `route`: back to the author agent (from a trusted result) with the failing tests, the error, its root cause, source locations and the log lines | Yes |

4. **The default branch.** A red gate result on `default_branch` with `code` causes opens an incident for its pipeline (`pipelineId`). Triage takes that pipeline's last green run on the branch that ran the failing steps, lists the first-parent commits since then (`git rev-list --first-parent`), and bisects them, running only the failing tests at each probe (as re-checks, so capacity and `max_concurrent` apply, and an answer must show the target tests passing to count as a pass). A probe that fails on infrastructure is run again; one that can't decide is skipped. The culprit is **proven** when it is the only commit left, the one before it passed, and it failed with the same cause twice (a confirmation run). Then, per `bisect.revert`: `auto` opens a revert with `commands.open_revert`, `propose` (the default) asks through a decision, `off` records it. The culprit's author agent gets the cause either way. **A merge that is not proven is never reverted without the owner's explicit decision**, and a merge the owner protected (in the Triage view) or listed in `bisect.protected_merges` is never reverted automatically. A `Lair-Protected: yes` line in the merge message is only a hint (whoever merged it wrote it): it turns an automatic revert into a proposal. Only a green run of the same pipeline that ran the failing steps resolves the incident and cancels its probes.

Decisions go to the [Decision Inbox](#decision-inbox) (the owner answers `revert`, `keep`, `revert-<n>` for a suspect, or `rerun` for an infrastructure failure, and triage acts on the answer), or to `commands.raise_decision` when set, or, without either, as `- OWNER? ...` lines to `decision_file` (default: `inbox_file`). Asking the human is allowed in observe mode, as the watchdog's escalations are.

**Commands never run inside triage's own queue.** Its decisions are short store transactions; commands, decisions and events run afterwards. The `recheck` command must **start** the run and return at once (print the run's id); it is stopped after `recheck.request_timeout_seconds` (default 30). The run's answer is a gate result whose id is `{request}` (or the run id it printed), with `recheckId` set to `{request}`: in-process, or signed. It may arrive while the command is still running, and it still counts when it comes after the command timed out, until `recheck.timeout_minutes`. A result without `recheckId` answers the waiting re-check whose id, or run id, it carries.

**Calls survive a restart.** Agent messages, tasks, reverts and decisions are written to an outbox table in the transaction of the decision that makes them, and removed in the one that records their result. A call a killed process never made is made on the restarted server's first tick; one that was running when the process died may be made again. `POST /api/triage/results` returns the record at once, and its re-checks and messages run in the background.

```yaml
triage:
  enabled: true
  mode: act                    # observe (default) | act
  default_branch: main
  trusted_nodes:               # who may POST signed results
    - id: ci-runner-1
      public_key_file: ./data/keys/ci-runner-1.pub.pem   # not in the project's repository
  infra_patterns:              # yours first; one with a built-in id replaces it
    - id: license-server
      kind: network            # network | container | oom | runner | disk | load
      pattern: "license server .* unreachable"
  recheck:
    max_retries: 1
    max_load_per_core: 1.5     # wait for capacity above this
    min_free_memory_mb: 2048
  bisect:
    revert: propose            # auto | propose | off
  commands:
    recheck: ["./work/bin/gate-recheck.sh", "--sha={sha}", "--request={request}", "--steps={steps}", "{classes}"]
    notify_agent: ["./work/bin/agent-mail.sh", "{agent}", "{message}"]
    create_task: ["./work/bin/task-add.sh", "{kind}", "{title}", "{body}"]
    open_revert: ["./work/bin/revert-pr.sh", "{sha}", "{incident}"]
```

The built-in infrastructure patterns (case-insensitive regular expressions, `default_infra_patterns: false` drops them): `connection-timeout` (connect timed out, `SocketTimeoutException`, `ETIMEDOUT`), `connection-refused` (`ECONNREFUSED`, `java.net.ConnectException`), `connection-reset`, `dns` (`EAI_AGAIN`, `ENOTFOUND`, could not resolve host), `download` (dependency downloads failing with 5xx or a read timeout), `container-start` (container startup failed, cannot connect to the Docker daemon), `out-of-memory` (`OutOfMemoryError`, heap out of memory, `ENOMEM`, `OOMKilled`), `runner-died` (runner lost, forked VM or test worker died, a shutdown signal) and `disk-full` (`ENOSPC`). Context patterns (`context_patterns`, `default_context_patterns`) decide what counts as a context failure.

### Triage options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Triage this project's gate results |
| `mode` | `observe` \| `act` | `observe` | `observe` runs no command: every action is recorded as `planned`, with the argv it would run. `act` runs them, unless the project is `read_only: true` |
| `default_branch` | string | `main` | The branch whose red results open incidents |
| `trusted_nodes` | array | `[]` | `{id, public_key_file}`: the nodes whose signed results `POST /api/triage/results` accepts (the PEM public key; relative paths resolve against the Lair working directory). Keep the keys under Lair's `data/` or another place agents can't write: a key inside the project's repository is refused. A refused or unreadable key stops triage for the project |
| `interval_seconds` | number | `60` | How often waiting re-checks and bisect probes are retried and ended quarantines released |
| `command_timeout_seconds` | number | `120` | Timeout for each command but `recheck` |
| `infra_patterns` | array | `[]` | `{id, kind, pattern}` |
| `default_infra_patterns` | boolean | `true` | Use the built-in infrastructure patterns too |
| `context_patterns` | array | `[]` | Regular expressions for context and bootstrap failures |
| `default_context_patterns` | boolean | `true` | Use the built-in context patterns too |
| `overload_per_core` | number | `2` | A timeout while a trusted result's `context.loadPerCore` was at least this is `infra` (`load`) |
| `base_max_age_hours` | number | `72` | A base commit's gate run older than this is not used to call a failure pre-existing |
| `actions.infra` | `recheck` \| `route` \| `none` | `recheck` | |
| `actions.pre_existing` | `fix_task` \| `none` | `fix_task` | |
| `actions.code` | `route` \| `none` | `route` | |
| `recheck.max_retries` | number | `1` | Re-checks per failure |
| `recheck.max_concurrent` | number | `1` | Re-checks and probes running at once |
| `recheck.timeout_minutes` | number | `120` | A requested re-check with no answer by then expires (and counts as a failed attempt) |
| `recheck.request_timeout_seconds` | number | `30` | The `recheck` command only starts the run; it is stopped after this |
| `recheck.max_load_per_core`, `recheck.min_free_memory_mb` | number | — | Wait while this machine's load per core is above, or its free memory below, these |
| `recheck.capacity_cmd` | array | — | Exits 0 when there is capacity (for example, a check of your CI runners) |
| `flaky.window_minutes` | number | `1440` | A pass at the same commit within this window makes a failure flaky |
| `flaky.ticket_after` | number | `2` | Flaky this many times in a row opens a reliability task |
| `flaky.ticket_deadline_days` | number | `7` | The task's deadline, which also ends the quarantine |
| `flaky.quarantine` | boolean | `true` | Quarantine a test when its task opens |
| `flaky.quarantine_cap` | number | `10` | No more quarantined tests than this |
| `flaky.release_after_passes` | number | `5` | A quarantined test that passes this many times in a row is released |
| `bisect.enabled` | boolean | `true` | Bisect a red default branch |
| `bisect.revert` | `auto` \| `propose` \| `off` | `propose` | What to do with a proven culprit |
| `bisect.max_candidates` | number | `64` | Don't bisect more commits than this |
| `bisect.protected_merges` | array | `[]` | Full commit shas never reverted automatically |
| `bisect.protected_trailer` | string | `Lair-Protected` | A merge whose message has `<trailer>: yes` is proposed for revert, never reverted automatically |
| `commands` | map | `{}` | See below |
| `decision_file` | string | `inbox_file` | Where decisions are appended when there is no Decision Inbox or `raise_decision` |

Unknown keys, an invalid regular expression or an unknown placeholder are config errors; a project with an invalid `triage:` block is not triaged, and `GET /api/triage/status` shows why.

### Triage commands

Each command is an argv array (no shell). Every command also gets `{project}`. A list placeholder (`{steps}`, `{tests}`, `{classes}`, `{options}`) that is a whole argument becomes one argument per item; inside a longer argument it is joined with `,`. A value that would start an argument with `-` is refused. Without a command, a route or a task is still recorded in the store and emitted on the event bus (`triage.routed`, `triage.task_created`), for a module that takes them.

> **Careful with a list after a single-value flag.** `["run", "--tests", "{tests}"]` becomes `run --tests a b c`: most tools bind only `a` to `--tests` and read `b` and `c` as something else. Join the list into the flag's value (`"--tests={tests}"` gives `--tests=a,b,c`), or give the list its own position.

| Command | Placeholders | Runs when |
|---------|--------------|-----------|
| `recheck` | `{request}` (the re-check id), `{purpose}` (`infra` or `bisect`), `{sha}`, `{branch}`, `{gate}`, `{steps}`, `{tests}` (pytest node ids, else `<class>#<test>`), `{classes}` (test classes, files or modules), `{attempt}` | A re-check or bisect probe has capacity. Start the run and return at once, printing its id; the run's result comes back with `{request}` as its id and as `recheckId` |
| `notify_agent` | `{agent}`, `{gate}`, `{sha}`, `{branch}`, `{pr}`, `{record}`, `{message}` | A failure goes back to its author |
| `create_task` | `{kind}` (`fix` or `reliability`), `{key}`, `{title}`, `{body}` | A fix or reliability task opens (once per key while open) |
| `raise_decision` | `{kind}`, `{subject}`, `{question}`, `{context}`, `{recommended}`, `{options}` | A decision is needed and there is no Decision Inbox |
| `open_revert` | `{sha}`, `{branch}`, `{incident}`, `{reason}`, `{pr}` | A proven culprit is reverted (`bisect.revert: auto`), or the owner asks for it. Print the revert PR's URL; it is shown on the incident |

### Sending signed results

A node signs the whole gate result (`src/shared/policy-types.ts` `GateResult`, with `reports` listing each report's name, step and SHA-256) with its Ed25519 key, as `signGateResult()` in `src/server/gates/signature.ts` does, and sends:

```json
{
  "signed": { "result": { "id": "...", "commitSha": "<full sha>", "nodeId": "ci-runner-1", "reports": [{ "name": "TEST-OrderServiceTest.xml", "step": "test", "sha256": "..." }], "...": "..." }, "signature": "<base64>", "nodePublicKey": "<PEM>" },
  "reports": [{ "name": "TEST-OrderServiceTest.xml", "content": "<testsuite ...>" }],
  "recheckId": "<only when answering a re-check>"
}
```

Commit shas are full (40 or 64 hex characters), and a result id is accepted once. The answer is the triage record, its actions, its re-checks and the pipeline's open incident on the default branch.

### Results from an existing gate system

A project whose gates run in its own queue and runner scripts (not Lair pipelines) can still be triaged: after each gate, its runner calls `lair-node gate-result submit`, which builds the `GateResult`, digests the reports, signs it with the same `signGateResult()` and sends it as above. The runner is the node: it holds the private key, and Lair trusts its public key.

1. **Once:** make the node's key pair where agents can't write (not in any repository), and trust it:

   ```bash
   lair-node keygen --out ./data/keys/ci-gates     # writes ci-gates (private, mode 0600) and ci-gates.pub
   ```

   ```yaml
   triage:
     enabled: true
     mode: observe
     trusted_nodes:
       - id: ci-gates
         public_key_file: ./data/keys/ci-gates.pub
   ```

   An existing key is never overwritten, and `submit` refuses a private key that other users can read.

2. **After each gate:**

   ```bash
   lair-node gate-result submit --key ./data/keys/ci-gates --node ci-gates --project my-app \
     --id 20260302T120000Z-backend-1a2b3c4d --pipeline backend \
     --sha 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b --branch feat/orders --status failed \
     --step lint:0:12000 --step test:1:95000 --output test=./out/test.log \
     --report-dir ./out/test-results --report-step test \
     --started 2026-03-02T11:58:00Z --finished 2026-03-02T12:00:00Z
   ```

   Or `--result result.json` with `GateResult`'s field names (`id`, `pipelineId`, `commitSha`, `branch`, `status`, `steps`, `startedAt`, `completedAt`, `pipelineVersion`) plus `reports` and `reportDirs` (paths relative to the file, each a path or `{path, step}`); flags override the file. `lair-node gate-result submit --help` lists every option, and `--dry-run` prints the signed request instead of sending it. From a checkout, run it as `npm run node -- gate-result submit ...`, or `node dist/cli/node.js gate-result submit ...` after `npm run build`.

- **Steps.** `--step <name>:<exit code>[:<duration ms>]`, once per step, in order: exit 0 is `passed`, any other code `failed`; `<name>:skipped` and `<name>:timeout[:<ms>]` are also taken. `--output <step>=<file>` attaches a step's console output (its last 20,000 lines, at most 2 MiB), which triage parses for causes when the step failed. A `passed` status with a failed step is a usage error.
- **Pipeline.** Passes, flaky windows and default-branch incidents are per `pipelineId`, so give each kind of gate (each track of your queue) its own, and keep it stable.
- **Times.** The gate's duration is `--finished` minus `--started` (ISO 8601 or Unix seconds). Without them, `--finished` is now and `--started` is that minus the steps' durations.
- **Reports.** `--report <file>` and `--report-dir <dir>` (every `*.xml` under it; symlinks are not followed) take JUnit XML. Each report's SHA-256 goes into the signed `result.reports`, so the signature covers it. Reports with failures are sent first, up to 20 MiB in all, and a file over 8 MiB is left out with a warning. More files than a result takes (50; Gradle writes one per test class) are bundled per step into `<testsuites>` documents of at most 6 MiB each: the bundles are what is signed and sent.
- **Exit codes:** `0` accepted (it prints the triage record), `1` refused (it prints the server's reason: an untrusted node or key, a repeated result id, triage off for the project), `2` usage (a missing or bad flag, an unreadable file or key), `3` the server is unreachable (`--timeout`, default 30 seconds). A runner should **fail open**: log a refusal or an unreachable server and go on, never change the gate's own result because of it.

`review.merge.gate.source: signed` verifies the same kind of signed result, posted to `POST /api/review/gate-results` (this command sends to triage only). It also checks the `pipelineVersion` against `merge.gate.pipeline_versions` (`--pipeline-version`), and it does not take a passed result with a skipped step or a passed step that took under 10 ms.

### Triage API

`?project=` defaults to the default project:

- `POST /api/triage/results`: a signed gate result, as above (up to 32 MB)
- `GET /api/triage/status`: mode, why commands don't run, config errors, counts per class, pending re-checks, open tasks, quarantined tests, the newest open incident and how many are open, which commands are set, and the trusted nodes
- `GET /api/triage/failures?verdict=&blocking=true|false&sha=&limit=100`, `GET /api/triage/failures/<id>`: each cause's verdict and evidence, the actions taken (with their argv and who acted) and the re-checks
- `GET /api/triage/rechecks?limit=100`
- `GET /api/triage/incidents?status=open|resolved|all&limit=50`, `GET /api/triage/incidents/<id>`: the bisect's candidates, probes, culprit and revert status
- `GET /api/triage/tasks?status=open|resolved|all`, `GET /api/triage/flaky`, `GET /api/triage/protected`

The owner only (the owner's session from [the owner credential](#decision-inbox), from the dashboard; no CORS; HTTP 403 otherwise; each records who acted):

- `POST /api/triage/owner/incidents/<id>/revert` with `{"sha": "...", "acknowledgeUnproven": true}` (both optional): open the revert of the culprit, or of a suspect, which needs `acknowledgeUnproven`
- `POST /api/triage/owner/protected` with `{"sha": "<full sha>", "note": "..."}`, `DELETE /api/triage/owner/protected/<sha>`
- `DELETE /api/triage/owner/flaky/<test key>`: release a quarantined test

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
| `LAIR_DECISIONS_MAX_OPEN` | server | How many open decisions one module may have per project in the [Decision Inbox](#decision-inbox) (default `50`). More are refused with HTTP 429 |
| `LAIR_DECISIONS_MAX_OPEN_HTTP` | server | How many open decisions raised over HTTP one project may have, whatever module they name (default `20`). More are refused with HTTP 429 |
| `LAIR_AGENT_ID` | lair-bus | The calling agent's ID (required) |
| `LAIR_GITHUB_TOKEN` | server | A fine-grained GitHub token for running gate pipelines on GitHub Actions (see [Gate pipelines](#gate-pipelines)). A project can name another variable with `executors.github.token_env`. Never passed to local steps |

The server refuses, with HTTP 403, browser requests whose `Origin` is not one of its own (`http://localhost`, `http://127.0.0.1` or `http://[::1]` on port 4777 or 5173, plus `LAIR_HOST`) and requests whose `Host` header names another host (DNS rebinding). Requests without an `Origin` header, such as `curl` or lair-node, are allowed. WebSocket handshakes get the same `Origin` check.
