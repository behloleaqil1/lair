# Configuration Reference

Lair uses YAML files in the `projects/` directory to configure each monitored project. Private configurations can be placed in `projects/local/` (gitignored).

Everything here can be set from **Settings** in the dashboard; the YAML is what Settings writes. See [Settings](#settings) for how it checks, confirms and records a change.

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

The Gates section reads `gates_dir/queue/` and `gates_dir/results/`:

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

Controls are on unless a project sets `read_only: true`; each one also needs its command template below (a project without any can run nothing). Set `read_only: true` to keep a project look-only. Running them from the dashboard (the command bar, the Work section) also needs the browser to be signed in as the owner (see [Owner-only routes](#owner-only-routes)):

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
| `read_only` | boolean | `false` | `true` turns off every write: commands, starting and stopping, merges, deploys, acting modes. Without the key the controls are on (each still needs its command or module configured, and the owner's session); a project the Settings view creates starts with `read_only: true` |
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

`GET /api/orchestrator` says whether this service is loaded (with `launchctl`, so only on macOS), with the queue's tick lines and whether the STOP file exists. The dashboard has no Orchestrator view any more (a pause still shows in its footer). On Linux, leave `launchd_label` unset.

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

Each key under `dragons` is the dragon's ID. IDs start with a letter, contain only letters, digits, `_` and `-`, end with a letter or digit, and are at most 64 characters: `kiro-A`, `aider-1` and `worker_b` all work. Entries with other IDs are skipped. Log files are matched to dragons by name: `<id>.log` or `<id>-<YYYYMMDDTHHMMSSZ>.log` in `agents_dir`. A dragon's last log time (the Work section, Home's "silent" check) is when its newest log file was last written (the file's modification time); a running dragon with no log is reported as "log time unknown", never as silent.

Dragons listed in `<agents_dir>/dragons.txt` (one per line: id, name, task) can be started and stopped from the dashboard too, without a `dragons:` entry. Such a dragon uses its name from `dragons.txt`, the model and adapter of `dragon_defaults` (below; without it, no model and the default adapter), and has no machine or instructions; add a `dragons:` entry to set them. When a dragon is in both, the `dragons:` entry is used. The same ID rules apply, and `dragons.txt` is re-read on every request, so new lines need no restart.

A dragon that Lair's [agents module](#agents) has an active run for shows as running in the Work section, with the run's state (starting, working, waiting on lock, hung, ...) and "managed by Lair"; stop it from the Work section.

### Dragon defaults

```yaml
dragon_defaults:
  model: model-id
  adapter: claude-code
```

`dragon_defaults` gives a model and an adapter to every dragon that names none: each `dragons.txt` dragon, and a `dragons:` entry that leaves `model` or `adapter` out. A dragon's own value always wins. The Work section shows the effective model, with "(default)" when it came from a default. The agents module, the start dialog and start/stop requests use the same values. Both keys are optional:

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
| `profile` | string | — | An [AI profile](#ai-tools-profiles-and-roles) (`ai.profiles`): its tool and model, instead of `adapter` and `model` (name one or the other, not both). A dragon that names none of the three runs on its role's first profile when that role is set |
| `instructions` | string | `""` | Standing instructions for this agent |

### Dragon commands

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `dragon_start_cmd` | array | — | Command to start an agent. Placeholders: `{dragon}`, `{task}`, `{prompt_file}` |
| `dragon_stop_cmd` | array | — | Command to stop an agent. Placeholder: `{dragon}` |
| `dragon_release_cmd` | array | — | Command to release an agent's task. Placeholder: `{dragon}` |
| `default_instructions` | string | `""` | Default instructions applied to all agents: they go first in every run's prompt, except the runs a Lair module requests with its own prompt, a supervisor run's and a review run's ([Supervisor chat and digest](#supervisor-chat-and-digest), [Reviews by agents](#reviews-by-agents)) |
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

Lair ships built-in adapters (presets) for `kiro`, `aider`, `claude-code`, `cursor-agent`, `codex`, `gemini`, `opencode`, `goose` and `copilot`; only `kiro` is tested, the others are experimental (see [Tool presets](#tool-presets)). Define custom adapters, or override a built-in one by reusing its ID:

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

## AI tools, profiles and roles

> Every key is optional: a project without them runs exactly as before. Design: [ai-roles.md](design/ai-roles.md).

A **tool** is an agent CLI, through its adapter (the presets below, or one of your `agent_adapters`). A **profile** is a named tool and model. A **role** is a job Lair gives an AI, and lists the profiles that do it, in order: the first is used, the next ones are its fallbacks.

```yaml
ai:
  profiles:
    kiro-opus:   { tool: kiro, model: claude-opus-4.5 }
    kiro-cheap:  { tool: kiro, model: claude-haiku-4.5 }
    claude-best: { tool: claude-code, model: opus, options: { args: ["--verbose"] } }
  roles:
    build: [kiro-opus, kiro-cheap]
    review:
      red:   [claude-best, kiro-opus]   # the strongest reviewer first
      amber: [kiro-opus]
      green: [kiro-cheap]
    plan: [kiro-opus]

dragons:
  kiro-A: { name: Smaug, profile: kiro-opus }
  rev-1:  { name: Glaurung, profile: claude-best }
  kiro-B: { name: Saphira }   # names nothing: the build role's first profile
```

| Key | Type | Description |
|-----|------|-------------|
| `profiles.<id>.tool` | string | A built-in tool (`kiro`, `claude-code`, `codex`, ...) or one of `agent_adapters` |
| `profiles.<id>.model` | string | Any model id the tool takes (letters, digits, `.`, `_`, `:`, `/`, `@` and `-`, not starting with `-`). `GET /api/ai/models` lists what the tool offers |
| `profiles.<id>.options.args` | array | Literal arguments added to the tool's start command, after its own and before the resume flag (at most 20, no `{placeholder}`). Changing them is confirmed like a command |
| `roles.build` | array | Profile ids for the dragons that name no profile, adapter or model |
| `roles.review.red`, `.amber`, `.green` | array | Profile ids of the reviewers per risk tier (see [Reviewers by role](#reviewers-by-role)) |
| `roles.plan` | array | Profile ids for the planner agent (`planner.agent.id`) when it names none |
| `roles.supervise` | array | Profile ids for the supervisor's runs ([Supervisor chat and digest](#supervisor-chat-and-digest)): the supervisor agent (`supervisor.agent`) runs on the first when it names no profile, and fails over along the role; without `supervisor.agent`, the first dragon on one of these profiles is the supervisor |

Profile ids start with a letter and use letters, digits, `.`, `_` and `-` (at most 64). A mistake keeps the project from loading, with the key's path: `ai.profiles.<id>.tool: unknown tool ...`, `ai.roles.review.amber[1]: unknown profile ...`, a profile listed twice in a role, `dragons.<id>.profile: unknown profile ...`, and a dragon that names a profile and an adapter or a model.

**How a dragon's tool and model are chosen**, first match wins:

1. its own `profile:`;
2. its own `adapter` and `model`, each falling back to `dragon_defaults` (as before profiles);
3. naming none of them: the first profile of its role, when that role is set: `ai.roles.plan` for the planner agent, `ai.roles.build` for every other dragon (a `dragons.txt` dragon too);
4. `dragon_defaults`, else the built-in default (`kiro`, `claude-sonnet-4`).

**Failover.** A dragon on a profile fails over to the profiles after its own in its role (for the build role above: `kiro-opus`, then `kiro-cheap`), with the [agents module's failover](#agents) unchanged: cooldowns, transient errors and `max_failovers`. `agents.fallbacks.<id>`, when set, replaces those fallbacks.

### Reviewers by role

A reviewer pool (`review.reviewers_pool.<tier>`, or a slot's `pool`) may name a role: `role:review.amber` stands for the dragons that run a profile of `ai.roles.review.amber` (their own `profile:`, or their role's), in the role's order (the dragons on its first profile first). A role is not an agent of its own: give your reviewer dragons `profile: <one of the role's profiles>`. With reviews by agents on (`review.enabled` and `review.prompt_file`), a review role that no dragon runs keeps the project from loading (`ai.roles.review.<tier>: no dragon runs this profile ...`); a role with the build role's first profile counts as run, since a `dragons.txt` dragon runs it. It can be the whole pool (`amber: role:review.amber`) or one entry beside agent ids. A tier with no pool of its own takes `role:review.<tier>` when that role is set, so setting `ai.roles.review.amber` is enough to have AMBER reviews done by those agents. A failing first profile falls back to the next: a review run that ends without a review is retried by an agent not tried yet, which is the role's next agent. `different_model` compares every model of both sides, their role fallbacks included: a reviewer is skipped when any of its profiles shares a model with any of the author's. A `role:` entry for a role the project doesn't set is a config error.

### Tool presets

A preset is a tested start command (only Kiro's is tested end to end; the others follow each CLI's public reference and are marked experimental), and how Lair lists the tool's models and checks its sign-in. Lair never installs a tool and never signs in for you.

| ID | Tool | Models | Sign-in check | Sign in with |
|----|------|--------|---------------|--------------|
| `kiro` | Kiro CLI | `kiro-cli chat --list-models` (parser `kiro`); a known list when it fails | `kiro-cli whoami` | `kiro-cli login` |
| `aider` | Aider | none: aider takes its model from its own configuration | none | (API keys: a later part, A6-2) |
| `claude-code` | Claude Code | known: `opus`, `sonnet`, `haiku` (the CLI's aliases) | none | `claude`, then `/login` |
| `cursor-agent` | Cursor Agent | known: `auto`, `sonnet-4.5`, `gpt-5` | none | `agent login` |
| `codex` | Codex CLI | known: `gpt-5-codex`, `gpt-5` | `codex login status` | `codex login` |
| `gemini` | Gemini CLI | known: `gemini-2.5-pro`, `gemini-2.5-flash` | none | `gemini`, then Login with Google |
| `opencode` | OpenCode | `opencode models` (parser `lines`) | none | `opencode auth login` |
| `goose` | Goose | none: goose takes its model from its own configuration (`goose configure`) | none | `goose configure` |
| `copilot` | GitHub Copilot CLI | known: `claude-sonnet-4.5`, `claude-sonnet-4`, `gpt-5` | none | `copilot`, then `/login` |

Every preset also has a `version_cmd` (`<program> --version`). A model a tool doesn't list can still be used: model lists are shown, never enforced.

An adapter (a preset, or one of your `agent_adapters`) may set these keys:

| Key | Type | Description |
|-----|------|-------------|
| `models_cmd` | array | Lists the tool's models: an argv, run on each machine |
| `models_parser` | `kiro` \| `lines` | How its output is read: `kiro` (indented lines, the default marked with `*`, indented or not, then the cost and a description, separated by two or more spaces) or `lines` (the default: one model per line, its first word the id and the rest its label; `#` lines are skipped, a leading `* ` marks the default) |
| `models` | array | Known models (`{id, label?, notes?, default?}`): the list when there is no `models_cmd`, or when it fails |
| `auth_check_cmd` | array | Exits 0 when the tool is signed in on the machine: an argv |
| `login_hint` | string | What you run in a terminal to sign in, shown as the fix. Lair never runs it |
| `version_cmd` | array | Prints the tool's version: an argv |
| `experimental` | boolean | Shown as experimental |

These commands are run as written: argv arrays, never through a shell, with no `{placeholder}` and a program that doesn't start with `-` (a config error otherwise). Each runs with at most 256 KiB of output and a timeout (5 seconds for a sign-in check, 15 for the others), in the environment an agent of the project gets (`PATH`, `HOME` and the like, plus `agents.env_passthrough`), never the rest of Lair's. Lair never reads a tool's token files: the tool's own check answers. A check's answer is:

- exit 0: **signed in**;
- another exit code whose first line (of its output, or of its errors) says so ("not logged in", "not signed in", "login required", ...): **not signed in**, with the preset's `login_hint` as the fix. A later line doesn't count: a transient error may suggest logging in again;
- anything else (a timeout, a crash, a missing subcommand, ssh failing): **unknown**. Unknown never stops an agent.

**Nothing of a tool's output is shown as it is.** A sign-in check's output can name your organisation's sign-in portal, a profile ARN and an account, so the API, the dashboard and the Decision Inbox get the state and fixed words only ("signed in", "not signed in", "can't tell: the sign-in check failed (timed out)"): a failure is given by its category (not installed, timed out, exit code N, too much output), never by a line of its output. A known kind of sign-in is shown as "signed in (Logged in with IAM Identity Center)": those words, never what follows them. Every other text taken from a tool's output (a version line, a model's label and notes) has URLs, ARNs and runs of six or more digits taken out, and a model id that is a URL or an ARN is not listed.

**Machines.** On this machine a tool is installed when its start command's program is on `PATH` (a lookup, nothing is run). An SSH machine (`machines:`) is asked through `ssh` (`command -v`, then the tool's commands, each argument quoted for the remote shell), and only about the tools of the dragons whose `machine` is that one. A non-interactive SSH shell may have a shorter `PATH` than your login shell. The agents module starts its runs on this machine, so only this machine's sign-in state refuses a start.

**A tool that is not signed in starts nothing here.** The agents module never waits for a check. A request for a run starts its tools' sign-in checks in the background (the sign-in check alone, never the version), and a start goes by the last answer. An answer is good for a minute; once it is 30 seconds old, the next look starts another check in the background while it still stands. A tool not checked yet, or whose answer is older than a minute, counts as unknown, which never holds a start. When a tool's last check says it is not signed in on this machine, the agents module starts no run on it: each run on that tool waits, with "not signed in on this machine: run `<login_hint>` ..." as its detail, and looks again every 30 seconds; a run with a fallback on another tool (`agents.fallbacks`, or its role) starts on that one. The Decision Inbox gets one decision per tool for the project, not one per agent or run:

- "I signed it in: check again now": the tool is checked again at once, the runs waiting on it start once it is signed in, and you are asked again if a check after your answer still says it isn't;
- "Keep waiting": Lair keeps checking and starts the runs once it is signed in, without asking again.

The decision is withdrawn once a check says the tool is signed in, and raised again if it is signed out again after that.

The adapter a dragon names (its key under `agent_adapters`, or a preset's) is its tool, with that entry's own start command and checks, also when the entry's `id:` names another.

### AI API

Every route is the owner's, reads included (they run the tools' own commands and show who is signed in): `/api/ai` is in `OWNER_ONLY_PREFIXES`. `project` defaults to the default project; `machine` to `local`.

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/ai/tools?project=<name>` | Every tool the project can use: `{project, tools: [{id, name, experimental, program, signInCheck, modelsCmd, knownModels, inUse, machines: [{machine, installed, path, version, signIn: {state, as, detail, fix}, checkedAt}]}], notes}`. `state` is `signed_in`, `signed_out` or `unknown`; `installed` is null when a machine didn't answer. Cached for a minute |
| `POST` | `/api/ai/tools/refresh` | Body `{project?}`: every tool checked again now (Settings → AI's Refresh), the same answer. A check younger than 5 seconds is answered as it is, and refreshes that come together share one check. This machine's new sign-in states serve the agents module too |
| `GET` | `/api/ai/models?tool=<id>&project=<name>&machine=<id>` | `{tool, machine, models: [{id, label, notes, default}], source, fetchedAt, error?}`. `source` is `cmd` (its `models_cmd`, cached for an hour), `preset` (its known list; `error` says why the command gave none, by its category only, and it is tried again after a minute) or `none` |
| `POST` | `/api/ai/models/refresh` | Body `{tool, project?, machine?}`: the list read again now, the same answer |

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

With only a `pipelines:` block, jobs run on the local machine. Runs are started from the Gates section or with `POST /api/pipelines/runs`.

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
2. Open the Gates section, click **Workflow file**, and commit that file to the default branch as `.github/workflows/lair-gates.yml`. It declares `permissions: contents: read`, validates its inputs, and checks out the exact commit. Copy it again after changing a pipeline: Lair skips GitHub while the committed file is missing or out of date, and says so.
3. Private repository: to run without billed minutes, register a self-hosted runner to the repository (Settings, Actions, Runners, New self-hosted runner) on a spare machine, and start it with GitHub's `./config.sh` and `./run.sh` commands. To use GitHub-hosted runners too, set `monthly_minutes`.

**Never self-hosted for a public repository.** Fork pull requests can run code on a public repository's self-hosted runners, so Lair never sends a job there, the workflow it generates for a public repository has no self-hosted option, and the status shows a warning when such runners are registered.

**Fallback.** A job GitHub refuses (billing, spending limit, Actions disabled, a workflow that fails to start), or that no runner picks up within `pickup_timeout_minutes`, is cancelled and goes to the next executor once GitHub reports that none of its steps started. If a runner took the job in the moment Lair cancelled it, the job stopped unfinished and also goes to the next executor: Lair's own cancel never makes a gate fail. The refused executor is unavailable for `unavailable_minutes` (shown, with the reason, in the Gates section). A job is never run twice: when the cancel came too late and the run finished, Lair keeps that run's result. A runner lost mid-run (the job ended cancelled or timed out with no failed step) gets one retry; the second time the result stands. In-flight jobs resume after a server restart, and leftover job worktrees are removed then.

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

The Decision Inbox ([design](design/autonomy.md#1-decision-inbox-the-only-place-a-human-is-needed-module-decisions)) is the **Decisions** view. The number next to it in the nav is how many decisions wait for your answer (action items, below), in red while one of them is overdue. It shows every project's decisions, open ones first: the soonest to expire, then the oldest, with notices after the action items. Decisions are kept in `data/decisions.db`, so they survive a restart.

Home's **Needs you** lists this project's open action items, newest first: each one a plain sentence saying what waits and why, its answer buttons (with the same confirmation as in Decisions; a `credentials` decision is answered in Decisions only), and a link to its full context. Config errors are listed there too, and other projects' action items as one line. Below it, a collapsed **FYI** list holds the notices, agents that need a look, failed gates and PRs ready to merge. With nothing open it says "Nothing needs you." [Notifications](#notifications) can tell you about new action items on your desktop or phone.

### Action items and notices

Every decision has an **attention**:

- `action` (the default): it needs your answer. It counts toward the nav's number, is listed in Home's Needs you, and may notify you.
- `notice`: it is for your information, with nothing to choose. It is listed under FYI and in Decisions labelled FYI, never counted and never notified. A watchdog escalation whose only option is "Leave it to me" (no playbook command is configured to run, or the project is `read_only`) is a notice; like every escalation, it is withdrawn once its breach clears.

A producer sets it when it raises a decision (`"attention": "notice"` over HTTP). A notice can't be one of the kinds that always wait for you (`pricing`, `legal`, `spend`, `account`, `credentials`, `go_no_go`, `security`), and has no default.

### One decision per hold

A **hold** that only you can lift has exactly one open decision while it lasts. It is raised when the hold starts and kept open, and is never asked twice: not on later checks, not after a restart. Answering it lifts the hold through the same owner-only path as the hold's own Release button. When the hold lifts any other way (released where it is shown, the task done or started again, its line out of the tasks file for 3 checks in a row), its decision is withdrawn. A hold that comes back after its decision was withdrawn asks again, without a second notification within the [notification](#notifications) window. A line taken out and put back within those 3 checks keeps its decision.

| Hold | Its decision's options | "Keep" leaves it |
|------|------------------------|------------------|
| [Fill](#fill)'s `owner`, `no_done`, `blocked`, `waited_too_long` and `refused` holds | "Start it again" / "Keep it paused" | paused by you (`held: paused`): nothing more is asked, and your Release in Work starts it again |
| An agents escalation (a run chain whose automatic recoveries are used up) | "Start it again" (in a fresh session) / "Leave the task unclaimed" | unclaimed; a task fill runs is then paused by you |
| A PR's [merge holds](#reviews-and-policy-merge) (anyone may add one; only you release them): one decision per PR, and one for holds of every merge, however many holds | "Release the hold" (every hold on it) / "Keep it held" | held, until you release them in PRs |
| A [held delivery service](#delivery) (a Down) | "Release it" / "Keep it held" | stopped and held, until you release it in Delivery |

An owner hold on a run that was escalated stands on that escalation while it is open: fill raises no second decision for it. Once the escalation is answered and the task is still held (its fresh session was refused, say), fill raises the hold's own decision. An escalation whose task started again another way (you released fill's hold in Work, or started a run) is withdrawn. A `refused` hold asks once per refusal and release: "Start it again" that is refused again asks again. A run refused for being over budget has the budget's own `spend` decision instead.

Anyone may add a merge hold (`POST /api/review/holds` is open), so a PR's holds ask for your answer only when one of them came from your signed-in browser; otherwise their decision is a [notice](#action-items-and-notices), never counted or pushed. Whatever a hold's `by` says doesn't count: it is only what the caller wrote.

**Only Lair's own modules lift holds.** A decision raised over HTTP never reaches a module inside Lair, neither your answer nor its default at expiry: its caller reads the answer from the API. Over HTTP nobody may raise a decision in the name of a module that follows its answers (`agents`, `watchdog`, `review-holds`, `delivery`, ...: HTTP 403), and a decision raised over HTTP never counts as a module's own, so it can't stand in for a hold's decision.

The titles are plain sentences ("worker-a is paused on feat-login: its last run failed while Lair was restarting"). What an agent printed, a BLOCKED line or the reason someone gave for a merge hold goes in the context, as data, never in the title.

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

**From your own tools.** Any module, script or agent can ask through the API below; only you answer. Two limits keep a flood of questions out: one module may have at most 50 open decisions per project (`LAIR_DECISIONS_MAX_OPEN`), and decisions raised over HTTP may have at most 20 open per project together, whatever module they name, since over HTTP the module name is only what the caller says (`LAIR_DECISIONS_MAX_OPEN_HTTP`). More are refused with HTTP 429 until some are answered. Modules inside the server count only against their own limit. A decision raised over HTTP shows that, so you know its module name is unchecked. Its caller reads your answer from the API (`GET /api/decisions/:id`); it is never handed to a module inside Lair, and over HTTP no decision may name a module inside Lair that follows its answers (HTTP 403). Answering doesn't run anything by itself, so it also works on a `read_only` project: the module that asked decides what the answer allows. Server modules use the `DecisionProducer` interface (`raise`, `blockedOn`, `onResolved`, `withdraw`, `find`, `openOf`) from `src/server/decisions/`; `find` and `openOf` see only the decisions raised in the server. Only they can withdraw a decision: HTTP callers have no identity yet, so there is no withdraw route.

**Modules that ask by event.** A module can also ask by emitting a `decision.needed` event in the server, in the design note's shape (`question`, string `options`, `recommended`, `why`, kinds `product`, `credential` and `release` for `pricing`, `credentials` and `go_no_go`). The Decision Inbox raises it as a decision of that module, with option ids made from the option texts. `on_timeout` is not carried over: such a decision has no expiry, so it waits for you. Gate pipelines ask this way, for their GitHub-hosted minutes budget (see [Minutes budget](#gate-pipelines)). **The pipelines module does not act on answers yet:** whatever you choose, it keeps the budget it has. To raise it, change `executors.github.monthly_minutes` and restart. Your answer is kept, and is delivered to the pipelines module once it listens for answers.

### Decision Inbox API

`?project=` is validated as on every route. Bodies are JSON.

- `GET /api/decisions?project=&status=open|answered|expired|withdrawn|closed|all&attention=action|notice&limit=100`: open first, by urgency. Without `?project=`, every project's decisions
- `GET /api/decisions/summary?project=`: `{open, overdue, action, notices, secretStore}`: `open` counts every open decision, `action` and `overdue` only those that need your answer (the nav's number), `notices` the rest
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

  `attention` (`action`, the default, or `notice`), `blocks`, `links` (`[{label, url}]`, http or https, not to this machine or a private network), `expiresAt` and `defaultOptionId` are optional. A default needs `expiresAt`, and is refused for the kinds above that can't have one. A `credentials` decision also needs `secretName` and an option with `"suppliesSecret": true`.
  **Class, evidence and effects (optional).** A decision can carry a policy `class` (`module.name`, starting with the raising module), an `evidence` object and an `effect` on each option, for rules to read later (nothing acts on them yet; the Decisions view shows them under the prose):

  ```json
  {
    "class": "deploy-script.budget",
    "evidence": { "code": "budget_exceeded", "facts": { "month": "2026-01", "used": 120 }, "cause_cleared": false, "linked_issue": null },
    "options": [{ "id": "approve", "label": "Approve", "consequences": "Costs more.", "effect": "outward" }]
  }
  ```

  `effect` is `reversible`, `frees_task`, `irreversible` or `outward`. `evidence.facts` is flat (strings, numbers, booleans, null). A `class` needs `evidence` and an `effect` on every option; a class in the policy table (docs/design/decision-policies.md) takes only its own evidence codes; any other class is accepted and flagged in the audit trail. A bad object is refused with 400 naming the field. Decisions raised without them load and show as before.
- `POST /api/decisions/:id/answer`: `{optionId, note?, confirm?, secret?}`, with an owner session (see "Only you answer"). `confirm: true` is required for `spend` and `go_no_go`; `secret` goes only with an option that supplies it, and `credentials` decisions take no `note`

Errors: 400 for invalid input, 403 for a cross-site request or an answer without an owner session, 404 for an unknown decision, 409 when it is no longer open, 429 when a module, or HTTP callers together, have too many open decisions, 503 when the secret store can't take a value.

## Owner-only routes

Every route that changes something only you should change needs the owner's session, the same one the Decision Inbox uses (see "Only you answer"): the `X-Lair-Owner-Session` header, from the dashboard's own origin, in a same-origin browser request. Without it the answer is HTTP 403, before the request's body is read, and nothing changes. `curl`, scripts, agents and other local programs can still read: every `GET` stays open, except the two that read prompt files from disk (`/api/agents/prompts`), the Settings API (`/api/settings`), whose reads reveal paths and commands, the AI tools API (`/api/ai`), whose reads run the tools' own commands, the cloud machines' status (`/api/cloud`), which names the account's instances and spend, Lair's diagnostics and the ops tokens and their audit (`/api/health/diagnostics`, `/api/supervisor`), and logs and test output (`/api/dashboard/.../output` and `.../log`, and the logs in pipeline runs), which can hold anything a test or an agent printed. No CORS is granted under these prefixes (`OWNER_ONLY_PREFIXES` in `src/server/human-auth/cors.ts`). The dashboard's views send the session once this browser is signed in, and show "sign in from Decisions" until it is.

| Prefix | Owner only | Open |
|--------|------------|------|
| `/api/decisions` | answering a decision | listing, the summary, raising |
| `/api/owner` | listing and signing out browsers; Restart and its state (`/api/owner/restart`); notification settings and the test notification (`/api/owner/notifications`) | the session check, signing in with the token |
| `/api/review` | the owner's review, resolving findings, releasing holds, merging | reading, agent reviews, adding holds, gate results |
| `/api/agents` | starting a run, releasing a claim, a fresh session, an early check, listing and reading prompt files | status, runs, recoveries |
| `/api/controls` | every `POST`: ask, instruct, tick, pause, resume, agent run/stop/release, gate submit/stuck, merge, dragon start/stop | status, inbox, audit, dragon config |
| `/api/bus/send` | sending a message (it is sent as `owner`) | the board and the event stream (`/api/bus/board`, `/api/bus/events`) |
| `/api/processes` | start, stop, restart | the list, a process, its logs |
| `/api/settings` | everything: reading, checking and saving project settings, their history and restore, creating a project, the repository check, testing a machine | nothing |
| `/api/scheduler`, `/api/tasks` | scheduler start, stop and tick; creating, cancelling and retrying tasks | status, tasks, jobs, nodes |
| `/api/fleet` | adding, removing, testing and installing machines; healing and budget settings; provider budgets and unpausing | the overview, machines, healing events, budgets |
| `/api/delivery` | Up, Down, Restart, Deploy, Release | status and operations |
| `/api/pipelines` | starting and cancelling runs; a job's log tail and its steps' output | status, the workflow file, runs (without logs and output) |
| `/api/dashboard` | a gate's log tail and failing tests (`/gates/:id/output`), an agent's log tail (`/agents/:id/log`) | the modules a project turns on, a gate's detail |
| `/api/ai` | everything: the tools' installed and sign-in state per machine, their models, refreshing a list ([AI API](#ai-api)) | nothing |
| `/api/health/diagnostics`, `/api/supervisor` | everything: the self-checks' results, minting, listing and revoking ops tokens, their audit ([Supervisor API](#supervisor-api)) | nothing (`/api/health` itself stays open) |
| `/api/ops` | nothing: it takes an [ops token](#the-ops-api), never the owner's session, and grants no CORS | — |

The watchdog's routes are all reads; it acts only inside the server. Lair's own work doesn't go through these routes either: delivery's automatic deploys, the scheduler, the healer and the watchdog's playbooks run inside the server, server code starts pipeline runs with `PipelineManager.startRun` and creates tasks with the job manager, and agents use the fleet bus (`npm run bus`), which works on the bus database directly. The `lair-node` daemon connects over `/ws/node`, not these routes.

## Watchdog

> Off by default. With `enabled: true` and the default `mode: observe`, the watchdog detects, records and escalates, and runs none of your commands unless you approve one in the [Decision Inbox](#decision-inbox).

The watchdog ([design](design/autonomy.md#2-progress-watchdog-and-playbook-engine-module-watchdog)) checks each project every `interval_seconds` for the failures in the table below. It reads the project's files (`queue_file`, `agents_dir`, `gates_dir`), the process table (`ps`), and the read-only commands you configure (`ready_tasks_cmd`, `merged_cmd`, `docker inspect`). Each failure it finds is a **breach**, stored in `data/watchdog.db`. A breach stays open while it is still detected and is resolved once it is not.

What happens to an open breach:

- **Act**: when `mode: act` is set, the project is not `read_only`, and the breach's playbook has `act: true`, the playbook runs. It **diagnoses** (re-checks the breach on fresh data), **acts** (runs your `watchdog.actions.<action>` command) and **verifies**. A breach that is still open is retried after `cooldown_minutes`, up to `max_attempts` times, and then escalated. An attempt is a run that reached its act step: a run that stopped at diagnose (for example because `ps` failed) does not use one up.
- **Observe**: in every other case the playbook is recorded as `observed`, together with the command it would have run, and the breach is escalated.
- **Escalation**: happens once per breach, as an `escalation` decision in the [Decision Inbox](#decision-inbox), with the evidence (and the command output, if a command ran). Until you answer, the breach is parked: no playbook runs and nothing is escalated again. **Run once** (offered when the playbook's command is configured and the project isn't `read_only`) runs the breach's playbook one more time, also in observe mode; if that run fails, Lair asks again. **Leave it to me** stops all action on the breach. Without Run once there is nothing to choose, so the escalation is a [notice](#action-items-and-notices): listed under FYI, never counted or notified. A breach that clears on its own withdraws its open decision. When `escalation_file` is set, Lair also appends an `- OWNER? ...` entry there. If the decision can't be raised, the entry goes to `escalation_file`, or to `inbox_file` when that isn't set, and is otherwise kept in the store only. A breach that clears and comes back within `reescalate_minutes` of the last escalation for the same subject is recorded as suppressed and not escalated again.
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
| `orphan_claim` | A claim `agents_dir/<id>.running` older than `claim_grace_minutes` whose agent has no live process. A live agent's claim is never touched. A pid recorded in the claim (the file, or its `pid` file: `pid=<pid>` with an optional `started=<ISO time>`, or a bare pid) keeps it only while that pid runs as the agent, since the OS may give a dead agent's pid to another process: its command names the agent id; or, with `started=`, it started no more than 60 s after that time; or, for a bare pid, it runs the agent's adapter program (the first word of the adapter's `start_cmd`). The `release_claim` guard re-checks with the same rule | `orphan_claim` | `release_claim` | the claim is gone |
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

## Supervisor: self-checks and the ops API

> The self-checks are on by default, with nothing to set. Design: [supervisor.md](design/supervisor.md). This is part S1-1: the checks, their notices and the read-only ops API. The supervisor's own runs (answers to your questions and the daily digest, S1-2) are off by default: see [Supervisor chat and digest](#supervisor-chat-and-digest).

Lair checks itself, in code, every `interval_seconds` (60 s by default), off the request path, and shows the results in **Home → Health** (yours only). Each result has an id, a status (`ok`, `warning`, `failing`, or `unknown` when it couldn't be measured this round), its measured values and thresholds, a one-line explanation and what to do about it. Its words are Lair's own (a count, a module, a lane, a config key), never a line of a log or of a command's output.

| Check | Of | What it measures | Warning / failing (defaults) |
|-------|----|------------------|------------------------------|
| `event_loop_lag` | Lair | How late the event loop was since the last round (p99; sampled every 20 ms, from the start of the schedule, so the server's own start-up doesn't count) | 200 ms / 1000 ms |
| `request_latency` | Lair | The p95 duration of the requests answered in the last `window_minutes` (5), and the slowest route; fewer than `min_requests` (20) are too few to judge. The bus's event stream is left out | 1000 ms / 5000 ms |
| `open_files` | Lair | This process's open files against its soft limit: `/proc/self/fd` and `/proc/self/limits` on Linux, `/dev/fd` and Node's process report on macOS (the limit is read once, the first time, and kept while Lair runs), else `lsof -p` with a 5 s timeout. Without a known limit it is `unknown` | 70% / 90% |
| `disk_free` | Lair | The free space of the disk that holds `data/` | 10% or 5 GiB / 5% or 1 GiB |
| `store_size` | Lair | The largest store in `data/`, the largest WAL file, and how much the WAL files grew since the last round | 500 MB / 2000 MB; WAL 64 MB / 512 MB |
| `command_timeouts` | Lair | Commands Lair gave up on in the last `window_minutes` (15): the dashboard's status commands, the modules' probes, git, the AI tools' checks | 3 / 10 |
| `module_errors` | a project | Modules its YAML turns on that did not start (config errors: failing) or that report an error from their last round (warning) | — |
| `watcher_mode` | a project | Folders the file watcher polls instead of watching (a missing folder, one the system can't watch): warning | — |
| `infra_holds` | a project | Open holds and escalations of the agents module whose evidence, in the agents module's own events, points at the infrastructure: a transient provider or network error, a restart of Lair, a stale gate result; and provider outages | 1 / 3 |
| `machines` | a project | Placement's machines that fail their probe (with placement on) | one down / one down for 10 min |
| `gate_queue_age` | a project | The oldest request waiting in `gates_dir/queue` (with a gate queue folder) | 60 min / 180 min |
| `retention` | a project | Entries in `agents_dir`, `gates_dir/results` and `gates_dir/queue`: the fullest one | 5000 / 20000 |

A check that doesn't apply to a project (no placement, no gate queue folder) isn't listed. Lair's own checks follow the default project's `supervisor:` block; each project's checks follow its own.

**Never in the way.** Each check has its own timeout (`timeout_seconds`, 10 s): one still running then reports `unknown`, and isn't started again until it settles. A check that fails reports `unknown` (its error goes to the server log, never into the result); the others run as usual. A round never overlaps the next. Reading the results runs nothing. They are kept in memory: after a restart, the first round runs 15 s after the start.

**A failing check becomes a notice.** A check failing for `notice_minutes` (5) in a row raises one [notice](#action-items-and-notices) in the Decision Inbox (listed under FYI, never counted or notified), with what it measured, what to do and since when. There is one per check: it is withdrawn when the check recovers (`ok` or `warning`), and the same check raises none again within `notice_cooldown_minutes` (60) of a withdrawal. **Noted** closes it, and it isn't raised again until the check recovers and then fails again. A check turned off withdraws its notice. Lair's own checks raise theirs in the default project. How long a check has been failing is counted in memory, so a restart starts the count again; a notice already open stays open until the check recovers.

```yaml
supervisor:
  checks:
    enabled: true                 # default
    interval_seconds: 60
    timeout_seconds: 10
    notice_minutes: 5
    notice_cooldown_minutes: 60
    disabled: [retention]          # check ids to skip
    event_loop_lag: { warning_ms: 200, failing_ms: 1000 }
    request_latency: { warning_ms: 1000, failing_ms: 5000, min_requests: 20, window_minutes: 5 }
    open_files: { warning_percent: 70, failing_percent: 90 }
    disk_free: { warning_percent: 10, failing_percent: 5, warning_gib: 5, failing_gib: 1 }
    store_size: { warning_mb: 500, failing_mb: 2000, wal_warning_mb: 64, wal_failing_mb: 512 }
    command_timeouts: { window_minutes: 15, warning: 3, failing: 10 }
    infra_holds: { warning: 1, failing: 3 }
    machines: { failing_minutes: 10 }
    gate_queue_age: { warning_minutes: 60, failing_minutes: 180 }
    retention: { warning_entries: 5000, failing_entries: 20000 }
```

Unknown keys and check ids, and a warning threshold past its failing one (above it; below it for free disk), are config errors that name the key: `supervisor.checks.open_files: the warning threshold (95) is above the failing one (90)`. A project whose block is invalid runs none of its checks, and shows the error in Home → Health. The block is reloaded live, and edited in Settings.

### The ops API

The ops API is what an AI supervisor reads Lair through: read tools only (`proposals.submit`, the one write tool, comes with S2). Any MCP-capable tool gets it from `lair ops-mcp`, an MCP server over stdio; any tool that can run a command gets it from `lair ops call <tool> [--args <json>]`, which prints the answer as JSON. Each tool call is one `POST /api/ops/call` to Lair, which checks, audits, redacts and bounds it.

| Tool | Arguments | Answer |
|------|-----------|--------|
| `status.watchdog`, `status.agents`, `status.triage`, `status.delivery`, `status.pipelines`, `status.review`, `status.planner` | `project` | The module's own status for the project |
| `events.query` | `project`; `source`: `agents` (the agents module's stored events, the default) or `server` (the server's recent events, in memory: the project's own; events that name no project, such as nodes and jobs, only for a session token that names no project); `since` and `until` (ISO times: the last 24 hours by default, at most 7 days); `kinds` (at most 20); `agent`, `task`, `run_id`; `limit` (at most 200, default 50) | Events, newest first |
| `decisions.list` | `project`, `status` (default `open`), `attention`, `limit` (at most 100, default 25) | Decision Inbox items, their context cut to 1500 characters |
| `runs.get` | `project` and `id` (a run), or `agent` and `limit` (at most 20, default 5) | The run with its chain's attempts and its events, or the agent's latest runs |
| `logs.tail` | `project`, `agent` or `gate`, `lines` (at most 200, default 50) | The log's last lines |
| `gates.result` | `project` and `id`, or `hours` (at most 72) and `limit` (at most 50) | A gate's steps, verdict and where it ran, or the latest results |
| `triage.record` | `project`, and `id` or `gate`; `limit` (at most 50) | Triage's records |
| `placement.status` | `project` | Machines, lanes, queued jobs and recent moves |
| `config.get` | `project` | The project's config, redacted |
| `diagnostics.run` | `project` | The self-checks, run now (at most every 10 s) |

`project` defaults to the token's project for a run token, and to the default project for a session token. Arguments are checked by the same list on both sides: an unknown one, an id that starts with `-` or a count past its limit is refused (HTTP 400), never cut.

**Redacted and bounded.** Every string of every answer goes through the same rules. Out go: tokens of known shapes (GitHub, Slack, OpenAI-style, AWS and Google keys, JWTs, Lair's own ops tokens); `Authorization` and `Bearer` values; the value of a `name=value` or `name: value` whose name says token, secret, password, key, credential or cookie (so a commit-id-shaped secret after `token=` goes too); long runs that mix cases and digits, and long hex runs (a bare 40-digit commit id stays); a URL's credentials, path and query (`https://git.example.com/[...]` stays); an email address's local part (`***@example.com` stays: a git `Author:` line, an identity); ARNs; runs of six or more digits. Strings are cut to 1000 characters (log lines to 500), lists to 100 items, and an answer to 256 KiB: a bigger one comes back with tighter limits, marked `truncated`. `config.get` also removes every `env` map (a command's environment), and replaces a value whose key names a secret or an email (`identity.email`, `allowed_emails`); a `*_env` key that names a variable and a `*_file` path stay.

**Tokens.** The ops API takes an ops token (`Authorization: Bearer lairops_...`), never the owner's session, and no other route takes one.

- A **run token** is minted by Lair for one supervisor run ([Supervisor chat and digest](#supervisor-chat-and-digest)), and is in that run's environment only (`LAIR_OPS_TOKEN`). It reads that run's project only, and is accepted only while the agents module's store has that run active (queued, waiting on a lock, running or stopping): it stops working however the run ends (completed, failed over, stopped by you, recovered into a new run), at once on the agents module's events for the run, and at its TTL (the question's `answer_timeout_minutes`). Besides the read tools it can do one thing: submit that run's answer to its own question, once (`POST /api/ops/answer`).
- A **session token** is yours, for an interactive session of any MCP-capable tool (below). It reads every project, for one hour by default (5 minutes to 8 hours), and you can revoke it.

Tokens live in the server's memory, never on disk: a restart ends them all. Only their SHA-256 is kept. At most 50 are alive at once (minting another drops the one that expires soonest), and each makes at most 120 calls a minute (HTTP 429 past that).

**Audit.** Every call is recorded in `data/supervisor.db`: when, the token's id and label ("run <id>", or the session's label), the tool, its arguments (redacted and cut), how it ended (`ok`; `refused`, with why; `error`) and how long it took. So are each token minted or revoked, and calls without a valid token (at most 30 a minute). A token never is. Rows are kept for 30 days, at most 50,000.

### Connecting an MCP-capable tool

1. In **Home → Health**, signed in as the owner, choose **Get a token for one hour** under "Connect an AI tool". The token is shown once, in the config to paste.
2. Add Lair to the tool's MCP servers, with the token in the server's environment:

   ```json
   {
     "mcpServers": {
       "lair": {
         "command": "lair",
         "args": ["ops-mcp"],
         "env": { "LAIR_OPS_TOKEN": "lairops_...", "LAIR_URL": "http://127.0.0.1:4777" }
       }
     }
   }
   ```

   From a checkout without the `lair` command on `PATH`, use `"command": "node"` and `"args": ["<Lair's folder>/dist/cli/lair.js", "ops-mcp"]` after `npm run build`. Tools that take a command line instead of a config file take the same command and variables.
3. Ask the tool about Lair ("why is kiro-A paused?", "which checks fail?"): it lists Lair's tools and calls them, and gets the redacted answers above.

The token stops working after its hour, when you revoke it, or when Lair restarts; mint another then. While it lives, it reads every project's statuses, redacted logs, decisions and redacted config: keep it in that tool's own config on your machine, out of shared files and repositories.

### Supervisor API

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/health/diagnostics?project=<name>` | Owner only. The latest results: `{enabled, intervalSeconds, lastRunAt, server: [check], projects: [{project, enabled, errors, lastRunAt, checks: [check]}], counts}`; each check `{id, scope, title, status, values, thresholds, explanation, fix, measuredAt, durationMs, failingSince, noticeId}`. Reading runs nothing |
| `POST` | `/api/supervisor/tokens` | Owner only. Body `{ttl_minutes?, label?}`: `{token, info}` (201), the token this once |
| `GET` | `/api/supervisor/tokens` | Owner only. The live tokens: `{id, kind, label, projects, scope, runId, createdAt, expiresAt, lastUsedAt, calls}`, never a token |
| `POST` | `/api/supervisor/tokens/:id/revoke` | Owner only |
| `GET` | `/api/supervisor/audit?limit=&token=<id>` | Owner only. The audit, newest first (at most 1000) |
| `POST` | `/api/ops/call` | An ops token. Body `{tool, args}`: `{tool, project, truncated, result}`. 401 without a live token, 403 for a project the token doesn't read, 404 for an unknown tool, 400 for invalid arguments, 429 past the rate, 504 after 20 s |

The chat's and the digest's routes are in [Supervisor chat and digest](#chat-and-digest-api).

### Process cache (A2)

Lair uses a single, shared process cache for all modules that need the process table (agents, watchdog, health checks). Under load, each module calling `ps` itself would pile up and time out when the event loop was blocked for more than 10 seconds. Now one cache refreshes in the background every 5 seconds, and every module reads from it immediately.

**Behavior:**
- A failed `ps` keeps the last good snapshot, marked stale. Routes answer from the stale cache, not with an error.
- A `ps` that its timeout (or the output cap) stopped has failed, whatever it printed: its table may stop part-way, and a process missing from it is no proof that it ended. A `ps` that exited by itself counts as success even when its timer fired late (the event loop was blocked, not `ps`).
- A table without the Lair server's own pid is not complete and fails the same way; so does one without pid 1, once a snapshot has shown pid 1 (a host that hides other users' processes never shows it).
- Each snapshot keeps when its `ps` started and when it answered. The agents module counts process start times back from that, never from the time it reads the cache, so a snapshot seconds old doesn't make a live process look like another one. When it is about to end a run on a snapshot, it reads `ps` again first, bypassing the cache (see [Restarts and hosts](#agents)).
- A cache older than 10 seconds shows as stale; the dashboard shows the cache age.

**Configuration** (environment variables; these are server-wide, not per project):

| Name | Default | Description |
|------|---------|-------------|
| `LAIR_PROCESS_CACHE_INTERVAL_MS` | `5000` | How often to refresh the cache in the background |
| `LAIR_PROCESS_CACHE_MAX_AGE_MS` | `10000` | Maximum age before the cache is considered stale |
| `LAIR_PROCESS_CACHE_TIMEOUT_MS` | `15000` | Timeout for the ps command |

**Data cache.** Dashboard routes that call `gh` or `git` (which can take seconds under load) also use an async cache:
- Pull requests (`/api/prs`): refreshed every 30 seconds, max age 60 seconds.
- Merged PRs: refreshed every 30 seconds, max age 120 seconds.
- Git info (main head): refreshed every 30 seconds, max age 30 seconds.

The response includes a `cache` object with `ageMs`, `stale`, `refreshedAt` and (on failure) `error`.

## Supervisor chat and digest

> Off by default: nothing changes until you set `supervisor.chat.enabled` or `supervisor.digest.enabled`. Design: [supervisor.md](design/supervisor.md) (S1-2). Each question and each digest is one run of an AI agent, so each costs what a run of that tool and model costs; the bounds below and the [agents module's budgets](#agents) cap how many there are.

You ask Lair a question in the dashboard, from the **Ask** tab of the command bar or the **Ask Lair** card on Home ("why is worker-a held?", "why is nothing merging?", "which gates failed because of the infrastructure today?"). A supervisor run reads Lair's own records through the [ops API](#the-ops-api) and answers, citing what it read. Once a day, a supervisor run can also write a digest of the project, shown on Home.

### Turning it on

```yaml
ai:
  profiles:
    kiro-opus: { tool: kiro, model: claude-opus-4.5 }
  roles:
    supervise: [kiro-opus]

dragons:
  lair-sup: { name: Supervisor }   # names no profile: runs on ai.roles.supervise's first

agents:
  enabled: true

supervisor:
  agent: lair-sup
  chat:
    enabled: true
  digest:
    enabled: true
    time: "08:00"
```

**Choosing the AI.** The supervisor is a role ([ai-roles.md](design/ai-roles.md)), so it runs on whatever tool and model you choose:

- `supervisor.agent` names the supervisor agent, one of the project's dragons. When it names no profile, adapter or model, it runs on the first profile of `ai.roles.supervise` and fails over along the role, as any dragon does along its own role. It can't be an agent fill starts (`agents.fill.agents`) or the planner agent.
- Without `supervisor.agent`, the supervisor is the first dragon whose `profile:` is in `ai.roles.supervise` (the dragons on the role's first profile first), leaving out fill's agents and the planner agent.
- The prompt names no tool: an agent that can run commands reads Lair with `lair ops call`, and an MCP-capable one may use `lair ops-mcp` instead (the variables it needs are already in its environment).

With `supervisor.chat.enabled`, the Ask tab sends questions to the supervisor (a message to `@<dragon-id>` still goes to that dragon); otherwise it asks the orchestrator's `ask_cmd` as before. When a question can't be answered now, the chat panel and Home's **Ask Lair** card say why.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `agent` | string | — | The supervisor agent: a dragon of the project, not one fill starts nor the planner agent |
| `prompt_file` | string | — | The supervisor's prompt template: one file name in `prompts_dir` (as `review.prompt_file`). Without it, Lair's own, [`prompts/supervisor.md`](../prompts/supervisor.md) |
| `chat.enabled` | boolean | `false` | Questions from the dashboard are answered by supervisor runs |
| `chat.max_runs_per_day` | number | `20` | Supervisor runs, questions and digests together, started in any 24 hours (1 to 500) |
| `chat.min_interval_seconds` | number | `30` | Between the starts of two supervisor runs (0 to 86400) |
| `chat.max_conversation_turns` | number | `10` | Questions in one conversation; then you start a new one (1 to 50) |
| `chat.answer_timeout_minutes` | number | `15` | A question with no answer this long after it was asked is closed, and its run stopped (1 to 240) |
| `digest.enabled` | boolean | `false` | A supervisor run writes a digest once a day |
| `digest.time` | `HH:MM` | `"08:00"` | When, in this machine's local time (24 hours) |

**Config errors are the block's own mistakes only:** an unknown key, a value of the wrong type or out of its range, a `prompt_file` that isn't one plain file name, a `time` that isn't `HH:MM`. Each names its key, and like any module's mistake it keeps an edited file from being taken. Even then the self-checks keep running on a valid `supervisor.checks` (questions and the digest wait for the fix), and Home → Health shows the error.

**Whether a supervisor run can start is not a config error**, since it depends on other blocks: the agents module off (`agents.enabled`), no supervisor agent, a `supervisor.agent` the project doesn't have, one fill starts (`agents.fill.agents`) or the planner agent. A change to those blocks always loads. The chat's status (`problem`, below) says what is wrong, Home's Ask Lair card and the chat panel show it, a question is refused with it (HTTP 409), and the day's digest is skipped with it. The block is reloaded live, and also when the agents, dragons, AI or planner blocks change, and is edited in Settings.

### A supervisor run

A question starts a conversation, or continues the one the chat panel has open, and is one run of the supervisor agent, requested through the agents module like any module's run: claims, locks, recovery, failover and budgets apply. Its task is `supervisor-ask-<the conversation's first 8 characters>-<n>` (`supervisor-digest-<YYYYMMDD>` for a digest). One question waits at a time in a conversation, and the supervisor agent takes one run at a time (a question while it is busy is refused with why).

**Its prompt** is the template (`prompt_file`, else `prompts/supervisor.md`: it tells the agent that it is Lair's operator, to answer only from tool results and cite them, to say "I don't know" rather than guess, never to write anything, the repository it may be started in included, and to give next steps marked "for the owner" or "Lair can do"), then what Lair adds for the run. The project's `default_instructions` don't go before it: they are the builders' standing orders ("commit, open a PR"), and a supervisor run gets only its own prompt, after the supervisor agent's own `instructions` if you gave it some. Lair adds:

- which run it is: the project, the conversation's id, the time it has;
- Lair's tools and how to call them;
- how to submit the answer;
- the context, as JSON data under a heading that says it is data: the self-checks that need a look (with their values and fixes) and the ids of those that pass, the project's open decisions (at most 30: id, kind, title, the module that raised it, since when), and the conversation so far (each question cut to 1000 characters and each answer to 3000, at most 12000 in all, the oldest dropped first). Every string is redacted as the ops API's answers are;
- the question, or for a digest what Lair asks for.

**Its environment** has what the agents module gives every run, and three of its own, kept in the agents module's memory only (never in its store, the prompt file or a log):

- `LAIR_OPS_TOKEN`: a [run token](#the-ops-api) minted for this run: it reads this project only, and stops working when the run ends, however it ends, or at `answer_timeout_minutes`;
- `LAIR_URL`: this server;
- `LAIR_SUPERVISOR_CONVERSATION`: the conversation's id.

**Submitting the answer.** The run writes its answer as Markdown in a file, and the evidence it cites as a JSON list of `{tool, args, note}` (each `tool` an ops tool, its `args` as called, and a note of what it showed; at most 30), both outside the repository (the prompt says `$TMPDIR`), then runs:

```
lair supervisor answer --conversation <id> --file "$TMPDIR/answer.md" [--evidence-file "$TMPDIR/evidence.json"]
```

It is `node <lair>/dist/cli/lair.js supervisor answer ...` after `npm run build` (the prompt gives the exact command), and reads `LAIR_OPS_TOKEN`, `LAIR_URL` (default `http://127.0.0.1:4777`) and, without `--conversation`, `LAIR_SUPERVISOR_CONVERSATION`. It posts to `POST /api/ops/answer`. Lair takes an answer once per question, only under the token of the run that was asked, and only while that run is active; the token is never printed. Exit codes: `0` recorded; `1` refused (an ended, another run's or the owner's token, an answer already given, an invalid answer: Lair says which); `2` a usage or input error, and nothing was sent; `3` Lair could not be reached, or answered with a server error.

`lair ops call <tool> [--args <json>]` is the same kind of command for the read tools: it checks the tool and its arguments with the server's own list before sending anything, and prints Lair's answer as JSON (`{tool, project, truncated, result}`), with the same exit codes.

**Answers are untrusted.** They are agent output, so Lair cleans them before keeping them, and the dashboard renders them with the same Markdown reader:

- Markdown only (headings, paragraphs, lists, code, quotes, emphasis, links), cut to 20000 characters; outside code every HTML tag and comment is removed, and the dashboard never makes HTML from the text;
- images are their alt text: nothing is loaded;
- links go only to the dashboard's own pages (`#/work/<agent>`, `#/decisions/<id>`, ...) and to the repository's host (`https://github.com/<owner>/<name>/...`, or the review module's API host); any other link is its text, not clickable;
- secrets of known shapes, `Authorization` and `Bearer` values and a URL's credentials are taken out, of the evidence's notes and arguments too.

**No answer.** A question is closed as "no answer", with the reason, when its run ends without answering (it exited, crashed, failed over or was recovered into a new run, whose token no longer works, or you stopped it), when `answer_timeout_minutes` pass, or when Lair restarts before the answer comes (tokens live in memory only). Its token ends, and whatever still runs of its task is stopped (its claim released). Nothing is retried on its own: ask again. An answered question whose run is still going at its deadline is stopped too.

**Bounds.** A question that would start a run past `max_runs_per_day` (in the 24 hours before), or sooner than `min_interval_seconds` after the last supervisor run started, is refused with why and when to try again (HTTP 429); so is a question past `max_conversation_turns` (409). A refused question leaves nothing behind. The agents module's budgets apply on top: an agent over its budget starts nothing.

### The daily digest

With `digest.enabled`, a supervisor run writes a digest each day at `digest.time`, this machine's local time (or as soon as Lair runs after it, the same day). Lair asks it for what moved; what is stuck, and since when; the holds and decisions waiting for you; failures that repeat; the self-checks failing; and the trend against the days before. The run, its prompt, its token and its answer are as for a question; its context has no conversation.

- **Home** shows the latest digest, with its evidence, and "No digest yet" before the first.
- **One notice**, "Today's digest is ready (<date>)", is raised in the Decision Inbox when the digest's answer comes, if Lair's [notifications](#notifications) are on. Like every notice it is listed under FYI and never pushed; the previous day's, if still open, is withdrawn.
- **The same bounds.** A digest run counts toward `max_runs_per_day` and waits for `min_interval_seconds`. One that can't start yet because the supervisor agent is busy with another run, or it is too soon after another supervisor run, is tried again a minute later (no token is minted for a try that doesn't start). Any other refusal is for the day: the day's runs used up, the budget, no supervisor agent, its task claimed by another run, the agent held by another module; the day's digest is skipped, and Home says why. A digest run that ends without an answer is "no digest" for that day: it is not started again.

### What the supervisor can and can't do

- **It can** read this project through the ops API's read tools, redacted and bounded, every call audited, while its run lasts; and submit one answer per question.
- **It can't**, through Lair: write anything (the ops API has no write tool yet: proposals come with S2, acting with S3), answer your decisions, use your owner session, start or stop agents, or read another project. Its answers change nothing; a "Lair can do" step is a suggestion you carry out.
- **It is still an agent process on this machine.** Lair starts it as it starts any agent, as your OS user unless you run agents as another one, so Lair can't keep it from editing files or running git: the prompt tells it not to, and running agents as a separate OS user ([design](design/autonomy.md#6-agents-budgets-failover-and-session-recovery-module-agents)) makes it so. Everything it reads from the fleet (logs, queue lines, PR text, decisions) is data; its prompt says so, and its answer is shown as untrusted text.

### Chat and digest API

Every route is the owner's (`/api/supervisor` is in `OWNER_ONLY_PREFIXES`), except the answer, which takes the run's ops token. `project` defaults to the default project.

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/api/supervisor/ask` | Body `{project?, question, conversationId?}` (a question of at most 2000 characters): `{conversation}` (202), the question pending. 409 when questions are off, there is no supervisor agent, the conversation's last question still waits or it has `max_conversation_turns`, or the agent is busy; 429 past the bounds; 403 over budget or `read_only`; 404 for a conversation of another project |
| `GET` | `/api/supervisor/chat?project=<name>` | `{project, enabled, digest: {enabled, time}, agent, problem, limits, runsToday, nextRunAt, conversations: [{id, kind, title, createdAt, updatedAt, turns, state}], repoUrl}` |
| `GET` | `/api/supervisor/conversations/:id` | `{id, project, kind, digestDate, createdAt, updatedAt, repoUrl, turns: [{id, seq, question, askedAt, state, runId, agent, deadlineAt, answer, evidence, answeredAt, reason}]}`; `state` is `pending`, `answered` or `no_answer` |
| `GET` | `/api/supervisor/digest?project=<name>` | `{project, enabled, time, latest}`: the latest digest, a conversation as above |
| `POST` | `/api/ops/answer` | A run token. Body `{conversation, answer, evidence?}`: `{conversation, turn}`. 401 without a live token, 403 for a token that isn't the asked run's, 404 for an unknown conversation, 409 for an answer already given or a closed question, 400 for an invalid answer or evidence |

The conversations are kept in `data/supervisor.db` (schema version 2), for 90 days after their last change.

## Delivery

> Off by default. With `enabled: true` Lair reads your environments' status, and runs Up, Down, Restart and Deploy when you ask from the Delivery view. It deploys on its own only with `deploy.auto: true`.

Delivery ([design](design/autonomy.md#7-delivery-module-delivery-platformmd-milestone-m4-brought-forward-for-environment-1)) manages a project's **environments**. An environment is a docker compose project, such as the developer's own running stack. Every `interval_seconds` Lair reads each configured service's containers (`docker compose ps`, `docker inspect`) and its health check, and shows them in the Delivery view: state (`running`, `stopped`, `unhealthy`, `restarting` or `unknown`), health, restart count and the last error lines of its log. From the view you can bring the whole environment, or one service, up, down or restart it. Down, Restart and Deploy ask for confirmation first, and Down asks for a reason.

Lair shows and acts on the services you list under `services` only. Other services of the same compose project are left alone: no command names them, an environment Down doesn't stop them, and an Up doesn't start them (every start uses `--no-deps`).

What Lair does, and what it never does on its own:

- **Unknown state.** When the environment can't be read (the docker CLI is missing, the daemon is down, `docker compose ps` fails), every service shows as `unknown` with the error, never a guessed `stopped` or the last `running`. Up, Restart and Deploy then answer `409` until a read succeeds; Down still works, because holding is always safe. The status route never runs docker itself: it shows the latest read, and `not read yet` before the first one.
- **Up** starts the services in `start_order`, one at a time, and waits for each one to be healthy before the next (`start_timeout_seconds`). If a service doesn't become healthy, the services after it are not started.
- **Held services.** A service you take **Down** is *held*, with your reason. Lair never starts a held service: an environment Up skips it, a deploy skips it, and the watchdog leaves its container alone. It stays held, across restarts of Lair (the hold is stored in `data/delivery.db`), until you **Release** it. Each held service has [one decision](#one-decision-per-hold) while it is held ("Release it" / "Keep it held"), withdrawn when you release it in Delivery or an environment Up does. An environment Down stops every configured service (`docker compose stop`, never `docker compose down`, so containers and unmanaged services stay) and holds them; the next environment Up releases those holds again. A service you took down on its own stays held. Down works even while another operation runs (a build, a health wait): the service is held at once and stopped, and that operation re-checks holds before each command, so it never starts or recreates the service again. If the Down lands while that operation is already starting the service, Lair stops it again as soon as it sees the hold: a held service never stays running.
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

The `review:` block turns on risk tiers, recorded reviews, the test integrity check and policy merge for a project ([design](design/autonomy.md#5-reviews-and-policy-merge-module-review-extends-policy)). It is off unless `enabled: true`, and it never merges a project with `read_only: true`. The PRs section lists the open PRs with their readiness from that evaluation: a PR is "Merge ready" only when the review module allows the merge at its head, and otherwise shows "Waiting:" with the first reason. A PR's detail (`#/prs/<n>`) shows its tier, required reviews and who holds each, findings, the gate at the head, and the merge button with the reasons it is disabled. Without `review.enabled` the list only says "Gate passed": that a gate passed at the head.

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
| `agent:<id>` | That reviewer agent, never the author; the author must be known (an unknown author may be that very agent) |
| `peer` | Any reviewer, agent or human, other than the author |
| `self` | The author's own review (its self-check) |
| `{any_of: [...], different_model: true}` | Any of the listed ones; with `different_model`, an agent on a model other than the author's (a human always qualifies). `pool: [ids]` names the reviewer agents for this slot ([Reviews by agents](#reviews-by-agents)) |

Defaults: `red: [human]`, `amber: [peer]`, `green: [self]`. Only an `approve` given at the PR's current head sha counts; a push makes every older review stale, and a reviewer's later review replaces its earlier one. The author is the agent Lair's own modules registered for the PR (the agent assigner or intake; never settable over HTTP), else the agent the branch mappings name (`authors.branch_pattern`, `authors.branches` and `authors.from_tasks_file`, see [Reviews by agents](#reviews-by-agents)); its model comes from `dragons:` or `authors.models`. `branch_pattern` is a template, not a regular expression: `{agent}` (exactly once) is an agent id, `*` matches within one path segment and `**` (at most once) across segments, and everything else is literal, so `agent/{agent}/**` reads `worker-a` from `agent/worker-a/fix-login`. Branch names longer than 255 characters never match. With no author, no agent slot (`agent:<id>`, `peer`, `self`) and no `different_model` can be satisfied, no agent is asked to review, and the status says why (`authorNote`).

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

The merge request must confirm (`confirm: true`) and name the head sha it was shown; if the head moved since, it is refused. When all of the above hold, `merge.check_cmd` runs (if set, [below](#pre-merge-check)), and only then the merge method. A refusal says what refused it (`refusedBy`: `head`, `policy`, `check`, `emails` or `executor`).

`merge.gate.source: checks` reads the host's check runs at the head. Each `required` entry is `{name, app}` (or just the name, meaning `app: github-actions`), and only a check run by that name **created by that app** (its slug or numeric id) counts. Commit statuses count only when posted by an account in `status_creators` (empty by default). This matters because anyone whose token can write statuses, or who can install an app, can post a "success" under any name; results from other apps and accounts are ignored, and the status says how many were. The red default branch hold reads the same source.

`merge.gate.source: signed` reads gate results that a Lair node signed and posted to `POST /api/review/gate-results`, verified with `node_keys` (node id to public key) and `pipeline_versions` (pipeline id to version); a result's `projectId` must be the Lair project name. A result can't be forged without a node's key, so prefer `signed` for projects with red-tier code (money, auth, migrations), where a forged check is most costly. Every stored result is verified each time the gate is read: its node is in `node_keys` and its `nodePublicKey` is that key, the signature, the project, the pipeline version, a real run, and its commit is the PR's head. For each pipeline the newest result that passes those checks decides, so an older pass can't hide a newer failure.

- **Over HTTP.** Any local process can reach `POST /api/review/gate-results`, so a result is refused (403) and not stored unless its `nodeId` is in `node_keys`, its signature verifies with that key (whatever `nodePublicKey` the body names), and it is for this project.
- **First wins.** The first result kept under an id stays: a later one with the same id, identical or not, changes nothing (the answer says `stored: false`), as triage takes an id once. Nobody can replace a newer failure so that an older pass decides.

- **All of, or any of.** Each plain entry of `required` must pass. An entry `{any_of: [pipeline ids]}` is a group, which passes when any one of its pipelines passes at the head. The status and the refusal name the group, as `any of (backend, docs)`, and say what each of its pipelines showed. Use a group when one gate queue runs one of several tracks per change (a backend track or a docs-only track) and any one of them is enough. A group is for `source: signed` only.
- **From triage.** With `from_triage: true`, the signed results that [triage](#triage) accepts for the project (`POST /api/triage/results`, as `lair-node gate-result submit` sends them) are handed to the merge gate in-process. A result triage refuses (a bad signature, a node not in `triage.trusted_nodes`, another project) never reaches it, and triage's trust proves nothing here: the gate checks the result with its own `node_keys` and `pipeline_versions` each time it is read, as above. One `node_keys` doesn't verify is still kept, so the PR's gate can say why it doesn't count. So a node needs to be in both: its public key file in `triage.trusted_nodes`, and the same PEM text in `node_keys` (a YAML block scalar, `|`, keeps its line breaks). The first result per id stays here too. Results larger than 8 MiB are not kept for the gate. It is off by default.

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
| `merge.gate` | object | required | `{source: checks, required: [{name, app}], status_creators}` or `{source: signed, required: [pipeline ids or {any_of: [pipeline ids]}], node_keys, pipeline_versions, from_triage}` |
| `merge.gate.from_triage` | boolean | `false` | `source: signed` only: also take the signed results triage accepted for the project |
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
| `merge.check_cmd` | array | — | An argv run before each merge is executed, with `{pr}`, `{head}`, `{base}` and `{repo}` ([below](#pre-merge-check)); non-zero refuses the merge |
| `merge.check_timeout_seconds` | number | `300` | `check_cmd` is stopped after this, and the merge refused (1 to 3600) |
| `merge.auto` | boolean | `false` | Merge every PR the policy allows, from the periodic scan of open PRs ([below](#automatic-merge)) |
| `merge.auto_tiers` | array | — | Tiers that auto-merge applies to: `["amber", "green"]` excludes red; absent or null means all tiers |
| `merge.auto_min_interval_seconds` | number | `120` | The least time between two automatic merge attempts of the project; skipped ones don't count (0 to 86400) |

Other keys: `provider` (`github`), `api_url` (default `https://api.github.com`), `token_env` (default `GITHUB_TOKEN`), `token_cmd` (an argv printing the token, used when `token_env` is unset), `default_branch`, `authors.models` (agent id to model). Unknown keys are config errors; a project with an invalid `review:` block has reviews off, and `GET /api/review/status` shows the errors.

### Pre-merge check

`merge.check_cmd` is your own check of a merge that only your project knows how to make: for example, that the PR's database migrations still come after the ones the target branch got since. It runs for every merge, the owner's and the automatic ones, after every policy condition holds and before the merge method publishes anything.

```yaml
merge:
  check_cmd: ["/opt/checks/migration-order", "--pr", "{pr}", "--head={head}", "--base={base}"]
  check_timeout_seconds: 300
```

- **Placeholders.** `{pr}` is the PR number, `{head}` the full head sha the policy allowed, `{base}` the target branch, `{repo}` the `owner/name` it merges into. Each value is checked for its shape (a number, a full sha, a branch name, `owner/name`) and none may start with `-`, so no value becomes an option; one that fails refuses the merge without running anything. Any other `{name}` is a config error, and so is a placeholder as the program (`check_cmd[0]`).
- **How it runs.** An argv, never through a shell, from Lair's working directory, with only `PATH`, `HOME`, `USER`, `LANG`, `TMPDIR`, `TERM` and `SHELL` from Lair's environment: never the host token or any other variable. Keep the program where agents can't write (not in a repository they work in). It runs in its own process group, so a timeout kills what it started too. If Lair itself is killed (`SIGKILL`, a crash) while a check runs, nothing stops the check: it runs on, orphaned, until it ends. A check should not change anything, so this is harmless; make it end on its own.
- **Its answer.** Exit 0 lets the merge go on. Anything else refuses it, and so does a timeout (the command and what it started are killed): the reason is `Pre-merge check: check_cmd exited <code>` with its first five output lines, stdout first, each made plain (escape sequences dropped, control and text-direction characters made spaces) and cut to 200 characters. At most 64 KiB of each stream is read.
- The merge method still binds the head: if the PR moves while the check runs, the merge is refused.

### Automatic merge

With `merge.auto: true`, the review module's periodic scan of open PRs (every 60 seconds) merges a PR the policy allows. It merges through the same path as the owner's Merge button, at the head it evaluated: the head bound, every policy condition and `check_cmd` again. The merge is recorded as initiated by `lair:policy`. Every name a request gives (a merge's or a hold's `by`, a reviewer) is refused when it starts with `lair:`, so nothing else can be recorded under it.

- **One at a time.** At most one automatic merge per project per scan, and none within `auto_min_interval_seconds` (default 120) of the project's last attempt, so a gate re-run or a reviewer has time to see the new target branch. An attempt counts when it ran (merged, failed or interrupted). A skipped one doesn't count: the head moved, the policy changed, or another merge was running as it started, so it ran nothing.
- **Bounded scans.** The scan reads a PR's gate before anything else. With `source: signed` that read comes from Lair's store. With `source: checks` each read is a call to the git host, and a scan makes at most 20. A scan evaluates at most 10 PRs in full. Each scan starts after the PR the previous one stopped at, so no PR waits forever behind others.
- **Tier limits.** `auto_tiers` limits which tiers auto-merge applies to. With `auto_tiers: [amber, green]`, a red-tier PR that the policy allows (`canMerge: true`) is never merged automatically, no decision is raised, and its status shows `autoMergeStatus: "manual"`. The owner's Merge button still works. An empty array is a config error (use `auto: false` instead). When `auto_tiers` is absent or null, all tiers auto-merge. A config reload that removes a tier from `auto_tiers` stops automatic merges of that tier from the next scan.
- **Red.** With `hold_when_default_red` (the default), while the default branch is red, the only PRs the policy lets through are proven reverts with an exempt label. Such a PR merges automatically only when every slot of the **red** tier (`reviewers.red`) is filled at its head, whatever its own tier. A red-tier PR needs those reviews anyway. The owner can still merge it from its page.
- **A failure.** A refused or failed automatic merge (the check, the email allow-list, the clone or the push) is recorded and raises **one** decision per PR and head (an email refusal's own `security` decision stands for it), and is not tried again at that head: fix the cause and merge from the PR's page, or push a new head. A head that moved, or a policy that changed, between the evaluation and the merge is no failure: the next scan looks again.
- **Restarts.** Each automatic merge is written to the store before it starts. One still there after a restart (Lair stopped while it ran) is never run again: it raises one decision to check the target branch, and only a new head of that PR merges automatically. Lair reports it when it loads the project, even with `merge.auto` turned off since or `read_only: true`. A restart from the dashboard waits for a merge in progress.
- **Read-only.** A project with `read_only: true` never merges, automatically or not.

Start with `auto: false`, and compare the PRs shown as "Merge ready" with what you would merge, before you turn it on.

### Gates from an external queue through triage

A project whose gates run in its own queue (not Lair pipelines) sends each finished gate to triage with `lair-node gate-result submit` ([Results from an existing gate system](#results-from-an-existing-gate-system)). To let those results also decide merges, trust the node in both places, turn on `from_triage`, give each pipeline its version, and require what a change needs:

```yaml
triage:
  enabled: true
  trusted_nodes:
    - id: ci-gates
      public_key_file: ./data/keys/ci-gates.pub        # not in the project's repository
review:
  enabled: true
  merge:
    gate:
      source: signed
      from_triage: true
      # backend changes run the backend track, docs-only changes the docs track: either is enough
      required: [{ any_of: [backend, docs] }]
      node_keys:
        ci-gates: |                                     # the same PEM as ./data/keys/ci-gates.pub
          -----BEGIN PUBLIC KEY-----
          ...
          -----END PUBLIC KEY-----
      pipeline_versions: { backend: "1", docs: "1" }    # what the runner sends as --pipeline-version
    method: local
    local_strategy: ff-only
    require_up_to_date: true
    check_cmd: ["/opt/checks/migration-order", "--pr", "{pr}", "--head={head}"]
    auto: false                                         # true once its "Merge ready" verdicts match yours
```

The runner sends `--pipeline <id>` and `--pipeline-version <version>` with each result. A result whose pipeline version isn't in `pipeline_versions`, or that a node outside `node_keys` signed, is stored but never passes; the PR's gate says why.

### Reviewers and the Decision Inbox

`POST /api/review/prs/:number/request-reviews` (owner only: asking can start reviewer runs) asks for every missing review at the head, once per head: a named or peer reviewer agent, or the author's self-check, through the agent assigner, and a human through the Decision Inbox. A slot is asked for again at the same head only after its assignee reviewed without filling it (for example on the author's model when `different_model` is set), as a new round: the earlier rounds' records stay. A round is written, with its token's hash, before the assigner is called; one that Lair never finished handing on (it stopped in between, or the assigner failed) doesn't count after 10 minutes, so the slot can be asked for again. When the PR gets a new head, the human reviews asked for at the old one are withdrawn from the Decision Inbox, so only the current head's request stays open.

Each agent assignment carries a random token, which the assigner must hand only to the agent doing the review; Lair stores only its hash, recorded before the assigner is called. A token counts for **one** review: a second review with it is refused (403), and so is a review under an assignment that a later request replaced. An assignment for a named agent (or the author's self-check) is that agent's, and a review under it must name that agent; one for any peer binds to the first agent, other than the author, that reviews with it.

A project with [reviews by agents](#reviews-by-agents) has its named and peer reviews done by agents Lair starts; otherwise, and for self-checks, agent requests are published on the event bus as `review.assignment_requested`. The assignment event carries the token, and the event bus is internal to the server: it is not served over HTTP. The review module's decisions (a human review, a refused merge, no agent review) are raised in the [Decision Inbox](#decision-inbox) as module `review`. Other events: `review.submitted`, `review.invalidated` (a push made reviews stale), `review.merged`, `review.merge_refused`.

### Reviews by agents

With `prompt_file` set (and `agents.enabled: true`, see [Agents](#agents)), a PR's `agent:<id>` and `peer` reviews are done by reviewer agents that the agents module starts and supervises, so a PR doesn't wait on a human reviewer. Self-checks and `human` slots are asked for as before.

```yaml
review:
  enabled: true
  prompt_file: review-prompt.md          # a file name in prompts_dir
  reviewers_pool:
    amber: [reviewer-a, reviewer-b]
  reviewers:
    red: [human, { any_of: [peer], different_model: true, pool: [reviewer-c, reviewer-d] }]
    amber: [peer]
  retries: { max_attempts: 3, backoff_seconds: 120, max_backoff_seconds: 3600 }
  authors:
    branches: { "team/**": worker-a, "fix/*": worker-b }
    from_tasks_file: true
```

**When it asks.** Lair scans the open PRs every minute and asks for the missing reviews of a non-draft PR when it first sees it or its head changed, at most once per PR in 5 minutes. The owner asks too, with "Request missing reviews" in a PR's detail (PRs section) (`POST .../request-reviews`, owner only). A round that failed (below) starts again only when the owner asks.

**Who reviews.** Nobody, while the PR's author is unknown: any agent, a named one too, could be the author. Otherwise, for each missing slot at the head, Lair takes, in pool order, the first agent that:

- is in the slot's `pool`, else in `reviewers_pool.<tier>` (for an `agent:<id>` slot: that agent), and is not the PR's author;
- with `different_model`, shares no model with the author: none of its profiles (its `agents.fallbacks` included) runs on the author's model or on a model of any of the author's profiles, so neither side's failover can land on a shared model;
- is free in the agents module (no active run, not over budget), is not reviewing this PR already, and hasn't reviewed this head.

An agent whose run on the slot already ended without a review comes last. With no agent free, the slot stays `requested` and is tried again on the next check (every 15 seconds), which doesn't use up an attempt. When no agent can ever take it (every pooled agent sharing a model with the author, no pool), the slot fails with the reason. When the configuration is why, Lair also raises one Decision Inbox item for the project and reason, however many PRs hit it while it is open: no pool; no pooled agent but the author itself, or ones that share a model with the author, have a profile without a model, or are not agents of the project; a refused `prompt_file`; the agents module off. When this PR is why (an agent already reviewed this head, or the tasks file left it as a possible author), the slot just fails. Runs are bounded by the pool, the agents module's budgets and `retries.max_attempts`.

**The run.** Lair requests the run in-process, for task `review-<pr>-<head8>` (with `-2`, `-3`, ... for a tier's further slots), so claims, locks, budgets, recovery and failover apply as to any run. Its prompt is `prompt_file`: one file name directly in `prompts_dir` (no path, and a symlink only to a file in the same directory), a regular file of at most 200 KB. The project's `default_instructions` (the builders' standing orders) don't go before it; the reviewer agent's own `instructions` do. The file is used verbatim except for these placeholders, each replaced in one pass:

| Placeholder | Value |
|---|---|
| `{pr}` | The PR number |
| `{head}` | The full head sha the review binds to |
| `{repo}` | `owner/name` |
| `{tier}` | `red`, `amber` or `green` |
| `{base}` | The target branch |
| `{url}` | The PR's URL on the host |
| `{findings_format}` | How `lair review submit` reads findings (below) |

Each value is checked against its shape first (a number, a full sha, `owner/name`, a plain branch name, an http(s) URL). When a PR's values don't fit, the request is refused with the reason and no run starts. Lair writes run prompts to `prompts_dir`, and agents that run as your OS user can write there too: run them as a separate user ([design](design/autonomy.md#6-agents-budgets-failover-and-session-recovery-module-agents)) so they can't rewrite the reviewers' instructions.

**The token.** The assignment token reaches the run's environment only, as `LAIR_REVIEW_TOKEN`, with `LAIR_REVIEW_PROJECT` (the project) and `LAIR_URL` (this server). These are run variables that the agents module keeps in memory: they are never written to its store, the prompt file or a log, and Lair's review store keeps only the token's hash. A config reload of the agents module keeps them; if Lair restarts before the run starts, they are gone, so the run ends (`failed`: "its run variables ... were lost in a restart") and the slot is assigned again with a new token.

A review is taken under the token only once, only while the run Lair started for it is running, and only as that run's agent; the reviewer id is the assignment's. An environment is not a secret from the same OS user, though: other processes of that user can read it (`/proc/<pid>/environ` on Linux, `ps eww` on macOS), and so can the reviewer's own subprocesses. While the reviewer's run lasts, an author agent running as the same user could take its token and review first. Run each agent as its own OS user, apart from the Lair server ([design](design/autonomy.md#6-agents-budgets-failover-and-session-recovery-module-agents)).

**Submitting.** The reviewer runs:

```
lair review submit --pr <n> --head <sha> --verdict approve|request_changes --summary-file <file> [--findings-file <file>]
```

It is `node <lair>/dist/cli/lair.js review submit ...` after `npm run build`, or `npm run --silent lair -- review submit ...` from the Lair repository. It reads `LAIR_REVIEW_TOKEN`, `LAIR_AGENT`, `LAIR_REVIEW_PROJECT` and `LAIR_URL` (default `http://127.0.0.1:4777`) from its environment and posts to `POST /api/review/prs/<n>/reviews`. The findings file has one finding per line, `path:line: severity: text` (severity `critical`, `high`, `medium`, `low` or `info`). With `request_changes` every finding blocks; with `approve` none does. The summary holds at most 10000 characters, and a review at most 200 findings. The token is never printed. Exit codes:

- `0`: the review was recorded;
- `1`: Lair refused it (a wrong, used or another agent's token, a run that ended, a closed PR, an invalid review);
- `2`: a usage or input error, and nothing was sent;
- `3`: Lair could not be reached, or answered with a server error.

The model recorded with the review is the one of the profile the run actually runs on (after a failover, the fallback's), not one the review claims.

**Retries and decisions.** A run can end without a review: it exited without submitting, crashed past the agents module's own recovery, or was escalated. Then the slot is retried with a new token (the old one stops working) after `retries.backoff_seconds`, doubling up to `retries.max_backoff_seconds`, by an agent that hasn't tried yet when there is one. After `retries.max_attempts` runs the slot fails and Lair raises an `escalation` decision in the Decision Inbox ("No agent reviewed PR #n at <sha>"); only the owner's "Request missing reviews" starts a new round. A push or a closed PR makes the open assignments `stale`: nothing more starts for that head, and a review run still going is stopped (its claim is released, and the agents module stops it on its next check). The state is in `data/review.db` (schema version 2), so a restart carries on where it stopped.

**Status.** A PR's "Required reviews" table (PRs section) shows each slot's request, read-only: `requested` (with the retry time), `assigned to <agent>` (the run and the attempt), `reviewed by <agent>`, `failed` or `stale`, with the detail. `GET /api/review/prs/:number` returns the same as `assignments`.

**Authors.** A peer review needs to know who wrote the PR. Besides `authors.branch_pattern`, which reads an agent id carried in the branch name:

- `authors.branches` maps branch globs to agent ids, for branches such as `team/topic`: `*` matches within one path segment, `**` across segments and `?` one character (at most 100 entries);
- `authors.from_tasks_file: true` reads the agents fill tasks file (`agents.fill.tasks_file`, relative to `repo`: `<agent>|<name>|<task>|<description>` lines, at most 256 KB and 200 tasks). A line's branch comes from its description: `(branch: <name>)`, or a `(<prefix>/<topic>)` token in parentheses.

The tasks file is on the agents' side of the trust boundary: agents can write it, so it never decides an author on its own. It only confirms `branch_pattern` and `branches`: when those match several agents it may narrow them to one it names, and a line naming an agent they didn't match leaves the author unknown. When it narrows, the other agents those mappings matched may be the real author, so none of them reviews the PR, or counts as its reviewer (`authorExcluded`). When the mappings (or two entries of one) name different agents, the author stays unknown and the status says why (`authorNote`): an unknown author holds a PR back, a wrong one would let it review its own work.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `prompt_file` | string | — | The reviewer's prompt: a file name in `prompts_dir`. Turns reviews by agents on; needs `agents.enabled: true` |
| `reviewers_pool.<tier>` | array | — | Reviewer agents for the tier's slots (a slot's `pool` takes precedence) |
| `retries.max_attempts` | number | `3` | Runs per slot and head before the owner is asked |
| `retries.backoff_seconds` | number | `120` | First retry delay, doubling |
| `retries.max_backoff_seconds` | number | `3600` | Longest retry delay |
| `authors.branches` | map | `{}` | Branch glob to agent id |
| `authors.from_tasks_file` | boolean | `false` | Let the agents fill tasks file confirm or narrow the branch mappings (never decide alone) |

### Review API

`?project=` defaults to the default project. Routes marked (owner) need the owner's session (`X-Lair-Owner-Session`, from the dashboard), and `/api/review` is in `OWNER_ONLY_PREFIXES`, so no CORS is granted for it. Every name a body gives (`reviewer`, `reviewer.id`, `by`) is refused (400) when it starts with `lair:`: those are Lair's own (`lair:test-integrity`, `lair:policy`).

- `GET /api/review/status`: on or off, config errors, repository, read-only
- `GET /api/review/prs`: open PRs with the tier and verdict of their last evaluation at the current head
- `GET /api/review/prs/:number`: the evaluation: tier and matched rules, required and present reviews, reviews, findings, the gate at the head, holds, every condition, and the merge plan
- `POST /api/review/prs/:number/reviews` (agents) with `{reviewer, head_sha, verdict, summary, findings, assignment_token}`
- `POST /api/review/prs/:number/request-reviews` (owner): ask for the missing reviews at the head
- `POST /api/review/prs/:number/owner-review` (owner) with `{reviewer: name, head_sha, verdict, summary, findings}`
- `POST /api/review/prs/:number/merge` (owner) with `{confirm: true, head_sha, by}`: 200 when merged, 409 with the reasons (and `refusedBy`) when refused, 403 without the owner's session or for a read-only project
- `POST /api/review/findings/:id/resolve` (owner) with `{by: name, status: resolved|dismissed, note}`
- `GET /api/review/holds`, `POST /api/review/holds` with `{reason, pr?, by}`, `POST /api/review/holds/:id/release` (owner) with `{by}`. Each unreleased hold has [one decision](#one-decision-per-hold) (module `review-holds`): "Release the hold" releases it as you; releasing it here withdraws the decision
- `POST /api/review/gate-results` with a signed gate result: 403 unless `node_keys` verify it for this project; `{id, stored}`, where `stored: false` means a result with that id was already kept (the first one stays). With `merge.gate.from_triage`, triage's accepted results arrive in-process too
- `GET /api/review/merges`

## Agents

> Off by default. With `enabled: true`, Lair starts the agent runs you request itself (one process per run, no shell) and supervises them: claims, locks, session recovery, failover and budgets ([design](design/autonomy.md#6-agents-budgets-failover-and-session-recovery-module-agents)). A `read_only: true` project is shown but never started, stopped, released or broken.

A run is requested for an agent (a `dragons:` entry or a `dragons.txt` line) and a task, with a prompt: by the owner (`POST /api/agents/runs`, with an owner session) or by another Lair module, in-process. Lair starts it with the agent's adapter (`start_cmd`, see [Agents](agents.md#agent-adapters)), its model, and the prompt file (`prompts_dir`). The process's output goes to `agents_dir/<agent>-<UTC>.log`, the log the dashboard and the watchdog read. The command must run the agent in the foreground: Lair supervises the process it started, so a launcher that starts the agent in the background and exits looks like an agent that died on start. A request's `model`, when given, must be one the project names for that agent (its own, or a fallback's).

**The agent's environment is built, not inherited.** It gets `PATH`, `HOME`, `USER`, `LANG`, `TMPDIR`, `TERM` and `SHELL` from the server's environment, the variables listed in `env_passthrough` (a provider API key its CLI needs, say), and its run's own: `LAIR_RUN_ID`, `LAIR_TASK`, `LAIR_AGENT`, `LAIR_SESSION_ID`, `LAIR_SESSION_MODE` (`new`, `resume`, `fresh`), `TASK`, `MODEL`, and the adapter's `session_id_env` set to the session id. A run another module requests also gets that module's run variables, kept in memory only: a review run's `LAIR_REVIEW_TOKEN`, `LAIR_REVIEW_PROJECT` and `LAIR_URL` ([Reviews by agents](#reviews-by-agents)), a supervisor run's `LAIR_OPS_TOKEN`, `LAIR_SUPERVISOR_CONVERSATION` and `LAIR_URL` ([Supervisor chat and digest](#supervisor-chat-and-digest)). Nothing else of the server's environment reaches an agent: no `LAIR_NODE_TOKEN`, no other `LAIR_*` variable in any letter case (`env_passthrough` refuses them), and nothing else you exported before starting Lair.

- **Claims.** A task is claimed by exactly one run. The claim is owned by a process: the Lair server while the run starts, then the agent's process. An owner is a pid **and** that process's start time, so a pid the system gave to another process is not the owner. A second request for a claimed task is refused (HTTP 409) while the owner lives; a claim whose owner is dead is released and logged. An owner is only judged dead on a process reading taken after its claim was read, so one that claimed a task a moment ago is never mistaken for a dead one. A run that loses its claim (released from the Work section, say) stops itself. One agent runs one task at a time. Task ids are 1 to 128 letters, digits, `.`, `_`, `-`, `/`, `:` or `#`, start with a letter or digit, and have no `.` or `..` segment.
- **Locks.** `agents.locks` are lock files every run takes before it starts (`hold: launch`, released once the agent runs) or for as long as the agent runs (`hold: run`, owned by the agent's process). Lair writes `pid=<pid>`, `started=<ISO time>` and `owner=<who>` and creates the file exclusively. A lock whose holder is dead (not running, or its pid now belongs to a process that started later) is broken: at once when a run waits on it, and on the second check in a row that finds it dead when none does (an external launcher's lock, say). A holder is only judged dead on a process reading taken after its lock was read. Every break is logged as a `lock_broken` event with the holder, and counted. Legacy locks are read too: a file holding only a pid, or a directory with a `<pid_file>` (as the watchdog's locks), is broken when that pid is dead; one with no pid at all is broken once it is `stale_minutes` old, and only when a run waits on it, unless the lock sets `break_without_waiter: true`. A lock directory is removed only when it holds nothing but its pid file (nothing is deleted recursively); one with other files is left in place. A run that waits on a lock shows the lock, its holder pid and whether it is alive, and, for a lock with no pid, when it will be broken.
- **Never started.** A run with no live agent process `start_timeout_minutes` after Lair began starting it (time over budget or with no usable profile doesn't count) is `never_started`, with the reason: the lock it waited on and its holder, or the spawn error. It is retried after `retries.backoff_seconds`, doubling up to `retries.max_backoff_seconds`, `retries.max_retries` times; then the task is escalated.
- **Hung, dead on start, crashed.** A running agent is hung by the watchdog's rule (`agent_hung`: its newest log and its process silent for `hung_minutes`), and an agent WAITING on a gate that has no result yet is never hung. A hung agent gets SIGTERM, then SIGKILL after `stop_grace_seconds`. A process that ends with exit code 0 completed. One that ends within `dead_on_start_seconds`, or with an empty log, died on start; any other end is a crash, unless its last log lines show a transient network or provider error (see Transient errors below: that is neither, and counts for nothing). A run whose exit status a restart lost is judged by its queue line instead (see Restarts and hosts below). Every failure restarts the task: with the same session (the adapter's `resume_flag`) up to `recovery.same_session_restarts` times, then in a fresh session up to `recovery.fresh_sessions` times, then it is escalated. A fresh session moves the agent's `session_dir` aside to `<dir>.aside-<UTC>` (it is never deleted) and starts from a resume summary written into the prompt: the task card, the previous attempts, the branch state (`branch_state_cmd`), the agent's latest queue lines and its last gate's log, and the previous session's last output. Restarts wait `recovery.backoff_seconds`, doubling up to `recovery.max_backoff_seconds`.
- **Failover.** An agent's profiles are its own adapter and model, then `agents.fallbacks.<agent>` in order. A run whose log's last lines match a rate limit or provider error (`failover.*_patterns`) when it exits, or whose log has been silent for `failover.silence_seconds` on such a last line, is stopped and the task moves to the next profile, with a resume summary, as a `failover` event (from, to, the line). The agent's own output triggers this, so it is bounded: a task fails over at most `failover.max_failovers` times and is then escalated, and its restart counters carry over (failing over never buys more restarts). The provider that failed is skipped for `failover.cooldown_minutes` by the agent whose run hit it, and by every agent only once runs of two or more agents hit it within that time; a provider the fleet budget has paused or rate limited is skipped too. Only when every profile is unusable is the owner asked (once), and the task waits for the first cooldown to end. Make fallbacks no dearer than the primary: a failing agent moves its work to them.
- **Transient errors are waited out.** A provider or network outage makes every start die within seconds, with the same line in every log (`Error: A network error occurred ... "errorType":"ClientNetworkError","retryErrorType":"TRANSIENT"`, `read ECONNRESET`, `HTTP 503 Service Unavailable`). None of that is the agent's fault, so it counts for nothing, within bounds. A run whose last 3 non-empty log lines (each trimmed and cut to 500 characters) match one of `transient_patterns` is **not** a recovery attempt. That holds when it exits, dies on start, ended while Lair was restarting, or went silent on such a line. Instead:
  - its provider is marked **unreachable** for that agent, with when and the line that matched (a `transient` event, kept in the store, so it survives a restart). The task's next attempt is queued at once with the same session and counters: it counts toward neither recovery, nor failover, nor escalation, nor `start_timeout_minutes`. A run that died on start starts again as it would have; one that had run past `dead_on_start_seconds` resumes its session;
  - an unreachable provider is passed over like one cooling down (see Failover above), so the next attempt starts on a fallback on another provider when the agent has one, without counting as a failover. Only with no usable profile left does the run wait;
  - the outage is the **fleet's** once the runs of two agents die of it within 15 minutes, or the agent's own retry dies the same way. Until then only the agents whose runs died wait, and one agent's output can't stall the others. From then on every start on it waits, whoever asks for it (fill, the owner, other modules). The run's detail and the Agents status (`unreachable`, also on the Work view and in Home's FYI) say `not starting: provider <p> unreachable since <time> ...; next try at <time>`;
  - one start at a time tries the provider again: after 60 seconds, then doubling (2, 4, 8 minutes) up to every 15 minutes. A run waiting on a lock is not that try, so it holds nothing up. A try that dies the same way doubles the wait; runs already running that die meanwhile only add to the count;
  - the provider is reachable again (`transient_cleared`) once a run shows it works: one started during the outage that is alive after `dead_on_start_seconds` or exits 0, or one started before it that is still writing its log after the latest failure (and not the error itself). Every run waiting on it starts on the next check, and the next outage's backoff starts again from 60 seconds;
  - each task gets at most `transient_max_retries` (5) such retries. Every attempt of the task's chain keeps the count, and only a run that lived `transient_max_minutes` starts it again. After that, a transient death is recovered and escalated like any other, so an agent whose own output looks like an outage can't restart for ever;
  - when a fleet outage has lasted `transient_max_minutes` with runs waiting on it, Lair raises **one** decision for the project, per provider and outage, never one per agent or task: "Keep waiting" (recommended) or "Try now", which lets every waiting run start on the next check. While it is open nothing more is raised. After "Keep waiting", Lair asks again once the outage has lasted another `transient_max_minutes`.

  The defaults look for an error, not a word alone, because an agent's own output (its tests, say) is in the same log: `expected 503 to equal 200` or a word like `TRANSIENT` in prose is not an outage. Tune them to your agent CLIs' output.
- **Budgets.** Token and cost limits per UTC day and month, for the project (`budgets.project`) and for each agent (`budgets.agent`, overridden per metric by `budgets.per_agent.<id>`). Usage comes from the fleet budget: every cost recorded there with a project (and agent) is counted, including the usage Lair reads from run logs with `usage_patterns` (named groups `tokens` and `cost`, each match adds), which it records through the fleet budget. A soft limit is a `budget_warning`, once per period. A hard limit stops new runs and restarts for that scope (running agents continue) and raises a `spend` decision, once per period. **These budgets are advisory** while usage comes from run logs: the agent writes that text, so it can under-report (amounts are never counted below zero). They become reliable once providers or adapters report usage to the fleet budget themselves; keep a spending limit at the provider too.
- **Decisions.** They go to the [Decision Inbox](#decision-inbox) as module `agents`, and the owner's answer is carried out:
  - an escalated task (`escalation`, one per escalation of a task): `fresh_session` starts it again in a fresh session (if that fails too, Lair asks again), `release` leaves it unclaimed;
  - every profile failing (`escalation`, once per task): `wait` keeps it waiting for the cooldown, `stop` ends the waiting run and frees the task;
  - a hard budget limit (`spend`, once per scope, metric and period; answering needs `confirm: true`): `allow` lets new runs and restarts in that scope start past the limit until the period ends, `wait` keeps them waiting;
  - a task [fill](#fill) holds for you, or that has waited too long (`escalation`, once per hold): `start_again` lets fill start it again, `keep_held` keeps it held (or waiting);
  - a provider unreachable for the fleet for `transient_max_minutes` (`escalation`, one open per provider and outage; once answered "wait", asked again after each further `transient_max_minutes`; withdrawn once the outage is over): `wait` keeps trying one start at a time, `retry_now` lets every run waiting on it start on the next check.
  When the inbox refuses a decision (its open-decision cap, say), it is written to `inbox_file` as an `- OWNER? ...` entry with the evidence instead.
- **The watchdog.** The watchdog's `agent_hung` and `orphan_claim` detectors leave an agent with an active run here to this module (their SLO detail says so), so one failure is never handled twice.
- **Restarts and hosts.** When the Lair server stops (Restart, Update, a stop and start), the agents keep running (`on_restart: adopt`, the default). Each run's pid, process group, the start time of its process and a fingerprint of its start command are kept in the store when it starts. Before the new server's first tick judges anything, it reconciles every run the store says is running or stopping against the process table:
  - **adopted**: a process runs under the run's pid and started when the run's process did (within `pid_start_tolerance_seconds`). Lair supervises it to its end as before (hung, failover, a lost claim), its claim stays, and fill counts it as active (a `run_adopted` event). Its command line is checked too (the whole `ps` command line, or the part after an interpreter for a script), but a difference is only noted in the event (`data.commandDiffers`): a start script that `exec`s the agent, or a program that rewrites its title, shows another command line, and pid and start time already identify the process. A run recorded before process groups and commands were kept is adopted on its pid and start time alone, as before;
  - **lost**: a process runs under the run's pid but started at another time: the pid was reused. That process is never signalled, the run ends `failed` (`lost in a restart: ...`, a `run_lost` recovery event), and its task is free;
  - **gone**: nothing runs under the pid. Its exit is classified by its queue line, as below.

  One reading of the process table never ends a run: before a run is lost or gone (here, and whenever a later tick finds a run it didn't start missing), a second, fresh reading taken after the tick's own (never the [shared cache](#process-cache-a2)'s) must say so too. When that reading fails, the run keeps its state, claim and locks, and the next tick reads again. Start times count back from when a reading was taken, allowing for how long `ps` took, so a cached reading seconds old or a `ps` slowed by load doesn't make a live process look like another one; a tick's time is taken after its reading.

  Fill starts nothing until every run has its verdict: a fill check that comes first finds `lastError` saying so and does nothing. A failed `ps` fails the reconciliation as it fails a tick, and the next tick tries again. A `read_only` project reconciles nothing (it starts and stops nothing either).

  With `on_restart: stop`, the server's own shutdown (Restart, Update, SIGTERM or SIGINT) stops the runs too: SIGTERM to each running run's process group (only a process provably the run's), up to `stop_grace_seconds` for them to end, never more than 20 s so the shutdown stays within its 60 s limit, then SIGKILL; every signal is a `stopped_for_shutdown` event. A run this server started is followed by its exit status; a run it adopted, by a fresh reading of the process table every second (never the cache's): one that ends on SIGTERM isn't sent SIGKILL. When the table can't be read, an adopted run isn't signalled, and it gets SIGKILL only when the wait's last reading showed it still running (otherwise it can't be proven the run's). The runs stay `stopping` until the next server's first tick ends them by their queue line: a DONE, WAITING or BLOCKED line completes the run as below; with none it ends `failed` (not counted as a failed attempt) and its task is free, so fill starts a fill task again and any other run is the owner's to start again. With `adopt`, the shutdown never waits on agent runs.

  As a last guard against two runs of one task, fill checks the process table before it starts a task: a live process that no active run owns, whose command line holds one of the task's run prompt files (`<prompts_dir>/<task>-<agent>-<run>.txt`, the file Lair writes for each run and passes as `{prompt_file}`), is a run of the task Lair doesn't know. Fill doesn't start the task (`held: conflict`), records one `fill_conflict` event for that process, and starts it once the process has ended. An adapter whose `start_cmd` doesn't take `{prompt_file}` isn't covered by this check.

  What the new server can't learn is a re-adopted process's exit code (only the server process that started an agent sees it exit; a config reload keeps it), so when one ends, or ended while Lair was down, the agent's queue line decides:
  - a DONE, WAITING or BLOCKED line for the task, written by that agent (by its attribution, `by <agent>`) since the run's chain was requested, completes the run. Its detail says `exit unknown (it ended while Lair was restarting); classified from its queue line: WAITING` (or DONE, BLOCKED), and its `completed` event keeps the line. The line is read with fill's `done_pattern`, `waiting_pattern` and `blocked_pattern` (their defaults when fill is off), so a [fill](#fill) task goes on exactly as after exit 0 on that line: `done`, `held: waiting` until its wake comes, or `held: blocked` with fill's one decision. Nothing is escalated;
  - with no such line, the end counts as one failed attempt (an `exit_unknown` recovery event): the task is restarted with the same session, then in a fresh one, as `recovery` allows, and is escalated only once those restarts are used up, as for a crash.
  Have agents write their DONE, WAITING or BLOCKED line before they exit: across a restart it is the only way Lair can tell a finished run from a crash. Liveness is read from this machine's process table, so one data directory (`data/agents.db`) and its lock files belong to one host: don't share them between machines, or one host would judge the other's processes dead.

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
| `on_restart` | `adopt` \| `stop` | `adopt` | The server's own shutdown: `adopt` leaves the runs working for the next server to adopt; `stop` stops them (SIGTERM to each run's process group, SIGKILL after `stop_grace_seconds`, 20 s at most). See Restarts and hosts |
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
| `transient_patterns` | array | see below | Regular expressions (case-insensitive) for a transient network or provider error in a dead run's last 3 non-empty log lines: waited out, not counted. At most 50, each at most 300 characters |
| `transient_max_minutes` | number | `120` | A fleet outage this long, with runs waiting on it, raises one decision for the project, and again after each further period once answered |
| `transient_max_retries` | number | `5` | Transient retries per task; past them a transient death is recovered and escalated like any other |
| `fallbacks` | map | `{}` | Agent id -> profiles `{adapter, model, provider}` to fail over to, in order |
| `providers` | map | `{}` | Adapter id -> provider name, for cooldowns and the fleet budget |
| `usage_patterns` | array | `[]` | Regular expressions with `(?<tokens>...)` and/or `(?<cost>...)`, read from run logs |
| `budgets.project`, `budgets.agent`, `budgets.per_agent.<id>` | map | — | `daily_tokens`, `daily_cost`, `monthly_tokens`, `monthly_cost`, each `{soft, hard}` |
| `fill` | map | off | Start runs from a task list: see [Fill](#fill) |

The default patterns look for an error, not the words alone, so an agent writing about rate limiting in its own work doesn't trigger a failover: a rate limit is `rate limit ... exceeded|reached|error|retry`, `exceeded|reached|hit ... rate limit`, `error|status|http 429`, `429 too many requests`, `quota exceeded|exhausted` or `usage limit reached|exceeded`; a provider error is `overloaded_error`, `model is overloaded|unavailable`, `api error ... 5xx` or `status|http 500|502|503|504|529`. Tune them to your adapters' output.

The default `transient_patterns` look for an error too: `"retryErrorType":"TRANSIENT"`, `ClientNetworkError`, `network error occurred`, `error ... ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN`, `getaddrinfo EAI_AGAIN|ENOTFOUND`, `error ... connection refused|reset`, `status|http 502|503`, `502 bad gateway` and `503 service unavailable`. They are checked before failover's patterns, so a 502 or 503 doesn't count as a failover: the provider is passed over, and a fallback on another provider takes the task when there is one. Setting `transient_patterns` replaces them all; `[]` turns the rule off.

Unknown keys, invalid regular expressions, more than 50 `transient_patterns` or one longer than 300 characters, a `transient_max_retries` outside 0 to 50, a usage pattern without a named group, a fallback naming an unknown adapter, a `LAIR_*` name in `env_passthrough`, a soft limit above its hard limit, or a `fill` block that is enabled but incomplete (see below) are config errors: the project's agents module doesn't start, and `GET /api/agents/status` shows the errors. Lair reads the config at startup.

### Fill

> Off by default. With `fill.enabled: true`, Lair starts agent runs itself from a task list, so the project needs no launcher loop of its own. Fill only asks for runs: they are started and supervised like any other run (claims, locks, never-started retries, recovery, failover, budgets and escalation all apply unchanged).

`tasks_file` holds one task per line, `<agent>|<name>|<task>|<description>`: the agent id, a display name, the task id and a description (it may be empty and may contain `|`). Blank lines and lines starting with `#` are skipped. Every `interval_seconds` fill reads the file and looks at each line in order:

- An agent that isn't in `fill.agents` is never started (`not allowlisted`). The allowlist is required, so you can move agents over one at a time while another launcher still runs the rest.
- A task with an active run of the line's agent is `started`; one with another agent's run or another claim on it is `claimed`. Neither is started again.
- A task that is `done` is not started again: `done_pattern` matches a queue line (`queue_file`) written since the task was last started (the whole file for a task Lair never ran). Lines are matched as the module's own DONE check reads them: trimmed, and case-insensitively, but the task id must be in the matched text exactly as written (task ids are case-sensitive). A pattern may match by agent instead (see [Matching by agent](#matching-by-agent)). Once fill has seen a task done it keeps that in the store, so rotating or truncating the queue file, or a done line falling out of the 4 MB fill reads, never restarts a finished task. Editing the task's line in `tasks_file` drops what was kept, but the next check finds the done line again while it is still in the queue file. Agents write the queue file, so a done line only keeps fill from starting a task again; it proves nothing else. To overrule a done line you don't trust, request a run of the task yourself (Work section): that is a new start, so only lines written after it count, and fill carries the task on from there.
- A run that exits 0 on a WAITING or BLOCKED line for its task waits, or is held: see [Waiting and blocked runs](#waiting-and-blocked-runs) below. So does one that ended on such a line while Lair was restarting, whose exit code is lost (see Restarts and hosts in [Agents](#agents)).
- A run that exits 0 without writing the done line, or a WAITING or BLOCKED one (an adapter that stops on a usage limit with exit code 0, say), is started again with fill's prompt (built from `prompt_files` again, not the prompt of a run you requested), after `backoff_seconds`, doubling up to `max_backoff_seconds` (`held: backoff`, with the time). After `max_completions_without_done` such runs in a row, fill holds the task (`held: no_done`) and raises one decision in the [Decision Inbox](#decision-inbox) with those runs and the last run's last output lines: "Start it again" (it counts from zero) or "Keep it paused" (recommended).
- A task whose last run ended in any other way than completing is `held: owner`: it is yours to resume, and fill never restarts it by itself. It has one decision, as every hold that needs you ([One decision per hold](#one-decision-per-hold)): a run that was escalated has its escalation, and any other (one you stopped, one whose claim was lost, released by you or not, one that failed while Lair was restarting) gets one from fill. A run that dies is restarted by the module's recovery, not by fill, so there is never a second run of one task.
- A refused start (`held: refused`: the run request was refused, or `done_pattern` couldn't be checked) has one decision too, except when the refusal is a hard budget limit, which has its own `spend` decision. The line shows the decision of its hold (`decisionId`).
- `held: paused` is your own pause: you answered "Keep it paused", or "Leave the task unclaimed" on the escalation of a task fill runs. Nothing waits for you and nothing more is asked; fill starts it again once you release it.
- You lift an `owner`, `no_done`, `blocked`, `waiting`, `waited_too_long` or `paused` hold with the decision's answer, or with "Release hold" in the Work section (`POST /api/agents/fill/release`, owner only); requesting a run of the task yourself works too. Either lifts the hold only while the run it is about is still the task's latest: once the task has moved on (you answered its escalation with a fresh session, say), the release is refused and the next check shows where the task is now. The planner may release only a `no_done` or `blocked` hold.
- Otherwise the task is started when its agent has no active run, fewer than `max_active` runs fill started are active, native capacity checks pass (when configured), and `capacity_cmd` (when set) exits 0. Its prompt is the contents of `prompt_files`, in order, separated by a blank line (`default_instructions` and the agent's `instructions` come first, as for every run). It is requested through the module's in-process request, never over HTTP. A line that waits for any of these is `held`, with the reason: `busy`, `max_active`, `capacity` (the capacity command's first output line), `capacity_load` (load per CPU over limit), `capacity_memory` (available memory below minimum, or pressure above the maximum), `capacity_heavy` (this heavy task, with heavy work at limit), `capacity_probe` (the machine could not be measured: fill fails closed), `prompt` (a refused prompt file), `read_only`, or `refused` (the refused request: over budget, say).
- A line that doesn't parse, names an invalid agent or task id, or repeats a task is `malformed`: it is reported, and the other lines are still filled.

The Work section shows fill's lines, with each line's state, why it is held (for a waiting one, `waiting: <wake> since <time>`, or `waiting: <gate> still queued in <lane> since <time>` while its gate is in the gate queue), and a "Release hold" button for the holds that are yours to lift.

**Prompt files stay inside `prompts_dir`.** In each path `{prompts_dir}`, `{agent}` and `{task}` are replaced, and a relative path is relative to `prompts_dir`. A path with a `..` segment is a config error; at run time a path outside `prompts_dir`, a symlink that leads out of it (one that stays inside is fine), anything but a regular file, or a file over 200 KB is refused and the line is held with the reason. Their text is used as it is: placeholders are not replaced inside it (the agent gets `LAIR_TASK` and `LAIR_AGENT` in its environment), and a line's description is shown in the status, never put into a prompt. Keep `tasks_file` and `prompts_dir` where the agents can't write (not in the repository they work in): whoever edits them chooses what the allowlisted agents work on.

**The capacity command** is an argv, run without a shell before each start, with `command_timeout_seconds` as its timeout. Exit 0 means there is capacity; any other exit code, or a timeout, holds every line that would start in that check, with its first output line as the reason.

**Native capacity checks** let fill decide capacity itself without an external command. Set `fill.capacity.load_per_cpu_max` to hold local agents when the 1-minute load average per CPU exceeds it. Set `fill.capacity.memory.available_min_pct` to hold all agents when available memory drops below that percentage of total. Set `fill.capacity.heavy_work.detect` to a list of task globs that count as heavy work, and `fill.capacity.heavy_work.max_active` to limit how many may run at once.

Agents are either `local` (held by load) or `remote` (not held by load). Set `fill.capacity.default_class` to the default (`"local"`), and `fill.capacity.agent_class` to override it per agent. A remote agent (one that only pushes to GitHub CI, say) starts even under high load, since it doesn't add to the machine's workload.

Memory checks and heavy-work limits apply to both classes. `capacity_cmd` is still honoured as an extra check, after native checks pass.

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

With native capacity checks:

```yaml
agents:
  fill:
    enabled: true
    tasks_file: work/tasks.txt
    agents: [worker-a, worker-b, worker-c]
    prompt_files: ["{prompts_dir}/{agent}.txt"]
    max_active: 4
    capacity:
      load_per_cpu_max: 1.5              # hold local agents when load/cpu > 1.5
      memory:
        available_min_pct: 15            # hold all agents when memory < 15%
        pressure_max: 60                 # ...or when memory pressure > 60%
      heavy_work:
        detect: ["*-backend-gate", "*-e2e-*"]   # these tasks count as heavy work
        max_active: 2                    # at most 2 heavy tasks at once
      agent_class:
        worker-c: remote                 # worker-c only pushes to CI; not held by load
      default_class: local               # the default
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
| `fill.done_pattern` | string | `^-\s+DONE\s+{task}(?=\s\|$)` | Regular expression for a queue line that reports the task done, matched case-insensitively against each trimmed line; the task id must be in the matched text exactly. Must contain `{task}`, `{agent}` or both ([Matching by agent](#matching-by-agent)), inserted as literal text. End the task id at whitespace, not `\b`, `:` or `-`: task ids can contain `-` and `:` |
| `fill.capacity_cmd` | array | — | Exit 0: capacity available; anything else holds, with its first output line as the reason |
| `fill.capacity.load_per_cpu_max` | number | — | Maximum 1-minute load average per CPU before holding local agents. Remote agents are not held by load |
| `fill.capacity.memory.pressure_max` | number | — | Hold new starts (local and remote) while memory pressure is above this percentage (0-100). Linux: `some avg10` of `/proc/pressure/memory`. macOS: 100 minus `kern.memorystatus_level`. A read that fails or times out holds with `capacity_probe` |
| `fill.capacity.memory.available_min_pct` | number | — | Hold new starts (local and remote) below this available memory as a percentage of total (0-100). Linux: `MemAvailable`. macOS: free + inactive + speculative + purgeable pages from `vm_stat` (not just free pages). A read that fails or times out holds with `capacity_probe` |
| `fill.capacity.heavy_work.detect` | array | `[]` | Task-id globs (`*` any text, `?` one character; every other character is literal) that mark heavy work, e.g. container gates. Only a task that matches is held when `max_active` is reached; other tasks, local or remote, are not |
| `fill.capacity.heavy_work.max_active` | number | `1` | Maximum concurrent heavy runs across all agents (counted once per check; a heavy run started in the check counts at once) |
| `fill.capacity.agent_class` | map | `{}` | Per-agent class override: agent id (it must be in `fill.agents`) → `"local"` or `"remote"`. There is no per-task class label yet |
| `fill.capacity.default_class` | string | `"local"` | Default class for agents not in `agent_class`. `"local"` agents are held by load; `"remote"` agents are not |
| `fill.interval_seconds` | number | `60` | Seconds between fill checks |
| `fill.max_completions_without_done` | number | `3` | Runs in a row that exit 0 without the done line; then fill holds the task and asks you |
| `fill.backoff_seconds` | number | `60` | Wait after such a run before fill starts the task again, doubling |
| `fill.max_backoff_seconds` | number | `1800` | Longest such wait |
| `fill.waiting_pattern` | string | `^-\s+WAITING\s+{task}(?=\s\|$)` | A run that ended on such a line waits; same rules as `done_pattern`. An optional `(?<wake>...)` names what it waits on |
| `fill.ready_guard` | boolean | `false` | Refuse a done line that names a PR (`PR #<n>`, and `at <sha>` for its head) unless the PR is ready to review; see the Ready guard note below. Needs `review.enabled` (the PR is read through the review module's git host) |
| `fill.ready_wait_minutes` | integer | `120` | How long a done line that only time can settle (CI still running, the git host not answering) is held and checked again; after that the owner gets one decision and the report stays refused. Counted from the first check, kept across restarts. `ready_guard: true` without `review.enabled` is a config error |
| `fill.blocked_pattern` | string | `^-\s+BLOCKED\s+{task}(?=\s\|$)` | A run that ended on such a line is held for you at once; same rules as `done_pattern` |
| `fill.wake.file` | string | — | The file whose existence ends a wait. `{wake}` (required), `{gates_dir}`, `{agents_dir}`, `{repo}`; relative to `repo` |
| `fill.wake.root` | string | `{gates_dir}` | The directory `wake.file` must stay inside. `{gates_dir}`, `{agents_dir}`, `{repo}` |
| `fill.wake.poll_seconds` | number | `60` | How often fill looks for a waiting run's file |
| `fill.wake.max_wait_minutes` | number | `240` | A task's runs waiting this long in a row (across restarts) hold it, with one decision. Time while the gate it waits on is still in the gate queue doesn't count |
| `fill.wake.max_queue_wait_minutes` | number | `1440` | A task waiting this long in a row is held even while its gate is still in the gate queue (never less than `max_wait_minutes`) |
| `fill.wake.requeue_marker` | string | — | A marker whose first line is the id the waited-on gate was re-queued or re-checked as, followed for a live wait and its result. `{wake}` (required), `{n}` (1 to 9), `{gates_dir}`, `{agents_dir}`, `{repo}`; inside `wake.root` |
| `fill.wake.fallback_seconds` | number | `900` | With nothing to wait on (no capture, no `wake.file`, or a refused capture), the task starts again after this long, or after the backoff if that is later: such a run counts toward `max_completions_without_done` |

A fill block that is enabled without `agents.enabled`, `tasks_file`, `agents` or `prompt_files`, an invalid agent id in `agents`, a `prompt_files` entry with a `..` segment or an unknown placeholder, a `done_pattern`, `waiting_pattern` or `blocked_pattern` with neither `{task}` nor `{agent}`, with an `{agent}` that doesn't come right after `by\s+`, or that isn't a regular expression, or a `wake.file` or `wake.requeue_marker` without `{wake}` (or a `wake.file`, `wake.root` or `wake.requeue_marker` with a `..` segment or an unknown placeholder) is a config error.

#### Waiting and blocked runs

Agents often end a run on purpose before the task is done: on a WAITING line (`- WAITING <task> <gate-id> by <agent> ...: gate queued`, "come back when my gate finishes") or a BLOCKED line ("someone else has to act first"). Fill tells a real wait from an agent that keeps ending on WAITING without anything to wait on, so neither one can restart a task forever.

- **Waiting on something.** A run whose own lines (written since its chain was requested) end on a line matching `waiting_pattern` waits (`held: waiting`). When the pattern captures `(?<wake>...)` and `wake.file` is set, fill starts the task again once that file appears, typically the gate's result (`{gates_dir}/results/{wake}.rc`). It looks for the file at most every `wake.poll_seconds`, and starts the task again once. A file that fill saw absent and then finds is a real wake, whatever its mtime (a copy may keep an old one). So is one first found with an mtime after the run's chain first started (a quick gate can finish before Lair notices the run's end, and an earlier attempt of the chain may have queued it). That run gets no backoff, isn't counted toward `max_completions_without_done`, and doesn't reset the count either.
- **Waiting on nothing.** A WAITING line that names nothing (no capture, or no `wake.file`), names something refused, or names a result that was already there before the run started (a stale gate) is no wait. That run counts as a run without progress, like one without a done line, and stays counted: a result file rewritten later doesn't make it a real wake, so it can't lift a `no_done` hold (only your answer or release does). It starts again after `wake.fallback_seconds` (when nothing usable was named) or the backoff, whichever is later. After `max_completions_without_done` such runs in a row (runs that end without a line count too) the task is `held: no_done`, with one decision. The captured name must be one plain name: letters, digits, `.`, `_` and `-`, starting with a letter or digit, with no `..`. A capture with `/`, a leading `-` or `..`, or one whose file would be outside `wake.root`, is refused. The refusal is shown on the line, and the agent's text never chooses a path or goes into a decision's title.
- **Waiting too long.** The wait is budgeted per task, across restarts: `wake.max_wait_minutes` is counted from the end of the first run of the current streak of waiting runs. The streak is in the store, so it survives a restart of Lair; a release or a run you request starts it afresh. Past the budget the task is `held: waited_too_long`, with one decision ("<agent> is paused on <task>: it has waited on <wake> since <time>"): "Start it again now" or "Keep it paused" (recommended). Once held, the hold stays while its decision is open, even if the wake comes later, until you answer or release it ("Keep it paused" makes it your `paused` hold). A withdrawn decision holds nothing: the task is asked about again once its wait is over the budget again. A wake that is already there when fill checks ends the wait instead: a woken task starts again and is never newly held, however long its streak (only a task held before its wake came stays held). So a task doing real work through many gates in a row isn't held for the gates it got through.
- **A gate still in the queue is a live wait.** When the WAITING line names a gate id (a plain name) and the gate queue (`gates_dir/queue`, read with the gates parser) still has a request for it, `<lane>.<pri>.<id>.req` (queued) or `.req.run` (running), the agent is waiting on work in progress, not on nothing. A machine that is offline for hours, a long queue, or a request moved to another lane is not the agent's doing. Such a wait doesn't count toward `max_wait_minutes`: the line shows `waiting: <gate> still queued in <lane> since <time>` (or `still running`), and the status's `waiting.queued` gives the gate, lane, status and since. When the request is gone and no result came, the budget counts again, from the last time fill saw the request in the queue (that sighting is kept in the store, so a restart doesn't lose it), or from the streak's start when it never saw one. A wait that never had a request in the queue is held at `max_wait_minutes` exactly as before. A live wait is held anyway once the streak has waited `wake.max_queue_wait_minutes` (24 hours by default, never less than `max_wait_minutes`): a gate that sits in the queue that long usually means a runner or a machine is down. The decision then says so. An agent that can write to the gate queue can keep its own wait alive, but never past `max_queue_wait_minutes`.
- **Re-queued under a new id.** Some gate systems re-check or re-queue a gate under a new id and leave a marker naming it. Set `wake.requeue_marker` to that marker's path (`{wake}` is the id the waiting line names, `{n}` tries 1 to 9, and it must stay inside `wake.root`): the marker's first line, when it is a plain name, is the new id, and its markers are followed in turn (at most 10 ids). A wait whose new id is still in the queue is alive in the same way, and the new id's result (`wake.file` for it, newer than the run's chain) wakes the task as its own would. A marker that is a symlink, not a regular file, or whose first line isn't a plain name is passed over. Without `requeue_marker` only the waiting line's own id is looked up.
- **Blocked.** A run that ends on a line matching `blocked_pattern` holds the task at once (`held: blocked`), with no restart, and raises one decision carrying the BLOCKED line. The line is cut to 300 characters and shown as data in a code block. It never goes into a prompt: the next run gets fill's `prompt_files` prompt as always. Release the hold ("Release hold", or the decision's "Start it again") once whatever blocked it is cleared.
- **Ready guard.** With `fill.ready_guard: true`, a done line that names a PR counts only when, at the head it names (the PR's current head), every CI check passes (a skipped one is not a failure), the branch is not behind its base and does not conflict, the project's gate (`review.merge.gate`, when it requires one) passed at that head, and, when the PR carries review findings, its description has one line per finding with the finding's id and the sha of a commit of the PR. Otherwise the line is not a done: the task stays open, nothing goes to review, no `fill_done` is recorded. A refusal that needs a change (red CI, behind, conflicts, gate, finding map, a moved head) is recorded once as `fill_report_refused` (reason and instruction), and the next run's prompt ends with the instruction. A refusal that only time fixes (CI or the gate still running, the host not answering, mergeable not computed yet) holds the line (`held: report_refused`), starts no run, and is checked again on every fill check until it passes or turns into a refusal. Lines that name no PR are not checked. Off by default.
- **The latest line wins.** Of a run's WAITING and BLOCKED lines, the last one applies. With a `done_pattern` that names the task, a done line always does: a BLOCKED task whose done line is written later (by whoever unblocked it, say) is `done`. With one that names only the agent, the agent's last DONE, WAITING or BLOCKED line decides (see [Matching by agent](#matching-by-agent)). Once fill has seen how a run ended, it keeps that in the store (`fill_waiting`, `fill_blocked`, and for a wake file `fill_wake_absent`, `fill_woken` or `fill_weak`), so rotating the queue file or restarting Lair doesn't turn a waiting run into one without progress.

```yaml
agents:
  fill:
    # A WAITING line may name the gate it waits on (Lair's gate ids: <UTC>-<track>-<sha>-<n>)
    waiting_pattern: "^-\\s+WAITING\\s+{task}(?:\\s+(?<wake>\\d{8}T\\d{6}Z-\\S+))?(?=\\s|$)"
    wake:
      file: "{gates_dir}/results/{wake}.rc"   # the gate's result
      root: "{gates_dir}"                      # the default
      poll_seconds: 60
      max_wait_minutes: 240                    # time while the gate is still in the gate queue doesn't count
      max_queue_wait_minutes: 1440             # held anyway after this long, queued or not
      requeue_marker: "{gates_dir}/results/{wake}.recheck-{n}"   # optional: first line, the id it was re-queued as
      fallback_seconds: 900
```

#### Matching by agent

`done_pattern`, `waiting_pattern` and `blocked_pattern` contain `{task}`, `{agent}` or both; at least one is required, and both are inserted as literal text. Use `{agent}` when your agents' queue lines don't carry the `tasks_file` id. A line for `kiro/currency-enforcement` may say `- WAITING currency-enforcement <gate-id> by kiro-H (Viserion) 06:25Z: ...`, and one for `kiro/sf-storage` `- WAITING #183 sf-storage gate <gate-id> by kiro-D (Glaurung) ...`. What every line has is `by <agent>`.

An agent's line doesn't say which task it is about, so fill makes the answer unique. It looks only at the lines written between the task's run request and the agent's next run on another task. And while any pattern names only the agent, an agent has one open task at a time:

- the tasks file may list one line per agent; a second line for it is `malformed`;
- while its task has run and isn't done (it runs, waits, backs off or is held), a run of that agent on another task is refused: HTTP 409 for `POST /api/agents/runs` and for a fresh session (`POST /api/agents/runs/<id>/fresh-session`), in-process requests too, and an escalation answered "fresh_session" is refused the same way, with the reason recorded with the answer. Let the task finish, or take its line out of `tasks_file`, first.

A pattern without `{task}` counts no line from before a start, and a task Lair never ran isn't done by such a pattern. If the queue file was rewritten after the agent's next run on another task began, fill can't tell where that run's lines start, so it reads none of them for the earlier task (what it saw before is kept).

The rule covers only the runs Lair starts: an agent you start by hand (outside Lair) on another task while its fill task is open can still write lines that count for that task.

**Rotating the queue file.** After a rotation, an agent-only pattern finds nothing in the new file for a run that started before it. What fill had already seen (done, waiting, blocked) is kept in the store. A run fill hadn't classified yet counts as one that ended without a line, so the task is started again, never skipped.

**The agent's last line decides.** An agent reports where it is, not which task a line is about, so with an agent-only `done_pattern` the task is done only when the agent's last DONE, WAITING or BLOCKED line since the start is the DONE one. `- DONE L-08 row 1 by kiro-A` followed by `- WAITING <gate-id> by kiro-A` is waiting, so rows 2 and 3 still run; WAITING followed by DONE is done.

With `{agent}` the line must be that agent's own, by its attribution only: the first `by <id>` followed by `(`, a time, `:` or the end of the line. A kiro-style id found anywhere else in the line, which the queue view falls back to, doesn't count. `{agent}` must come right after a word `by` and `\s+` in the pattern (`\bby\s+{agent}`, a config error otherwise; not `by\s*`, not `-by`), so a line that only names the agent (`- DONE merged kiro-A's PR`) can't count. A line by another agent that names this one in its message (`... by kiro-H (Viserion) 07:10Z: reviewed by kiro-C`) is kiro-H's, so it never counts for kiro-C. A longer id is another agent: end `{agent}` with `(?=[\s(]|$)`, as below, so `kiro-A` doesn't match `kiro-AB`. One limit remains: a line whose text puts `by <other-agent> (` before its real author's attribution is read as that other agent's.

```yaml
agents:
  fill:
    # A fleet whose queue lines name the agent, not always the task id
    done_pattern: '^-\s+DONE\s+.*\bby\s+{agent}(?=[\s(]|$)'
    # The gate id is optional: a WAITING line without one still waits (and falls back)
    waiting_pattern: '^-\s+WAITING\s+(?:(?:.*?\s)?(?<wake>\d{8}T\d{6}Z-[A-Za-z0-9._-]+)\b)?.*\bby\s+{agent}(?=[\s(]|$)'
    blocked_pattern: '^-\s+BLOCKED\s+.*\bby\s+{agent}(?=[\s(]|$)'
    wake:
      file: "{gates_dir}/results/{wake}.rc"
```

### Agents API

`?project=` defaults to the default project.

- `GET /api/agents/status`: per agent its state (`idle`, `starting`, `working`, `waiting_on_lock`, `hung`, `stopping`, `never_started`, `failed_over`, `over_budget`, `failed`) with the detail (for a lock wait: the lock, its holder pid and whether it is alive), its current or latest run, its profiles, claims, budget and recent recoveries (transient failures and `transient_cleared` among them); the project's claims, locks (holder, how often broken) and budget; `unreachable`: the providers whose starts wait after transient errors, each with `since`, `failures`, `nextTryAt`, the last matching `line`, whether it is the `fleet`'s outage or only some `agents`', and how many runs are `waiting`; and `fill`: whether it is enabled and running, its last check (and error), how many of its runs are active, and each `tasks_file` line's state at that check (`started`, `done`, `held`, `claimed`, `not_allowlisted` or `malformed`, with the detail; a held line also has its `hold`, `releasable` for the owner's holds, and for a waiting one `waiting`: what it waits on, since when, when it falls back, why a wake was refused, and `queued` while its gate is still in the gate queue: the `gate` id, `requeuedFrom` for a re-queue under a new id, its `lane`, `status` (`queued` or `running`) and `since`)
- `GET /api/agents/runs?limit=100`, `GET /api/agents/recoveries?limit=100`: runs, and the recovery events (claim releases, lock breaks, never-started, hung, dead on start, crashes, restarts, fresh sessions, failovers, budget alerts, escalations, decisions) with their evidence
- `POST /api/agents/runs` `{agent, task, prompt, model?}`, with an owner session: claim the task and start it on the next check. 400 for a model the agent doesn't have, 409 when the task is claimed, the agent is busy, or (with fill's patterns matching by agent) the agent has an open fill task, 403 without an owner session, over budget or `read_only`
- `POST /api/agents/claims/release` `{task, confirm: true}`, with an owner session: the run holding it stops itself
- `POST /api/agents/runs/<id>/fresh-session` `{confirm: true}`, with an owner session: stop the run and start the task again in a fresh session (also for a run that ended, when it is the task's latest)
- `POST /api/agents/tick`, with an owner session: check now, and run a fill check after it when fill is on (the service checks on its own every `interval_seconds`, fill every `fill.interval_seconds`)
- `POST /api/agents/fill/release` `{task, confirm: true}`, with an owner session: lift fill's `owner`, `no_done`, `blocked`, `waiting`, `waited_too_long` or `paused` hold on a task, so fill starts it again on its next check (its open decision is then withdrawn). 409 when the task isn't held for you at fill's last check, or has a newer run than the one that hold was about; 404 when fill is off
- `GET /api/agents/prompts`, with an owner session: the files in the project's `prompts_dir`, newest first (at most 200), each as `{name, size, modifiedAt, tooLarge}`. Names only, never paths
- `GET /api/agents/prompts/file?name=<file name>`, with an owner session: one of them, `{name, size, text}`. The name is one file name (letters, digits, `.`, `_` and `-`, starting with a letter or digit, no `..`; HTTP 400 otherwise). Only a regular file directly in `prompts_dir`, or a symlink to one there, is read: a symlink to anything outside it, a directory or any other kind of file is refused (HTTP 403), and a file over 200000 bytes, the most a run's prompt may hold, is refused (HTTP 413)

Every POST here is the owner's (starting a run, releasing a claim, a fresh session, an early check, releasing a fill hold), and so are the two prompt-file reads, which read files from disk: they need a browser signed in as the owner (see "Only you answer" in [Decision Inbox](#decision-inbox)), from the dashboard. Any other caller, an agent included, gets HTTP 403, so no process on this machine can put a prompt into a task, stop another agent's run, or read a file through Lair. `/api/agents` gets no CORS. Modules that start runs (the scheduler, the planner) do it in-process through `AgentsManager.requestRun`, not over HTTP. The two actions that stop work, and releasing a fill hold, also need `confirm: true` (HTTP 400 without); the Work section asks before sending them.

**Starting a run from the Work section.** The "Start a run" form (shown unless the project is `read_only`) takes the agent, the task id, the model (the agent's own and its fallbacks' models; empty for its default) and the prompt, which you can type or load from a file in `prompts_dir` ("Load a prompt" lists the files there, including the prompts Lair wrote for earlier runs). Start asks for confirmation, then sends `POST /api/agents/runs`; a refusal shows the server's reason with its status: 400 for an invalid task, prompt or model, 403 when this browser is not signed in as the owner, the project is `read_only` or the budget is spent, 409 when the task is claimed or the agent is busy. Until this browser is signed in as the owner (from Decisions), the form is disabled and says so.

## Triage

> Off by default. With `enabled: true` and the default `mode: observe`, triage parses, classifies and records the gate results it gets, and runs none of your commands.

Triage ([design](design/autonomy.md#3-failure-triage-bisect-and-revert-module-triage)) answers "why did this gate fail, and what now?". It stores everything in `data/triage.db`.

**Where results come from.** Every local process can reach the server, including the agents whose work triage judges, so triage only believes results from a trusted source:

- **In-process (trusted):** the gate pipelines (`pipelines:`, [Gate pipelines](#gate-pipelines)) hand over each finished job's result as a `gate.completed` event, with its run id (which answers a re-check that started that run). Only in-process results may name the author agent, the PR and the base commit. The pipelines send neither the test reports nor the agent yet: their failures are read from the steps' console output and are not routed to an agent.
- **Signed (over HTTP):** `POST /api/triage/results` takes only a `SignedGateResult` from a node listed in `trusted_nodes` (its Ed25519 public key file), verified with the gates module's signature check. Test reports must be covered by the signature: the signed result lists each report's SHA-256 in `result.reports`. Only `recheckId` is read from the rest of the body: the base commit comes from `git merge-base`, the changed files from `git diff`, and no agent is routed to.
- An unsigned result, a tampered one, one from an untrusted node, or one signed for another project gets HTTP 403.
- **The branch is a label.** A result for `default_branch` counts as that branch's run only when its commit is in the branch's history (the local branch, or a remote's branch of exactly that name). Otherwise it is triaged as a change, with a note. A green run ends an incident only at a commit that contains the red one.

**Status: informational.** Nothing reads a failure's `blocking` yet: the merge policy will once it consumes triage (docs/design/autonomy.md §5). Until then triage records verdicts, asks for re-checks, opens tasks and decisions, and reverts per `bisect.revert`. What the merge gate can take from triage is the signed results themselves: with `review.merge.gate.from_triage: true`, every signed result triage accepts is handed to the project's review module, which verifies it again ([Merge policy](#merge-policy)).

1. **Causes.** JUnit XML reports (JUnit, Surefire, Gradle, pytest `--junitxml`, the vitest and jest JUnit reporters) and the console output of every failed step (Gradle, vitest, jest, pytest) are parsed into causes: the error, its `Caused by` chain, field errors, the failing tests and the project's source locations. A context or bootstrap failure (an application context that can't start, a setup error, a test file that can't load) is **one** cause, however many tests it failed: later tests that only say "failure threshold exceeded" join the first failure's cause, also from the reports of other test classes (Gradle writes one per class), so they take its class. A report's trace without a `Caused by` chain gets the one the step's console output shows for the same tests (or, for a context failure, the chain in its step's output). A failed step that no parser reads becomes one cause with its exit code and the error lines of its output. Output is written by the code under test, so the parsers read at most the last 20,000 lines of a log, each cut to 2,000 characters, with patterns that run in linear time, and the XML reader matches a closing tag against at most the 64 innermost open elements.
2. **Passes.** A test passed at a commit only when a report lists it as passed, or a gate run ran (and passed) the step it failed in. A lint-only run proves nothing about a unit test.
3. **Classes**, decided per cause, in this order, each with the lines and facts that decided it:

| Class | When | Action (`actions.*`) | Blocks a change |
|-------|------|----------------------|-----------------|
| `infra` | An infrastructure pattern or a root-cause signature (below) matches the error, its `Caused by` chain or its log lines (the root cause, not the top exception: a context failure whose chain ends in a Redis that did not answer is infra; while `recheck.mode` is not `off`, a timeout signature makes it a timeout under load, kind `load`); a step was killed (exit 137 or 143) or timed out with nothing more specific; or a timeout while the machine's load per core was at least `overload_per_core` | `recheck`: ONE re-check of only the failed test classes (or, without tests, only the failed steps) at the same commit, when there is capacity, up to `recheck.max_retries`. Never a full re-run. It unblocks the failure only when its answer lists every requested test as passed (or, for steps, every requested step passed); an answer that only says "passed" is `unproven`. After the last re-check: back to the author when the base commit's own run passes, otherwise a decision for the human | Until a re-check passes |
| `flaky` | Every failing test of the cause passed at the same commit within `flaky.window_minutes` (before or after), or, off the default branch, is quarantined | Recorded. Flaky `flaky.ticket_after` times in a row (default 2): one reliability task with a deadline (`ticket_deadline_days`, default 7), and the test is quarantined (it runs, it no longer blocks a change), up to `flaky.quarantine_cap`. The quarantine ends at that deadline, after `release_after_passes` passes in a row (default 5), or when the owner releases it. On the default branch a quarantined test that fails still counts, and opens an incident | No |
| `pre-existing` | The same tests (or the same cause) failed in the base commit's own gate run of the same pipeline, no older than `base_max_age_hours`; or the default branch has an open incident with them and the base commit includes its red commit. Without a base result, nothing is pre-existing | `fix_task`: one fix task on the default branch per cause, however many changes hit it | No |
| `code` | Anything else, with the changed files it is near (the same file, a test of a changed file, or the same directory). Low confidence when there is no base result to compare with | `route`: back to the author agent (from a trusted result) with the failing tests, the error, its root cause, source locations and the log lines | Yes |

4. **The default branch.** A red gate result on `default_branch` with `code` causes opens an incident for its pipeline (`pipelineId`). Triage takes that pipeline's last green run on the branch that ran the failing steps, lists the first-parent commits since then (`git rev-list --first-parent`), and bisects them, running only the failing tests at each probe (as re-checks, so capacity and `max_concurrent` apply, and an answer must show the target tests passing to count as a pass). A probe that fails on infrastructure is run again; one that can't decide is skipped. The culprit is **proven** when it is the only commit left, the one before it passed, and it failed with the same cause twice (a confirmation run). Then, per `bisect.revert`: `auto` opens a revert with `commands.open_revert`, `propose` (the default) asks through a decision, `off` records it. The culprit's author agent gets the cause either way. **A merge that is not proven is never reverted without the owner's explicit decision**, and a merge the owner protected (in the Gates section's Triage tab) or listed in `bisect.protected_merges` is never reverted automatically. A `Lair-Protected: yes` line in the merge message is only a hint (whoever merged it wrote it): it turns an automatic revert into a proposal. Only a green run of the same pipeline that ran the failing steps resolves the incident and cancels its probes.

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

The built-in infrastructure patterns (case-insensitive regular expressions, `default_infra_patterns: false` drops them): `connection-timeout` (connect timed out, `SocketTimeoutException`, `ETIMEDOUT`), `connection-refused` (`ECONNREFUSED`, `java.net.ConnectException`), `connection-reset`, `dns` (`EAI_AGAIN`, `ENOTFOUND`, could not resolve host), `download` (dependency downloads failing with 5xx or a read timeout), `container-start` (container startup failed, cannot connect to the Docker daemon), `out-of-memory` (`OutOfMemoryError`, heap out of memory, `ENOMEM`, `OOMKilled`), `runner-died` (runner lost, forked VM or test worker died, a shutdown signal) and `disk-full` (`ENOSPC`).

The built-in root-cause signatures (case-insensitive; each line is cut to 1,000 characters first): infra `connection-refused` (connection refused, `Connection to <host> refused`), `connection-reset`, `unable-to-connect` ("Unable to connect to"), `redis-connection` (`RedisConnectionException`), `jdbc-connection` ("Could not open JDBC Connection"), `docker-environment` (Testcontainers' "Could not find a valid Docker environment", `ContainerLaunchException`, "Cannot connect to the Docker daemon"), `disk-full` ("No space left on device") and `out-of-memory` (`OutOfMemoryError: GC overhead limit exceeded` or `Java heap space`); timeout `connection-init-timeout` ("Connection initialization timed out") and `timeout-exception` (`TimeoutException ... timed out after`). Infra signatures are tried before timeout ones.

**Timeout signatures count only while `recheck.mode` is not `off`**: a timeout is infra (`load`) only when a quiet re-check can tell load from a hang; with re-checks off, a timed-out test stays `code` and goes to its author. `infra_signatures` and `timeout_signatures` add your own (regular expressions, tried first); `default_infra_patterns: false` drops the built-in signatures too. **An assertion's failure** (`AssertionError`, `AssertionFailedError`, "expected ... but was") is the test's own verdict: no pattern or signature makes it infra, whatever its message quotes; a compile error matches none of them and stays `code`. Context patterns (`context_patterns`, `default_context_patterns`) decide what counts as a context failure.

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
| `default_infra_patterns` | boolean | `true` | Use the built-in infrastructure patterns and root-cause signatures too |
| `infra_signatures`, `timeout_signatures` | array | `[]` | Root-cause signatures (regular expressions, at most 100, each at most 500 characters), tried before the built-in ones |
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
| `recheck.mode` | `off` \| `observe` \| `act` | `off` | Re-checks in your own gate system ([below](#re-checks-for-an-existing-gate-system)): `observe` records each one it would ask for, with its argv; `act` runs `recheck.command`. It decides for that command alone, whatever `mode` says; a `read_only` project never runs it |
| `recheck.command` | array | — | Enqueues a re-check in your gate system and returns. Required when `recheck.mode` is not `off` |
| `recheck.max_per_result` | number | `2` | Re-checks per original result, re-checks of its re-checks included |
| `recheck.cooldown_seconds` | number | `120` | No re-check sooner than this after the failure arrived |
| `recheck.timeout_seconds` | number | `60` | `recheck.command` is stopped after this |
| `recheck.expire_hours` | number | `3` | A queued re-check with no result by then expires: reported, not retried |
| `recheck.kinds.infra`, `.timeout`, `.flaky` | `same` \| `failed_tests` \| `none` | `same`, `failed_tests`, `failed_tests` | Which re-check each kind of failure gets |
| `recheck.max_tests` | number | `8` | `failed_tests` names at most this many tests |
| `recheck.max_pending` | number | `3` | Project-wide: at most this many re-checks running or queued in your gate system at once; more wait their turn |
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
  "recheckId": "<only when answering a re-check: its id, or, for a re-check in your gate system, the failed result's id>"
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

`review.merge.gate.source: signed` verifies the same kind of signed result. This command sends to triage only, and with `review.merge.gate.from_triage: true` the results triage accepts reach the merge gate too ([Gates from an external queue through triage](#gates-from-an-external-queue-through-triage)); without it, the gate takes only results posted to `POST /api/review/gate-results`. The gate also checks the `pipelineVersion` against `merge.gate.pipeline_versions` (`--pipeline-version`), and it does not take a passed result with a skipped step or a passed step that took under 10 ms.

### Re-checks for an existing gate system

> Off by default (`recheck.mode: off`). Start with `observe`: triage records each re-check it would ask for, with the exact argv, and runs nothing.

When your gates run in your own system, a gate that failed because of the environment (the container runtime was down, the run was killed, a remote machine dropped) or because the machine was overloaded (tests that time out under load) usually goes back to whoever submitted it, who then submits the whole gate again. With `recheck.mode: act`, triage asks your gate system to re-check it instead, through `recheck.command`, and links the re-check's result back to the failure.

**Which re-check.** Triage decides from the classification it already makes, per cause:

| Kind | When | `recheck.kinds` default |
|------|------|-------------------------|
| `infra` | The cause is `infra` (an infrastructure pattern, a killed step, a step timeout) | `same`: the same pipeline again, at the same commit |
| `timeout` | The cause is `infra` by a timeout signature (`TimeoutException ... timed out after`, "Connection initialization timed out") or by the `timeout-under-load` rule (only an in-process result carries the machine's load); or it is `code` but a test failed with a timeout no signature names (`TestTimedOutException`, `ConditionTimeoutException`, "test timed out", "Exceeded timeout of"): such a `code` timeout is re-checked before it goes back to its author | `failed_tests`: only the failed tests, on a quiet machine |
| `flaky` | The cause is `flaky` | `failed_tests` |

Any other `code` cause is a **real failure: never re-checked**, and neither is a result that has one beside its other causes. `pre-existing` causes are left out. A kind set to `none` is not re-checked. `{tests}` lists the failed tests' ids from the JUnit reports (pytest node ids, else `<class>#<test>`, without a JUnit method's trailing `()`), only when each one uses safe characters (letters, digits and `. _ $ # : / -`) and there are at most `max_tests`; otherwise an `infra` failure falls back to `same`, and anything else is not re-checked. With `recheck.mode` on, an `infra` failure gets this re-check in place of the one Lair runs itself (`actions.infra`, `commands.recheck`); bisect probes still use `commands.recheck`.

**The command** is an argv (no shell) that only enqueues the re-check and returns: it is stopped after `timeout_seconds`. Its placeholders: `{sha}` (full), `{pipeline}` (the result's `pipelineId`), `{branch}`, `{result_id}` (the failed result's id), `{reason}` (`<kind>:<rule>` items, comma-separated, such as `timeout:test-timeout`), `{kind}` (`same` or `failed_tests`), `{tests}` (a list: as a whole argument, one argument per test; inside a longer one, joined with `,`) and `{project}`. Every value is checked before the command runs (a full sha, a branch name, an id or a pipeline of letters, digits and `. _ : / -`, nothing that starts with `-`); a value that fails the check refuses that re-check, and the Triage view says which placeholder. Print the re-check's own result id on the first line of stdout: then only a result with that id answers it. Exit 0 means queued; any other exit, or a timeout, is reported and **never retried**.

**The re-check's result** comes back as any result does (`lair-node gate-result submit`), with `--recheck <the failed result's id>` (`recheckId` in the body):

- **It passes:** the failure is resolved, as infrastructure, or as flaky for a test that timed out (or was flaky) and passed. Those tests join the flaky-test list (`GET /api/triage/flaky`, the Triage view), with its reliability tasks and quarantine. A `failed_tests` re-check counts as passed only when its JUnit reports list every re-checked test as passed, and a `same` one when none of the failed steps failed or was skipped again; a bare "passed" is `unproven` and resolves nothing.
- **It fails the same way** (the same cause, or one of a timeout's tests failing again but not on infrastructure): the failure is escalated as real, once, through one decision (the Decision Inbox, else `commands.raise_decision` or `decision_file`): fix the environment or treat it as real, re-check once more (while `max_per_result` allows), or ignore. A timeout that comes back on a quiet machine is not load: its causes become `code` (rule `failed-on-recheck`) and go back to the author (`actions.code: route`), once; infrastructure stays `infra`. The same **network** failure twice at one commit (connection refused, unable to connect: a host, a port or a setting the change may have moved) is as likely the change as the machine: the decision recommends treating it as real, and the failure goes to its author too; a container runtime or a disk that fails twice is the environment's (fix the environment is recommended).
- **It fails differently:** it is a new failure, triaged on its own; it can be re-checked too, from the same `max_per_result` budget.
- **It can't answer** (that re-check was answered already, or never queued, or the result is another run than the one the command printed, or another commit; an expired re-check still takes a late answer): the signed result is kept as a plain gate result, with a note saying why, and it is not re-checked itself.

**Budget and safety.** At most `max_per_result` re-checks for one original result (re-checks of its re-checks count). None sooner than `cooldown_seconds` after the failure arrived, and none while another for the same commit and pipeline is pending. Project-wide, at most `max_pending` (default 3) re-checks are running or queued in the gate system at once; the next ones wait their turn, oldest first. A queued re-check with no result after `expire_hours` expires: it is reported on the failure, never retried. In act mode, a test timeout goes back to its author (`actions.code: route`) only when its re-check fails the same way, is unproven, expires or can't be queued. Re-checks are stored rows: after a restart, a waiting one runs when its cool-down ends, and one whose command was running when the server stopped is kept as queued (the command may have queued it) until its result or its expiry, and is never run again. Events: `triage.recheck_would`, `triage.recheck_queued`, `triage.recheck_resolved` (with `outcome`: `passed`, `unproven`, `failed_differently`, `expired` or `not_queued`) and `triage.recheck_escalated`.

```yaml
triage:
  enabled: true
  mode: observe                # triage itself still only observes
  trusted_nodes:
    - id: ci-gates
      public_key_file: ./data/keys/ci-gates.pub
  recheck:
    mode: observe              # off | observe | act
    command: ["./ci/bin/enqueue-recheck", "{sha}", "{pipeline}", "{kind}", "{result_id}", "{reason}", "{tests}"]
    max_per_result: 2
    cooldown_seconds: 120
    timeout_seconds: 60
    expire_hours: 3
    kinds:
      infra: same              # the same pipeline at the same commit
      timeout: failed_tests    # only the failed tests, on a quiet machine
      flaky: failed_tests
    max_tests: 8
    max_pending: 3             # project-wide, running or queued in the gate system
```

The script re-validates what it gets (it is your gate system's front door), enqueues the run, prints its result id and exits 0. For example: for `same`, the failed gate's own command again; for `failed_tests`, the test runner with only those tests, on the least loaded machine. It should make the new run's command differ from the failed one if your queue shares identical runs' results, and keep the original submitter from submitting the whole gate again while the re-check is pending. Its runner then submits the result with `--recheck <result_id>`.

### Triage API

`?project=` defaults to the default project:

- `POST /api/triage/results`: a signed gate result, as above (up to 32 MB)
- `GET /api/triage/status`: mode, why commands don't run, config errors, counts per class, pending re-checks, open tasks, quarantined tests, the newest open incident and how many are open, which commands are set, and the trusted nodes
- `GET /api/triage/failures?verdict=&blocking=true|false&sha=&limit=100`, `GET /api/triage/failures/<id>`: each cause's verdict and evidence, the actions taken (with their argv and who acted) and the re-checks
- `GET /api/triage/rechecks?limit=100`
- `GET /api/triage/gate-rechecks?limit=100`: the re-checks in your gate system, newest first, with their state (`would`, `waiting`, `running`, `queued`, `not_queued`, `refused`, `passed`, `unproven`, `failed_again`, `failed_differently`, `expired`), argv, the result id the command printed and the tests that passed; `GET /api/triage/failures/<id>` lists a failure's as `gateRechecks`
- `GET /api/triage/incidents?status=open|resolved|all&limit=50`, `GET /api/triage/incidents/<id>`: the bisect's candidates, probes, culprit and revert status
- `GET /api/triage/tasks?status=open|resolved|all`, `GET /api/triage/flaky`, `GET /api/triage/protected`

The owner only (the owner's session from [the owner credential](#decision-inbox), from the dashboard; no CORS; HTTP 403 otherwise; each records who acted):

- `POST /api/triage/owner/incidents/<id>/revert` with `{"sha": "...", "acknowledgeUnproven": true}` (both optional): open the revert of the culprit, or of a suspect, which needs `acknowledgeUnproven`
- `POST /api/triage/owner/protected` with `{"sha": "<full sha>", "note": "..."}`, `DELETE /api/triage/owner/protected/<sha>`
- `DELETE /api/triage/owner/flaky/<test key>`: release a quarantined test

## Placement

> Off by default. With `enabled: true` and the default `mode: observe`, placement probes your machines, estimates when every queued job finishes, and shows where it would move each one. It runs none of your commands except the probes and, for an [on-demand machine](#on-demand-machines), its `state_cmd` and `guard_cmd` checks.

Placement is for projects that keep their own gate queue and runners: the request files under `gates_dir/queue/` that the Gates section reads, one lane per runner. It decides which machine runs each queued job, for any number of machines, and moves a job to another lane when it is expected to finish sooner there. Lair never renames a request itself. In act mode it runs your `move_cmd`, which validates and moves the request, and then checks that the request landed.

A two-machine example: a workstation with a `heavy` lane and a second runner of that lane (`quick`), and a laptop reachable over SSH with a `remote` lane that has two runners and takes one full suite at a time:

```yaml
placement:
  enabled: true
  mode: observe                  # observe (default) | act
  machines:
    workstation:
      probe: ["true"]
      load_cmd: ["sysctl", "-n", "vm.loadavg", "hw.ncpu"]      # Linux: ["sh", "-c", "cat /proc/loadavg; nproc"]
      min_up_seconds: 0
    laptop:
      probe: ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "builder@laptop.example", "echo", "ok"]
      expect: "ok"
      load_cmd: ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "builder@laptop.example", "cat /proc/loadavg; nproc"]
      min_up_seconds: 240
  lanes:
    heavy: { machine: workstation, slots: 1 }
    quick: { machine: workstation, slots: 1, serves: [heavy], max_priority: 3 }
    remote: { machine: laptop, slots: 2, limits: { big: 1 } }
  classes:                       # the first class whose pattern matches, in this order
    quick: ['/^TESTS=\S+ \./run-tests\.sh \{WT\}$/']
    small: ["*run-tests.sh*"]
    big: ["*run-suite.sh*"]
  eligible:
    heavy: [quick, small, big]
    quick: [quick]
    remote: [quick, small, big]
  prefer_quiet: ["*RECHECK=timeouts*"]
  move_cmd: ["./scripts/gate-move.sh", "{id}", "{from}", "{to}"]
  command_line: 3                # the request file's command starts on its third line
  history:
    runner_log: runner.log       # gates_dir/runner.log
    columns: [time, id, rc, command, lane]
```

### How placement decides

Every `interval_seconds`:

1. **Machines.** Every machine's `probe` (and `load_cmd`) runs, all machines in parallel, as argv with no shell, each with `probe_timeout_seconds`. A probe passes when it exits 0 and, with `expect`, its output starts with that text. A probe cut short by a stop or a reload says nothing about the machine: its state stays as it was. A machine is **up** only once its probes have passed for `min_up_seconds` in a row, so a flapping link does not bounce jobs: one failed probe makes it **down**, and the count starts again. A machine that is not up gets nothing new, and nothing is moved away from it either: jobs already in its lanes stay with your project's own fallback (for example a runner that sends its jobs elsewhere after a while unreachable). The Machines section shows each machine's state, since when, and its last error. Probe history is kept in memory, so after a restart a machine is up again only after `min_up_seconds`.
2. **The queue.** Only the configured lanes are read. A request with no status suffix (`<lane>.<pri>.<id>.req`) is queued and may be moved; `.req.run` is running and is **never** moved; any other suffix (`.stuck`, `.superseded`, ...) is ignored. A request's command is its file from line `command_line` on, and its class is the first class (in the order written) with a pattern that matches the command. A pattern is a glob (`*` is any text, `?` one character, everything else literal; it matches the whole command) or a regular expression written `/.../` (flags `i`, `m`, `s`, `u`). A job with no class is estimated but never moved. A request (or a result) that is a symbolic link is ignored: placement never reads through a link.
3. **Learning.** Durations are learned per class and machine. Lair records every run it sees start (its request renamed to `.run`; its start is the rename time when Lair saw it queued just before, or the file's change time) and end (`results/<id>.rc` appears; the `.rc` file's time is the end). The run's seconds are the last `history.duration_pattern` match in the tail of `results/<id>.log` (by default `time=<N>s`), else the time Lair saw it run. A result whose log says it ran much longer than Lair saw it run is from an earlier run (a result shared between identical requests), and is not learned. With `history.runner_log`, finished runs that Lair did not see are learned too: each tab-separated line whose `rc` column is a number gives the run's id, command and lane, in the order `history.columns` names them (use `ignore` for a column to skip), and its seconds come from its result log. The result files hold an id's latest run only, so a line is learned only when the result agrees with it (the same exit code, written within ten minutes of the line).

   One sample is kept per gate id, with its exit code. A run that failed (exit code not 0) in less than half the time its class usually takes (the median of passed runs on that machine, else on any machine) is a fragment, such as a preflight that failed or a run killed when its machine went away, and is not learned. A later passed run of the same id (a job re-queued under its id) replaces a failed one, never the other way round. A job's expected duration is the median of the newest `history.samples` passed runs of its class on that machine, else on any machine; else of all its runs on that machine, else on any machine; else of any class on that machine; else `default_seconds`.
4. **Load.** `load_cmd` prints the 1-minute load average first and the cpu count last (`sysctl -n vm.loadavg hw.ncpu` and `cat /proc/loadavg; nproc` both do; `cpus:` overrides the count). A machine's load factor is `max(1, load ÷ cpus)`. A machine runs jobs slower when its load factor is above the one it usually has while running gates: the expected duration is multiplied by `max(1, factor now ÷ usual factor)`, where the usual factor is the median of the factors Lair measured during the runs it learned from (1 until it has some). Without `load_cmd` the factor is 1.
5. **Estimates.** Each lane runs its jobs in its own order (lower priority digit first, then the id, which usually starts with a UTC time) on `slots` runners, with at most `limits.<class>` jobs of a class at a time, and no job starts before the one ahead of it (a runner takes the head of its queue). A running job ends its expected duration after it started, but always has at least a tenth of that left (so one past its duration is expected to need a tenth of it more). A job its lane never runs (a class limit of `0` there) has no expected finish on it. A **pseudo-lane** (`serves:`) is a second runner that takes jobs from other lanes' queues: a queued job of a lane it serves, at or below its `max_priority`, whose class is in `eligible.<pseudo-lane>`, is estimated on the pseudo-lane and is **never moved** (its runner takes it beside the main one). The Gates section shows every queued job's expected start and finish.
6. **Moves.** A queued job moves to another lane when it is expected to finish at least `min_gain_seconds` sooner there, and the move saves at least that much in all: what it costs the jobs of the same or a more urgent priority on both lanes is counted against it. The target lane must be up (or be on an available [on-demand machine](#on-demand-machines), through `routing` only), list the job's class in `eligible`, and not be a pseudo-lane. The job that gains most moves first, then the next one on the state that leaves, up to `max_moves_per_tick`; of two moves that are equally good, the one to the lane with the lower `cost_per_hour` wins. A job its lane never runs goes, before any of those, to the lane that can run it soonest (its gain shows as 0 and its estimate as `never → ...`); this holds for a quiet re-check too, whatever the loads.

   **Cool-downs.** A job moved (or tried) is not moved again for `cooldown_seconds`, whatever the estimates say, and the cool-down doubles with every earlier move of that job in the last 24 hours (30 min, then 60, then 120 by default). After `max_moves_per_job` moves or tries in 24 hours the job is **held**: placement stops moving it, says why in the Gates section, and emits `placement.job_held` once for that hold (the store remembers it, so a restart doesn't report it again; a job held again after it left the queue is reported again). So a job a flapping link keeps sending back (your fallback moves it home, placement moves it out again) settles instead of bouncing forever.
7. **Quiet re-checks.** A job whose id or command matches a `prefer_quiet` pattern (for example a re-check of tests that failed by timeout) goes to the eligible up machine with the lowest load per cpu, when that is at least `quiet_margin` lower than its current machine's, even if it finishes later there: `min_gain_seconds` and the in-all rule don't apply to that move. When no machine is that much quieter, it is placed by time like any other job, but only on machines no busier than its own (a machine whose load is unknown counts as busier). When no target's load is known at all, it is placed by time on any eligible machine.

Each decision is explained in one line, for example `moved 20260101T000000Z-fix-a1b2c3d4-1 heavy→remote: est. 52 min → 18 min; remote idle, workstation load 3.1×`.

**Act mode.** With `mode: act` (and a project that is not `read_only`), each move runs `move_cmd` with `command_timeout_seconds`. Right before it runs, Lair checks that the request is still queued where it was (a runner may have claimed it meanwhile); afterwards, that `move_cmd` exited 0, the request is gone from its lane and is in the target lane (queued or already running). Anything else is a failed move: it is recorded with the command's output, emits `placement.move_failed`, no further move runs in that tick, and the job waits its cool-down before it is tried again. A move cut short by a server stop is found again on the next start: Lair looks where the request is and records it as moved, interrupted or gone (an interrupted one also waits its cool-down). Act mode is switched in the config only (a [live reload](#live-config-reload) applies it); there is no route for it.

**Your `move_cmd`** is the one place a request is renamed, so it must check everything itself: the lanes, that the request exists with no status suffix, its command, that the target machine answers, and then rename it atomically (one `mv` within the queue directory). Placeholders: `{id}`, `{from}`, `{to}`, `{file}` (the request's path), `{priority}`, `{project}`. A value that would start an argument with `-` is refused.

**Turn your own balancer off first.** If your project already moves queued jobs between lanes with a script of its own (a rebalancer that sends work to a machine when it comes back, say), turn that script off before you set `mode: act`, in the same change. Placement's cool-downs count only its own moves, so two movers with different rules pass the same job back and forth. Your runners' own fallbacks for an unreachable machine can stay: placement leaves the jobs on a down machine to them, and the per-job cap above stops a job they keep sending back.

**Trust.** The queue, the result logs and the runner log are files any local process can write, so estimates are only as good as those files. That is why the mover validates every move on its own.

### Placement options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Run placement for this project |
| `mode` | `observe` \| `act` | `observe` | `observe` records and shows advice (`would_move`); `act` runs `move_cmd` and an on-demand machine's `touch_cmd`, unless the project is `read_only: true` |
| `interval_seconds` | number | `60` | Seconds between ticks (10 to 3600) |
| `probe_timeout_seconds` | number | `15` | Timeout of each probe and load command |
| `command_timeout_seconds` | number | `60` | Timeout of `move_cmd` and of an on-demand machine's `state_cmd`, `guard_cmd` and `touch_cmd` |
| `machines` | map | `{}` | Machine id → machine options (below) |
| `lanes` | map | `{}` | Lane name (as in the request file names) → lane options (below). At least one when enabled. Lanes not listed are never read or moved |
| `routing` | map | `{}` | Lane name → routing options (below): where its jobs may go on an on-demand machine |
| `classes` | map | `{}` | Class name → patterns matched against a request's command. The first class, in the order written, wins |
| `eligible` | map | `{}` | Lane → the classes it can run. A job moves only to a lane that lists its class |
| `prefer_quiet` | array | `[]` | Patterns matched against a job's id and command: such a job goes to the least-loaded machine |
| `quiet_margin` | number | `0.25` | How much lower (load per cpu) the quieter machine must be |
| `move_cmd` | array | — | Your mover, as argv. Required for `mode: act` |
| `max_moves_per_tick` | number | `2` | At most this many moves (or advice lines) per tick |
| `min_gain_seconds` | number | `600` | A move must make the job finish at least this much sooner |
| `cooldown_seconds` | number | `1800` | A job moved or tried is not moved again for this long, doubled for every earlier move of it in 24 hours |
| `max_moves_per_job` | number | `3` | A job moved or tried this many times in 24 hours is held where it is (`placement.job_held`) |
| `default_seconds` | number | `1800` | The expected duration before anything is learned |
| `command_line` | number | `1` | The request file's line where its command starts |
| `history.runner_log` | string | — | A tab-separated runner log, relative to `gates_dir` unless absolute; its tail (1 MB, 2000 lines) is read |
| `history.columns` | array | `[time, id, rc, command, lane]` | The runner log's columns (`time`, `id`, `rc`, `command`, `lane`, `ignore`), in order |
| `history.duration_pattern` | string | `\btime=(\d+)s\b` | Regular expression for a run's seconds in its result log; the first group is the seconds |
| `history.samples` | number | `20` | Recent runs per class and machine in the median |

Machine options:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `probe` | array | — | Argv that exits 0 when the machine answers |
| `expect` | string | — | The probe's output must start with this (leading whitespace ignored). For an SSH host whose shell is Windows `cmd`, probe with `echo ok` |
| `load_cmd` | array | — | Argv that prints the 1-minute load first and the cpu count last. Over SSH, the remote command is one string the remote shell parses |
| `cpus` | number | — | The cpu count, instead of the one `load_cmd` prints |
| `min_up_seconds` | number | `240` | Passing probes needed in a row before the machine counts as up (`0` for the machine Lair runs on) |
| `on_demand` | object | — | On-demand machine settings (see below) |

On-demand machine options (the `on_demand` block; see [On-demand machines](#on-demand-machines)):

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `state_cmd` | array | — | Argv that prints the machine's power state: `running`, `stopped`, `pending`, or `stopping` |
| `guard_cmd` | array | — | Argv that exits 0 with output starting `guard: ok` when starting the machine is allowed |
| `boot_seconds` | number | `150` | Seconds added to estimates while the machine is not up |
| `cost_per_hour` | number | — | Shown in the status; of two moves that are equally good, the one to the cheaper lane wins |
| `check_seconds` | number | `300` | Minimum seconds between state and guard checks (the guard may call paid APIs) |
| `speed_factor` | number | `1.0` | While the machine has no run of a class yet, its expected duration is this times what the class takes on the other machines (`0.5`: twice as fast) |
| `touch_cmd` | array | — | Argv that refreshes the machine's activity mark (or lease), run while a job runs in one of its lanes, in act mode only |
| `touch_seconds` | number | `60` | How often `touch_cmd` runs while a job runs there. A touch runs at most once per tick, so this may not be shorter than `interval_seconds` |

Lane options:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `machine` | string | — | The machine id whose runners serve this lane |
| `slots` | number | `1` | Runners of the lane: jobs it runs at once |
| `limits` | map | `{}` | Class → at most this many running at once in the lane (`0`: the lane never runs that class, so placement moves such a job to a lane that does) |
| `serves` | array | `[]` | A pseudo-lane: the lanes whose queues its runner takes jobs from |
| `max_priority` | number | — | A pseudo-lane takes only jobs at this priority digit or lower |

Routing options (the `routing` block, per lane):

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `overflow_to` | array | `[]` | On-demand lanes this lane's waiting jobs may go to while their machine is stopped |
| `prefer_when_faster` | boolean | `false` | A job of this lane also goes to an on-demand lane (listed or not) when it would finish sooner there, boot time included, even if it would start now where it is |
| `min_gain_seconds` | number | — | How much sooner a job must finish to start an on-demand machine for it (defaults to the global `min_gain_seconds`) |

Unknown keys, a lane on an unknown machine, an unknown class in `limits` or `eligible`, an invalid pattern, an unknown placeholder in `move_cmd`, `mode: act` without `move_cmd`, a `routing` or `overflow_to` lane that is not in `lanes`, or a `touch_seconds` shorter than `interval_seconds` are config errors: the project's placement does not start, and `GET /api/placement/status` shows the errors.

### On-demand machines

A machine with an `on_demand` block is one your project starts when a job lands in its lane (a cloud machine that powers itself off when idle, say). Placement never starts or stops it: it moves a job into its lane, and your project's runner starts it. Lair reads the machine's power state with `state_cmd` and asks `guard_cmd` (your spend and quota check) whether a start is allowed, at most every `check_seconds` (both may call paid APIs).

- **Available.** A machine whose state is `stopped` and whose guard says ok is **available**: its lanes are planned as if it were up, with `boot_seconds` added to every estimate there (once). Running, it counts like any machine, through its probes and `min_up_seconds`. A refusing guard, an unknown state, or a command that fails or times out makes it **unavailable**, with the reason shown; so do `pending` and `stopping`.
- **Starting it.** A lane on an available machine is a target only through `routing`: a lane's `overflow_to` lists it, or the lane has `prefer_when_faster`. A move there needs a free slot and a gain above 0 of at least the routing's `min_gain_seconds`, in all too; with `overflow_to` alone the job must also be waiting (it would not start now where it is). These moves go before moves by time. In act mode, right before such a move the guard runs again (unless it ran in this tick): a refusal cancels the move (`placement.move_failed`, the job waits its cool-down) and the machine stays unavailable until its next check.
- **Moving back.** A job queued in its lane while the guard refuses or the state is unknown goes back, before any other move, to a lane whose `overflow_to` lists that lane (else to any up lane that runs its class): `moved back q1 aws→heavy: est. never → 60 min; aws guard refused: spend 181 >= limit 180; heavy idle`. Its cool-down and `max_moves_per_job` still apply, so a job moved in and refused straight after waits out the cool-down of that move (30 min by default) before it goes back, and one that reached `max_moves_per_job` is held where it is. A machine that is `pending` or `stopping` keeps its jobs.
- **Keeping it alive.** While a job runs in one of its lanes, `touch_cmd` runs every `touch_seconds`, so the machine's idle timer does not stop it during a long phase of the job that does not use it. A touch keeps a paid machine on, so it runs in act mode only: in observe mode or on a `read_only` project it never runs, and the status shows why (`touchError: not touched: placement.mode is observe`). A check that finds the machine `stopped` (or `stopping`) after it had answered, while jobs run in its lanes, emits `placement.machine_stopped_under_job` once per job; when the runner puts such a job back in that lane while the machine is not up, it moves back once (`aws stopped under it`). The state is checked at most every `check_seconds`, so the notice can come up to `check_seconds` (5 min by default) after the machine stopped, not within a minute; a job its runner already put back in the queue by then gets no notice and is planned like any job queued for that machine.
- **Shown.** The Machines section shows the on-demand state next to the probe state: `on demand: stopped, guard ok, 150 s boot`, `on demand: starting`, `on demand: running`, `on demand: refused (guard refused: ...)`. The status (`onDemand`) has the power state, availability and reason, the last check and the last touch with its error. A move explains itself: `moved q1 heavy→aws: est. 2 h 0 min → 63 min; aws stopped, guard ok, 150 s boot; overflow: heavy had 1 waiting; aws idle`.

```yaml
placement:
  machines:
    workstation:
      probe: ["true"]
      min_up_seconds: 0
    aws:
      probe: ["ssh", "aws-gate", "echo", "ok"]
      expect: "ok"
      on_demand:
        state_cmd: ["/path/to/aws-gate.sh", "state"]   # prints running|stopped|pending|stopping
        guard_cmd: ["/path/to/aws-gate.sh", "guard"]   # exit 0 + "guard: ok" = start allowed
        touch_cmd: ["/path/to/aws-gate.sh", "touch"]   # refreshes the machine's idle timer
        boot_seconds: 150
        cost_per_hour: 0.35
        check_seconds: 300
  lanes:
    heavy: { machine: workstation, slots: 1 }
    aws: { machine: aws, slots: 2, limits: { big: 1 } }
  routing:
    heavy:
      overflow_to: [aws]
      prefer_when_faster: true
      min_gain_seconds: 300
  eligible:
    heavy: [small, big]
    aws: [small, big]
```

With this configuration a job waiting in `heavy` goes to `aws` when it would finish at least 5 minutes sooner there, the 150-second boot included (with `prefer_when_faster`, so does one that would start now on `heavy` but finishes 5 minutes sooner on `aws`). While the guard refuses, nothing goes to `aws` and what is queued there comes back to `heavy`.

### Placement API

`GET /api/placement/status?project=` (read-only): the mode and why act mode is off, config errors, the last tick, every machine's probe state (up, starting, down; since when; load and cpus) and, for an on-demand machine, its power state, availability and reason, last check and last touch, every lane's slots in use and per-class limits, every job's class, expected start and finish, advice and why it stays where it is, the latest moves (moved, failed, interrupted, gone, would_move, each with its argv and explanation), and the learned durations.

Events on the bus: `placement.moved`, `placement.would_move`, `placement.move_failed`, `placement.machine_up`, `placement.machine_down`, `placement.job_held`, `placement.machine_stopped_under_job` (`{project, machine, gateId, lane, state}`).

## Cloud machines

> Off by default. With `enabled: true`, Lair describes each cloud machine's instance through its provider, meters what it costs, reads the account's cost, and keeps a money guard that every start goes through. It does not start or stop a machine by itself yet: starting on demand and stopping when idle come next ([cloud runners](design/cloud-runners.md) §11 step 2), through this guard.

```yaml
cloud:
  enabled: true
  check_seconds: 300
  machines:
    cloud-1:
      provider: aws-ec2
      region: us-east-1
      profile: lair-gates            # a named profile in your AWS config files; never keys here
      instance:
        id: i-0123456789abcdef0
        tag: { key: role, value: gate-server }
      price_per_hour: 0.35           # rounded up: the meter counts every run at this price
      storage_per_month: 6
  budget:
    limit: 100                       # US dollars; give the provider's own budget the same limit
    period: { start: 2027-01-01, end: 2027-12-31 }
    meter_start: 1
```

### Cloud options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Watch this project's cloud machines and run the guard. On, it needs at least one machine and a `budget` |
| `check_seconds` | number | `300` | Seconds between checks (60 to 3600): each machine is described, and the guard runs |
| `request_timeout_seconds` | number | `30` | Every provider call is cut off after this (5 to 120) |
| `machines` | map | `{}` | Machine id → machine options (below). An id that is also a machine under `machines:` or `placement.machines` is shown as one machine |
| `budget` | object | — | The money guard's limit (below) |

Machine options:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `provider` | `aws-ec2` | — | The provider (AWS EC2 for now) |
| `region` | string | — | The instance's region, such as `us-east-1` |
| `profile` | string | — | A named profile in your AWS config files: the only source of credentials (see below) |
| `instance.id` | string | — | The EC2 instance id |
| `instance.tag` | `{key, value}` | — | A tag the instance must carry. Lair describes, starts and stops only an instance with this id and this tag: one without it is "not found" |
| `price_per_hour` | number | — | The hourly price, rounded up. The meter counts each run at the higher of the price when Lair recorded it and the current one |
| `storage_per_month` | number | `0` | The machine's disk per month, counted for every month of the period begun so far |

Budget options:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `limit` | number | — | No start at or above this spend, in US dollars |
| `period.start`, `period.end` | `YYYY-MM-DD` | — | The days the limit covers, both included (UTC). Outside them no start happens. For promotional credits, cover the credits' validity |
| `meter_start` | number | `0` | Spend before the meter's first run |
| `spend_check_hours` | number | `6` | How old the provider's cost reading may get before it is read again (1 to 24): each reading may cost money, and provider data lags anyway. A start never rests on a reading older than a day |
| `warn_percent` | number | `80` | From this share of the limit on, the guard says `warning` (a start is still allowed) |

### Credentials

Credentials never go in the project's YAML. A machine names a `profile`, and Lair reads that profile alone from the AWS shared config and credentials files (`~/.aws/config` and `~/.aws/credentials`, or the files `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` name), SSO, role and `credential_process` profiles included. Keys in the server's environment or an instance role are not used in its place. A key named like a credential anywhere under `cloud:` (`access_key`, `secret`, `session_token`, `password`, `credential`), or a value shaped like an AWS access key id, makes the block invalid; the error names the place, never the value.

The profile needs `ec2:DescribeInstances`, `ec2:StartInstances` and `ec2:StopInstances` (the last two limited to instances with the tag), and `ce:GetCostAndUsage`. For example:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "ec2:DescribeInstances", "Resource": "*" },
    {
      "Effect": "Allow",
      "Action": ["ec2:StartInstances", "ec2:StopInstances"],
      "Resource": "arn:aws:ec2:*:*:instance/*",
      "Condition": { "StringEquals": { "aws:ResourceTag/role": "gate-server" } }
    },
    { "Effect": "Allow", "Action": "ce:GetCostAndUsage", "Resource": "*" }
  ]
}
```

### The meter and the money guard

- **Spend** is the larger of two. Lair's meter: every run of every machine (the launch and stop times the provider reports) at `price_per_hour`, rounded up to whole minutes, plus `storage_per_month` for every month of the period begun so far, plus `meter_start`. A run whose stop the provider does not date counts up to the check that saw it stopped; a run still open when the machine launches again ends at that launch at the latest. And the provider's reading with what the meter counted since that reading's data ends: the reading is the account's unblended cost with credits and refunds left out, from `period.start` to today, read at most every `spend_check_hours` and kept in `data/cloud.db` (a restart does not read it again). Cost Explorer's data can be a day late, so a reading taken at T holds the spend up to T less a day; the meter's runs since then, and storage by the hour (at a 28-day month's rate), are added to it, so the provider's lag never hides a run.
- **What Lair did not see.** The provider dates only an instance's last launch, so runs that started and stopped while Lair was down, or between two checks, leave nothing but a newer launch. When Lair sees a launch newer than the last one it saw, after it last saw the machine stopped, the time from that sighting (less a minute) to the launch is a gap. A gap up to two checks long (`2 × check_seconds`) counts at `price_per_hour` as if the machine ran throughout (a start Lair makes itself adds about a minute this way). A longer one (Lair was down, or describes failed) is blind: no start happens until a cost reading taken a day after that launch is in, as its data then holds whatever ran. The first time Lair sees a machine is blind up to its last launch: a machine last launched before `period.start` has nothing to wait for, one launched in the period waits up to a day. A machine seen running before and after a gap keeps one run across it, so that whole time counts. Gaps are kept in `data/cloud.db`: a restart forgets none.
- **At the limit** (spend at or above `limit`) the guard trips: no start, the trip is recorded once with its spend, limit, period and reason, and `cloud.guard_tripped` is emitted. Later readings do not clear it, nor does a restart, nor does any edit of the config: a higher `budget.limit` or a new `period` alone leaves it standing (anything that can write the project file could make that edit). Only the owner clears it: **Clear the trip** in a cloud machine's detail (the Machines section), which sends `POST /api/cloud/trip/clear` with the owner's session and the trip's time. The clear is recorded with the owner session's public id and an optional note, logged, and emitted as `cloud.trip_cleared`; the guard then judges the spend again at the next check or start, and trips again if it is still at the limit. So raise `budget.limit` (and the provider's budget) first, then clear the trip.
- **The clock.** A clock behind the provider's never makes the meter count short: every run counts a minute at least (as EC2 bills one at least per start), and a stop the provider dates after this machine's clock is kept as dated, not cut back to now. A launch or stop dated more than a minute after this machine's clock means the clock is wrong: that machine's description is not recorded and starts are refused until the clock is fixed.
- **It fails closed.** A machine Lair could not describe in this check, a cost reading that failed, a blind gap no reading covers yet, or a day outside the period refuses a start too (`refused`, not a trip: starts are allowed again once the readings come back). A new account has no cost data for up to a day: that reading is "no data yet" (`unknown`), and the meter decides alone, but only for a new account: within two days of the account's first reading, while no amount was ever read for it, and, when the answer simply held no cost, while the meter has counted nothing (no storage, no run in the period). Past that, "no data" is a failed reading and refuses starts, so a wrong filter, a changed answer or another payer account never quietly removes the provider's reading.
- **Every start** runs the guard first on fresh readings: each machine is described again, and the cost is read if its reading is due. Checks and starts run one at a time. A stop is never refused. A config reload replaces the project's cloud instance: the old one calls no provider again (a start queued on it is refused), and the module exports no provider, so nothing in Lair reaches a provider's start but through the guard.
- **Shown to the owner only.** The Machines section lists each cloud machine with its power state (`running`, `stopped`, `pending`, `stopping`, or `unknown` with the reason), shows the spend and the guard in its header (`Cloud spend $12.40 of $100.00 (12.4%) · guard ok`), and in a machine's detail its instance and tag, last launch and stop, price, the meter's parts (compute, storage, starting amount, today), each account's reading and any trip. A browser not signed in as the owner sees none of it.
- **The account stays hidden.** A provider's error text names the account and the role (`User: arn:aws:sts::<account>:assumed-role/... is not authorized`). Lair hides every ARN, 12-digit account id and access key id in it (`arn:(hidden)`, `(account id hidden)`) before it keeps, logs or shows it, and keeps at most 300 characters.

### Cloud API

Every route is the owner's, reads included (the status names the account's instances and spend): `/api/cloud` is in `OWNER_ONLY_PREFIXES`, so no CORS is granted under it, and a request without the owner's session gets HTTP 403.

`GET /api/cloud/status?project=` (read-only): config errors, the last check, each machine's provider, region, instance and tag, power state, last launch and stop, last check and error, and the budget: limit, period, spend and its share of the limit, the meter's parts, each account's cost reading (`amount`, `unknown`, `error`, `not_read`), and the guard (`ok`, `warning`, `tripped`, `refused`) with its reason and the trip that stands (`{limit, period, spend, at, reason}`).

`POST /api/cloud/trip/clear?project=` with `{"trippedAt": "<the trip's at>", "note": "..."}` (owner): clears the trip that stands. `trippedAt` must be the standing trip's time, so a page showing an older trip clears nothing (HTTP 409, as when no trip stands). Answers `{cleared, by}` (the trip and the owner session's public id).

No route starts or stops a machine or changes the budget: the machines and the budget are changed in the project's YAML or in Settings.

Events on the bus: `cloud.guard_tripped` (`{project, limit, spend, reason}`), `cloud.trip_cleared` (`{project, trippedAt, limit, spend, by, note}`).

## Cleanup

> Off by default. With `enabled: true`, Lair removes stale worktrees and old entries from watched folders. In `observe` mode (the default) it logs what it would remove; in `act` mode it removes.

Agents and gate systems leave checkouts behind: gate snapshots that a runner reuses per track and never deletes, and agent worktrees for PRs merged long ago. Disk fills, file indexing and backups slow down, and nobody knows what is safe to delete. The cleanup module handles this automatically.

```yaml
cleanup:
  enabled: true
  mode: observe              # observe | act
  interval_seconds: 3600     # how often the cleanup cycle runs (default 1 hour)
  max_entries_per_cycle: 50  # bound removals per tick

  worktrees:
    repos:
      - /Users/dev/my-project
    after_merge: true
    min_idle_hours: 24

  retention:
    - path: /Users/dev/my-project/work/gates/snapshots
      keep_days: 2
      kind: worktree
      skip_if_referenced:
        - /Users/dev/my-project/work/gates/queue/*.req
        - /Users/dev/my-project/work/gates/queue/*.req.run

    - path: /Users/dev/my-project/work/gates/results
      keep_days: 30
      kind: file
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Enable the cleanup module |
| `mode` | `observe` \| `act` | `observe` | `observe` logs removals without executing; `act` removes |
| `interval_seconds` | number | `3600` | Seconds between cleanup cycles |
| `max_entries_per_cycle` | number | `50` | Maximum entries removed per cycle (safety bound) |
| `max_seconds_per_cycle` | number | `600` | Maximum seconds per cycle before stopping |

### Worktrees

A worktree of a configured repo is removable when all of these hold: its branch's PR is merged or closed; no uncommitted or untracked changes; every commit is on the remote; no active agent run uses it; nothing in it was modified within `min_idle_hours`; and it isn't the main worktree.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `worktrees.repos` | string[] | `[]` | Paths to repositories whose worktrees are managed |
| `worktrees.after_merge` | boolean | `true` | Remove worktrees whose branch's PR is merged or closed |
| `worktrees.min_idle_hours` | number | `24` | Hours since last modification before a worktree is eligible |

### Retention

Each retention entry scans a directory and removes entries older than `keep_days` unless they are referenced.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `retention[].path` | string | required | Directory to scan |
| `retention[].keep_days` | number | required | Days to keep entries (based on last use, not mtime) |
| `retention[].kind` | `worktree` \| `dir` \| `file` | required | What the entries are |
| `retention[].skip_if_referenced` | string[] | `[]` | Glob patterns of files whose content names entries to keep |

For worktree entries, "last use" is the gitdir `HEAD` file's mtime (the last checkout), not the folder's mtime. For example, a gate snapshot directory that is still referenced by a queued gate request file is kept even if it is old.

### Safety

Before removing anything, the cleanup module checks that the path:
- Resolves to a real path (no broken symlinks)
- Is inside a configured root (`worktrees.repos` or a `retention[].path`)
- Is not `/`, `$HOME`, the repository root, or a configured root itself
- If a symlink, the target is also inside a configured root

Removals are bounded per cycle and time-bounded. Every removal is recorded in the store with its reason and bytes freed.

### Cleanup API

Read-only routes:

| Route | What |
|-------|------|
| `GET /api/cleanup/status?project=` | Current mode, last cycle summary, pending entries |
| `GET /api/cleanup/pending?project=` | Detailed list of what cleanup would remove |
| `GET /api/cleanup/removals?project=&limit=` | Recent removals |
| `GET /api/cleanup/cycles?project=&limit=` | Recent cleanup cycles |
| `GET /api/cleanup/stats?project=` | Summary statistics (all time, 24h, 7d) |

Events on the bus: `cleanup.removed`, `cleanup.cycle`, `cleanup.safety_violation`.

The Health tab shows "Would free N GB (M entries)" in observe mode, and "Last cleanup: freed N GB (M entries)" in act mode, with links to the removals list.

## Infrastructure policy scan

Before any `plan` runs on infrastructure code, a static scan reads the code and refuses what it must not run ([design](design/deploy-aws.md#21-policy-scan-before-plan)). The scan reads files only: it never runs OpenTofu, a provider or a program. It is off unless you turn it on.

```yaml
infra_policy:
  enabled: true                       # default false
  roots:                              # absolute paths of the directories the scan reads
    - /srv/infra/staging
  allowed_providers:                  # provider sources that may be used
    - hashicorp/aws
  allowed_modules:                    # remote module sources: an exact source, or a prefix ending in /
    - terraform-aws-modules/vpc/aws
    - git::https://example.com/org/
  allow:                              # denied blocks you accept: root, address and the block's content hash
    - root: /srv/infra/staging
      address: data.http.health
      hash: 3b1c0f5a9d2e4c7b8a6f1e0d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b
```

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `enabled` | boolean | `false` | Turn the scan on for this project |
| `roots` | list of absolute paths | `[]` | Directories of infrastructure code; required when enabled |
| `allowed_providers` | list | `[]` | Provider sources, `namespace/type` or `host/namespace/type`; `hashicorp/aws` and `registry.opentofu.org/hashicorp/aws` are the same provider. Every provider the code declares or implies (from a resource, data or provider block, or a `provider` meta-argument) must be listed |
| `allowed_modules` | list | `[]` | Remote module sources. An exact source, or a prefix ending in `/` that names a host and at least one path segment (`git::https://example.com/org/`). A bare scheme, a host (`https://github.com/`) or `/` is a config error, and a source with a `..` segment never matches. Local modules (`./` or `../`) need no entry: they are scanned like the root, and must stay inside it |
| `allow` | list | `[]` | Denied blocks to accept. Each entry has `root` (one of `roots`), `address` (`data.http.health`; a block in a local module is `module.<name>.` plus its address) and `hash`, the content hash the scan reports for that block. Editing the block (a changed `url` or `command`) changes its hash and ends the allowance: the scan then refuses it and marks it `changedSinceAllowed`. The same address in another root is not allowed |

Refused, unless allowed: `external` and `http` data sources (also inside a `check` block), any provisioner (`local-exec`, `remote-exec`, `file`, others) on any resource or in a `removed` block, a provider not in `allowed_providers`, a remote module not in `allowed_modules`, a local module outside its root, a `source` that is not a plain string, a block of a type the scan does not know or with the wrong number of labels (`unknown-block`), and code the scan cannot read: `.tf`, `.tofu`, `.tf.json` and `.tofu.json` files, at most 1 MiB each, 8 MiB and 500 files in total, 8 module levels, and a 10 second deadline; a string escape it does not decode (it decodes `\n`, `\r`, `\t`, `\"`, `\\`, `\uNNNN`, `\UNNNNNNNN`) is unreadable too. An allowed use is not refused but is listed as `allowed`.

An invalid block (unknown keys, relative roots, `enabled` without roots, a bad `allowed_*` entry or `allow` entry) never turns the scan off: unless the block says `enabled: false`, the project is **blocked**, every `guardPlan` refuses with `invalid-config`, and `GET /api/infra-policy/status` shows the errors. Lair reads this block at startup.

The rule names are what an agent sees of a refusal (`policy violation: denied-external-data`); the file, line, address and hash are for you. Rules: `denied-external-data`, `denied-http-data`, `denied-local-exec`, `denied-remote-exec`, `denied-file-provisioner`, `denied-provisioner`, `provider-not-allowed`, `module-not-allowed`, `module-outside-root`, `source-not-literal`, `unknown-block`, `invalid-config`, `unreadable`. The scan does not read remote modules: allow only sources you have pinned and reviewed. Checking the lock file's hashes belongs to the plan sandbox, not this scan.

### Infrastructure policy API

Both routes are the owner's (signed in on the dashboard), reads included, and get no CORS.

| Route | Meaning |
|-------|---------|
| `GET /api/infra-policy/status?project=` | Whether the scan is on or blocked (with the errors), the roots, and the last scan of each |
| `GET /api/infra-policy/scan?project=&root=` | Scan a configured root (all roots without `root=`); 404 when the scan is off, 409 when the project is blocked, 400 for a root that is not configured |

The routes read files and run nothing. Server code that plans asks `InfraPolicyManager.requires(project)` and, when true, plans only through `get(project).guardPlan`, which does not start the plan when the scan fails (or when the config is blocked).

## Plan sandbox

`tofu plan` is not read-only: it runs every provider and data source in the code ([design](design/deploy-aws.md#22-plan-isolated)). The plan sandbox runs it in an isolated container with the read-only plan role and nothing else. It is off unless you turn it on, and it needs the [policy scan](#infrastructure-policy-scan) on for the project: a plan never starts on code the scan did not pass.

```yaml
plan_sandbox:
  enabled: true                       # default false
  plan_role_arn: arn:aws:iam::123456789012:role/lair-plan
  external_id: lair-plan-1            # required; what the role's trust policy asks for
  image: plan-runner:1                # container image with the tofu binary
  plugin_dir: /srv/infra/provider-mirror
  provider_api_hosts: ["*.amazonaws.com"]
  registry_hosts: [registry.opentofu.org]
  egress_network: plan-egress         # optional; without it the plan has no network
```

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `enabled` | boolean | `false` | Turn the sandbox on for this project |
| `plan_role_arn` | IAM role ARN | none | The read-only role every plan assumes; required when enabled. Lair asks STS for 15 minutes (900 s, the shortest STS issues) and never stores the credentials |
| `external_id` | string | none | Required when enabled: the external id for the assume-role call, so the role is never assumed without one. Not a secret |
| `region` | string | `us-east-1` | Region of the credentials |
| `image` | string | none | Image the plan runs in; required when enabled (a plain image reference) |
| `plugin_dir` | absolute path | none | The provider mirror, mounted read-only. Providers come from here with `init -lockfile=readonly`; nothing is downloaded at plan time. Required when enabled; a plain path, no `:` or `,` |
| `provider_api_hosts` | list of hosts | `[]` | Hosts the plan may reach: the provider APIs. A host, or `*.` plus a domain |
| `registry_hosts` | list of hosts | `[registry.opentofu.org]` | Hosts the plan may reach: the module and provider registries |
| `egress_network` | container network | none | A network whose only exit is a proxy or firewall that lets exactly the two host lists through. **Lair does not run that proxy and does not filter by hostname**: with this key set the isolation is only as good as your proxy (hostname enforcement is follow-up #203). `host`, `bridge`, `default` and `container:` are refused; `none` or no key gives the container no network at all (`--network none`, enforced by docker) and a plan that needs the cloud fails |
| `timeout_seconds` | integer | `600` | 10 to 900; a step that runs longer is killed, and never longer than the credentials' life |
| `max_output_bytes` | integer | `262144` | Output kept for the owner; the rest is cut |

**What a run does,** in this order, each step ending the run before the next: Lair copies the root (leaving out `.git`, `.terraform`, `*.tfstate*` and `.env*`; a symlink or special file refuses the copy), the policy scan reads the root, the root is hashed again and must still match the copy, `.terraform.lock.hcl` must pin every provider with a version and verified hashes, each on `infra_policy.allowed_providers`, and only then are the plan role's credentials issued. `tofu init -lockfile=readonly -plugin-dir=/plugins` and `tofu plan -lock=false -detailed-exitcode` then run in the copy. The container is read-only, drops every capability, has a memory and process limit, and its whole environment is the plan role's credentials plus fixed settings: no variable of Lair's own reaches it. The credentials are removed from the output before it is shown. Fixed settings (`PATH`, `HOME`, the tofu switches, the region) go to the container with explicit values; the credentials go by name only, so they are not in the process list; the docker client gets only its own settings (`PATH`, `HOME`, `DOCKER_*`), and `aws sts` gets only `AWS_*`, `PATH` and `HOME`.

**Image requirement and crash cleanup.** The command runs under `timeout -s KILL`, a few seconds after Lair's own limit, so a container cannot outlive a dead Lair by more than that: the image needs a `timeout` command (coreutils or busybox). At startup, when a project has the sandbox on, Lair removes leftover `lair-plan-*` temp copies and containers (it assumes one Lair per machine). Output past 8 MiB stops the run and is reported as `output`, not as a timeout.

An invalid block (unknown keys, no role, no mirror, a relative path, a bad host or a timeout over 900) never turns the sandbox off: unless the block says `enabled: false`, every plan is refused with `invalid-config` and `GET /api/plan-sandbox/status` shows the errors. Lair reads this block at startup.

### Plan sandbox API

Both routes are the owner's (signed in on the dashboard) and get no CORS.

| Route | Meaning |
|-------|---------|
| `GET /api/plan-sandbox/status?project=` | Whether the sandbox is on or blocked (with the errors), the role, the declared egress hosts (`declaredEgressHosts`, with `egressHostsEnforcedByLair: false`) and the limits; no credential |
| `POST /api/plan-sandbox/plan?project=&root=` | Plan one of the project's `infra_policy.roots` through the scan and the sandbox; 404 when the sandbox is off, 400 for a root that is not configured. The answer is `refused` (with the reason), `failed` (init, plan, timeout, output or credentials) or `planned` (`changes`, the output, when the credentials expire) |

## OpenTofu runner

Plans and applies infrastructure from the control plane ([design](design/deploy-aws.md#26-apply)). It adds no execution path of its own: every plan and every apply goes through the [policy scan](#infrastructure-policy-scan) and the [plan sandbox](#plan-sandbox) (copy, scan, lock-file check, then credentials), so the project needs both on. Off unless you turn it on; `observe` mode, the default, plans and never applies.

```yaml
tofu_runner:
  enabled: true                       # default false
  mode: observe                       # observe (plan only) or act (apply an approved plan)
  apply_role_arn: arn:aws:iam::123456789012:role/lair-apply
  external_id: lair-apply-1
  state_bucket: lair-state-123456789012
  environments: [staging, production]
  plan_dir: /var/lib/lair/tofu-plans
```

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `enabled` | boolean | `false` | Turn the runner on for this project |
| `mode` | `observe` or `act` | `observe` | `observe` refuses every apply; `act` applies a plan the owner approved |
| `apply_role_arn` | IAM role ARN | none | The role `tofu apply` assumes (1 hour); required when enabled and never the plan role (the block is then invalid). Not used for a plan |
| `external_id` | string | none | Required when enabled: the apply role's external id. Not a secret |
| `state_bucket` | S3 bucket name | none | Required when enabled. Each workspace (an environment of one root) has its own state, `<project>/<env>/<root name>-<8 hex of the root path hash>/terraform.tfstate`, with `use_lockfile=true` (OpenTofu 1.8+ native locking, no lock table) and `encrypt=true`; the code declares an empty `backend "s3" {}` and Lair passes these as `-backend-config` |
| `environments` | list of names | `[]` | The environments that can be planned and applied; at least one when enabled |
| `plan_dir` | absolute path | none | Where plan files, their records and the audit log are kept (files 0600). Required when enabled; keep it outside any repository. Lair creates it 0700 and refuses to plan or apply (`plan-dir-unsafe`) when it is not a directory of its own user or is open to group or others |
| `apply_timeout_seconds` | integer | `1800` | 60 to 3600; never longer than the apply role's hour |
| `plan_max_age_seconds` | integer | `86400` | 60 to 604800 (a week). A plan older than this is refused (`plan-expired`) and can no longer be applied; plan again |

**Plan.** The sandbox runs `tofu init` with the S3 backend, then `tofu plan -lock=false -out=lair.tfplan` with the plan role (which reads state, never writes). It then reads the plan back with `tofu show -json` and records which resources it deletes (`destroys`) and which it replaces (`replaces`); a plan whose changes cannot be read is refused (`plan-unreadable`). A plan with changes is kept as `<id>.tfplan` with a record (project, root, environment, the plan file's SHA-256, the hash of the code it was made on). A newer plan of the same root and environment supersedes the older, which can then no longer be applied. A plan with no changes keeps nothing.

**Apply.** Only `act` mode, only a plan that is still `planned`, and only when the hash sent with the approval equals the recorded hash and the file on disk still hashes to it. Then the sandbox repeats copy, scan and lock-file check, refuses when the code is not the code that was planned, and runs `tofu apply lair.tfplan` with the apply role. OpenTofu itself refuses a plan made on a state that has since changed. A plan is applied once. Only one plan or apply runs per workspace (root and environment) at a time; another is refused at once with `workspace-busy`, while a different root or environment is not held up. A plan that deletes or replaces anything also needs its own confirmation: the plan answer carries `destroys`, `replaces` and `destroyConfirmation` (a hash bound to the plan and those resource names), and the apply is refused (`destroy-not-confirmed`, naming the resources) unless `confirmDestroy` carries it. An apply that raises an error or is cut off by a restart ends `failed` (never left `applying`), its file is dropped, and the owner plans again; Lair marks such leftovers failed when it starts.

**A failed apply is not rolled back.** Resources the apply created or changed stay, and the state records them. The plan is spent (`failed`, or `stale` when the state or code changed), its file removed, and the runner re-plans from the state as it now is; the answer carries that new plan, which needs a new approval. Nothing runs `destroy` on its own. Each outcome is logged with the plan hash and the time.

**Audit.** Every plan, every apply request (refused ones too, with the reason), every apply start and every apply end is appended to `audit.jsonl` in `plan_dir` and sent as a `tofu.plan`, `tofu.apply.refused`, `tofu.apply.started` or `tofu.apply.finished` event. An entry holds the time, the owner session id, project, environment, root, the full plan hash, the outcome and reason, and the destroyed or replaced resources; no tool output and no credential. An apply does not start when its start entry cannot be written.

**No spend check yet.** An apply does not consult the [cloud money guard](#cloud-machines) or any cost estimate (cost estimation is a later change of the design). With `mode: act` an approved plan creates paid resources with no spend limit in front of it, so turn `act` on knowingly. The default, `observe`, and the default of being off keep this safe.

An invalid block (or an `apply_role_arn` equal to the plan role) never turns the runner off: unless the block says `enabled: false`, every call is refused with `invalid-config` and `status` shows the errors. Lair reads this block at startup.

### OpenTofu runner API

All routes are the owner's (signed in on the dashboard) and get no CORS. A project without `tofu_runner.enabled` answers 404 (400 for a missing or unknown `root`, `env`, `plan` or `hash`).

| Route | Meaning |
|-------|---------|
| `GET /api/tofu-runner/status?project=` | On or blocked (with the errors), mode, apply role, bucket, environments; no credential or external id |
| `GET /api/tofu-runner/plans?project=` | The plan records: id, root, environment, plan hash, status (`planned`, `applying`, `applied`, `failed`, `stale`, `superseded`, `expired`) and times. Never the plan file |
| `GET /api/tofu-runner/audit?project=&limit=` | The newest audit entries (default 100, at most 500), oldest first |
| `POST /api/tofu-runner/plan?project=&root=&env=` | Plan one environment of a configured root. `refused`, `failed`, or `planned` (`changes`; with changes also `planId` and `planHash` to approve) |
| `POST /api/tofu-runner/apply?project=&plan=&hash=&confirmDestroy=` | Apply the plan `plan` whose approved hash is `hash`; `confirmDestroy` is needed when the plan destroys or replaces. `applied`, `refused` (`observe-mode`, `unknown-plan`, `not-approvable`, `hash-mismatch`, `plan-file-changed`, `plan-expired`, `destroy-not-confirmed`, `workspace-busy`, `plan-dir-unsafe`, `audit-unavailable`, `policy`, ...) or `not-applied` (with `replan`) |

## Planner

> Off by default. With `enabled: true`, Lair keeps [fill](#fill)'s tasks file itself: it marks tasks done, drops the ones the plan marks done, and runs a supervised planner agent when something happens, whose proposals it checks before anything changes ([design](design/planner.md)). A project then needs no free-running orchestrator agent that edits the tasks file.

The planner reads its **sources**, all bounded and path-checked:

- `markdown_plan`: markdown files with checkbox tasks, `- [ ] <id>: text` and `- [x] <id>: text` (`*` and `+` bullets too). The id comes from `id_pattern` (a named group `id`, or the first group); a line without one is an open task in the planner agent's context but is never matched against the tasks file. Headings give each task its section, a heading matching `phase_pattern` its phase, a line that is only bold text a subsection; lines indented under a task are its details; `depends_pattern` (`depends on A-1, A-2 and B-3` by default) lists what it waits on, and a task is ready when every one of those is done. Fenced code blocks are skipped. A repeated id counts once (the first); the rest are reported.
- `backlog_file`: one task per line, as a `checklist` (the same parser, the default), as `list` items (`- text`, `1. text`), or as `table` rows (every row after a header; the id from `id_column`). List items and rows are done when `done_pattern` matches.
- `owner_messages`: the owner's message file (default: `inbox_file`, the `- OWNER <time> [<id>]: <text>` lines the Owner messages view writes), without the ones answered in `replies_path` (default: `outbox_file`). A new one is a trigger. The planner writes no replies.
- `queue_events`: the queue file (default: `queue_file`): the lines written since the last check (`DONE`, `BLOCKED`, `WAITING` and the rest). The first check only notes where the file ends, so old lines are never taken for new ones; neither are those of a file that was rewritten.

Plan and backlog files are read whole up to `max_bytes` (a larger one is refused, not cut) and `max_lines`; message and queue files from their end. Every line is cut at 2,000 characters before a pattern sees it. A path is relative to `repo` and must be inside `repo`, `agents_dir` or one of `roots`, also once symlinks are resolved, so a symlink can't lead out; the files the project config names itself (`queue_file`, `inbox_file`, `outbox_file`) are checked against their own directory. The file must be a regular file (a FIFO or a directory is refused, and its last component is never followed if it is a symlink).

**The rules** run every `interval_seconds`, with no agent:

- **done**: a line whose task the queue reports done, by fill's own done check (`done_pattern`, the lines written since the task's latest run started, the whole file for a task Lair never ran), becomes `<done_marker><line>` (`#done worker-a|...`), which fill reads as a comment. `mark_done: lair_runs` limits this to tasks the agents module ran, for a project where another launcher still runs some tasks and reuses task ids for a whole workstream; `off` turns it off.
- **plan done**: a line whose task id is a plan or backlog task marked done is removed (`drop_plan_done`).
- Every edit is checked with fill's parser: one that would add a malformed line, a duplicate task, a task past fill's 200 or a file over 256 KB is refused. Lines Lair writes name only agents in `agents.fill.agents`.
- In `act` mode the tasks file is written atomically (a new file in its directory, then a rename) and only if it still has the content the change was made from; a tasks file that is a symlink is never written. In `observe` mode nothing is written: each change is recorded once as `planned`.
- Every change is recorded with its reason and diff (`GET /api/planner/history`, and the Planner view). An edit someone else makes is accepted and recorded as `external`.

**The planner agent** (`agent:`, optional: without it only the rules run) is an agent of the project that fill never starts (it must not be in `agents.fill.agents`), run through the agents module like any run (claims, locks, recovery, failover and budgets apply). A run starts on a **trigger**: an allowlisted agent reports `DONE` and has no open line left; an agent reports `BLOCKED` for a task problem (below); allowlisted agents are idle with no line (once per idle set: an edit of the tasks file that leaves the same agents idle is no new trigger); a new owner message; a plan or backlog file changed. Triggers wait until the newest is `debounce_seconds` old, and a run starts at least `min_interval_seconds` after the previous one and only while fewer than `max_runs_per_day` runs started in the 24 hours before; there is one at a time. Its prompt is `prompt_file` (inside `prompts_dir`, read as fill reads prompt files), then what Lair adds: the path of its proposal file, the rules, and the context as JSON data (the triggers, the allowlist and idle agents, the tasks file, open plan and backlog tasks, recent queue events, unanswered owner messages and blocked tasks; every string cleaned and cut, the whole cut to `context_max_bytes`).

Its **only output** is the proposal file, `<work_dir>/<run id>/proposals.json`:

```json
{"proposals": [{"op": "add", "task": "feat-search", "agent": "worker-b", "text": "Search page", "reason": "ready in the plan; worker-b is idle"}]}
```

- `op`: `add` (a new task id, an allowlisted `agent`, and `text`, the line's description), `finish` (mark it done), `reassign` (another allowlisted `agent`), `reword` (new `text`), `drop` (remove the line), `unblock` (release fill's `blocked` or `no_done` hold on it, a run that stopped without done and said so, never an `owner`, `waiting` or `waited_too_long` hold, and clear the planner's blocked record); `reason` always. An `unblock` needs a task the planner recorded as blocked by a task problem (not by its environment, nor one needing you), with an attempt left (`attempts_per_task`): applying it spends one. Neither `unblock` nor `reword` may touch a task you chose to leave blocked.
- Each proposal is checked in order: the schema (unknown keys are refused), fill's task-id rules and `task_id_pattern`, the allowlist (never the planner agent), the tasks file as the proposals before it leave it (`add` needs a new id, not a done one; the others an open line; `reassign` and `drop` wait while the task has an active run), one proposal per task, `text` one line of at most 500 characters, and `max_proposals` (the rest are refused). A refused proposal is kept with its reason. A run whose agent didn't complete, wrote no file, a file over 256 KB, a symlink or not `{"proposals": [...]}` fails; its triggers wait for the next run, and after `max_failed_runs` failures in a row planner runs pause and you are asked once.
- In `act` mode accepted proposals are applied at once, except ops with `approval: always` (default: `finish`, `reassign`, `drop` and `unblock`; only `add` and `reword` apply by themselves); in `observe` mode all of them wait. A task the queue reports done is the rules' to mark, so a `finish` of the planner's own has no done line behind it, and an `unblock` starts again work fill held: you see each one. Waiting proposals are listed in the Planner view, where you approve or reject each one or a whole run, and each run with waiting proposals raises one [Decision Inbox](#decision-inbox) decision ("Apply them all" or "Reject them all"). An approval is checked again against the tasks file as it is then. **Approving writes the tasks file, in observe mode too.**

**The verifier** (`verifier:`, optional) is a second agent that reviews accepted proposals before they are applied or sent to you. After the planner's proposals pass Lair's schema and rule checks, the verifier runs and returns per-proposal verdicts:
- `approve`: the proposal makes sense in context; it proceeds to auto-apply (if listed in `auto_apply` and in act mode) or waits for you;
- `reject`: the proposal conflicts with reality (the task is done, a dependency isn't ready, the scope is wrong); the proposal waits for you with the verifier's reason shown, and is auto-rejected only if the op is listed in `auto_reject` and the project is in act mode;
- `unsure`: the verifier can't tell; the proposal waits for you even when its op is in `auto_apply`.

Proposals without a verdict are treated as `unverified`. When verification is off or all attempts fail, every proposal is `unverified` and the decision says "Not verified: Lair only checked the format" with a `reject_all` recommendation. A malformed verdicts file fails the verifier run; the proposals proceed as `unverified`. The decision context shows each proposal's verdict, reason and evidence. When verdicts are mixed, the decision offers a **follow_verifier** option: apply the approved ones, reject the rest with the verifier's reasons. `drop` may never be in `auto_apply` (config error).

- **The planner agent can't edit the tasks file.** In `act` mode a change to it while a planner run is active is put back, that run's proposals are refused, and you get a decision with the diff (go on, or pause planner runs). In `observe` mode, where another tool may still write the file, the change is recorded and kept. Running agents as a separate OS user is what makes the file unwritable for them. Its `text` only becomes a description, which fill shows and never puts into a prompt.

**BLOCKED lines.** A new `BLOCKED` queue line is matched to a task (an id it names, else the reporting agent's only open line), and its reason (the text after the first `: `) is classified by `blocked.owner_patterns`, then `blocked.environment_patterns` (case-insensitive; the defaults cover approvals, decisions, credentials, accounts and money, then permissions, disk, memory, containers, network, timeouts, load, locks and stuck runners):

- needs you, or the environment: one decision per task and class ("It's sorted: let the task go on", which unblocks it, or "Leave it blocked"), and a `planner.blocked` event. For a task fill runs (`agents.fill` on, its agent allowlisted), when fill's `blocked_pattern` matches the line, fill holds the run and asks you itself, so the planner raises no second decision for it. The planner matches more lines to a task than that pattern does (by the agent's only open line); fill takes such a line for a run without a done line and starts the task again, so the planner asks you itself, at once, and the Planner view says why;
- anything else is a task problem: a planner run (it may `reword` or `unblock`), with `attempts_per_task` attempts per task, each planner run for it and each unblock applied spending one; then one decision ("Let the planner try again" or "Leave it to me"). So a task that keeps getting blocked, or that fill keeps holding for runs without a done line, reaches you instead of a loop of planner runs.
- A task you leave blocked ("Leave it blocked", "Leave it to me") is left alone until its line changes: its BLOCKED lines ask nothing, and the planner's `reword` and `unblock` of it are refused. Rewording the line yourself (editing the tasks file) is what clears that, and only that: the planner's attempts on the task count from zero again only when you answer "Let the planner try again".

```yaml
agents:
  enabled: true
  fill:
    enabled: true
    tasks_file: /home/user/lair-work/my-project-tasks.txt   # the planner keeps this file
    agents: [worker-a, worker-b]
    prompt_files: ["{prompts_dir}/{agent}.txt"]
planner:
  enabled: true
  mode: observe                      # act: Lair writes the tasks file itself
  roots: [/home/user/lair-work]
  sources:
    - kind: markdown_plan
      paths: [docs/plan.md]          # "- [ ] feat-search: Search page"
    - kind: backlog_file
      paths: [docs/backlog.md]
      format: table
      id_pattern: "^(?<id>B\\d+)\\b"
      done_pattern: "\\bdone\\b"
    - kind: owner_messages
    - kind: queue_events
  agent:
    id: planner-agent                 # a dragons entry, not in agents.fill.agents
    prompt_file: planner.md           # in prompts_dir
    min_interval_seconds: 600
    max_proposals: 10
  approval: { finish: always, reassign: always, drop: always, unblock: always }   # the defaults
  attempts_per_task: 2
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Run the planner for this project (needs `agents.enabled` and `agents.fill.tasks_file`) |
| `mode` | `observe` \| `act` | `observe` | `act`: Lair writes the tasks file; `observe`: it records what it would write, and every proposal waits for you |
| `interval_seconds` | number | `60` | Seconds between checks |
| `tasks_file` | string | `agents.fill.tasks_file` | Must be fill's tasks file |
| `done_marker` | string | `"#done "` | What a done line starts with (a `#`, so fill skips it) |
| `mark_done` | `all` \| `lair_runs` \| `off` | `all` | Which lines the queue's done lines mark done |
| `drop_plan_done` | boolean | `true` | Remove lines whose task the plan marks done |
| `work_dir` | string | `{agents_dir}/lair-planner` | Where each planner run's directory (`context.json`, `proposals.json`) is made. `{agents_dir}`, `{repo}` |
| `roots` | array | `[]` | Directories sources may be read from, besides `repo` and `agents_dir` |
| `sources` | array | `[]` | `{kind, name?, ...}`: see above. `markdown_plan`: `paths`, `id_pattern`, `phase_pattern`, `depends_pattern`, `max_bytes` (1 MB, at most 4 MB), `max_lines` (20,000). `backlog_file`: the same, plus `format`, `done_pattern`, `id_column`. `owner_messages`: `path`, `replies_path`, `max_messages` (20), `max_bytes` (256 KB). `queue_events`: `path`, `max_events` (200). At most one of each of the last two |
| `agent.id` | string | — | The planner agent |
| `agent.prompt_file` | string | — | Its prompt template, in `prompts_dir`. `{prompts_dir}`, `{agent}`, `{task}` |
| `agent.min_interval_seconds` | number | `600` | Least time between two planner runs' starts |
| `agent.debounce_seconds` | number | `60` | A run starts once the newest trigger is this old |
| `agent.max_proposals` | number | `10` | Proposals a run may make (at most 50) |
| `agent.max_runs_per_day` | number | `24` | Planner runs that may start in any 24 hours, whatever triggers them |
| `verifier.id` | string | — | The verifier agent (optional): a known agent, not in `agents.fill.agents`, not the planner agent |
| `verifier.prompt_file` | string | — | Its prompt template, in `prompts_dir`. `{prompts_dir}`, `{agent}`, `{task}` |
| `verifier.max_runs_per_day` | number | `48` | Verifier runs that may start in any 24 hours |
| `verifier.skip_ops` | array | `[]` | Ops that skip verification and proceed straight to approval rules |
| `verifier.auto_apply` | array | `[]` | In act mode, ops whose approved proposals apply without the owner. `drop` may never be listed (config error) |
| `verifier.auto_reject` | array | `[]` | In act mode, ops whose rejected proposals are declined without the owner |
| `verifier.timeout_seconds` | number | `900` | How long a verifier run may take before it is retried |
| `verifier.attempts` | number | `2` | How many times to retry a failed or timed-out verifier run |
| `approval.<op>` | `never` \| `always` | `finish`, `reassign`, `drop`, `unblock`: `always`; `add`, `reword`: `never` | Ops that wait for you in `act` mode |
| `attempts_per_task` | number | `2` | Planner runs per blocked task; then you decide |
| `max_failed_runs` | number | `3` | Failed planner runs in a row before runs pause |
| `blocked.owner_patterns`, `blocked.environment_patterns` | array | see above | Regular expressions for a BLOCKED reason |
| `context_max_bytes` | number | `64000` | The context bundle's size |
| `task_id_pattern` | string | — | A regular expression the task ids of proposals must match too |

Config errors (an unknown key, an invalid pattern or one without its group, a `tasks_file` other than fill's, a planner agent that is unknown or in `agents.fill.agents`, a `..` in `prompt_file`, a repeated source name, two `owner_messages` or `queue_events` sources) turn the planner off for that project; `GET /api/planner/status` shows them. A tasks file, `prompts_dir` or `work_dir` inside `repo` is a warning: whoever writes the tasks file or the planner's prompt chooses what the agents work on. So is a plan, backlog or owner-message file inside `repo`: an agent could change what the planner reads, write "owner" messages, or, with `drop_plan_done`, drop a task from the tasks file by ticking it `[x]`. Owner messages are only as trustworthy as the file they come from, and the planner agent is told so.

### Planner API

`?project=` defaults to the default project. Every route needs the owner's session, from the dashboard (HTTP 403 otherwise; `/api/planner` gets no CORS), because it shows plan or task text, paths on this machine, or changes something:

- `GET /api/planner/status`: enabled, mode, whether runs are paused, the last check and error, config errors and warnings, and counts (sources, open and ready tasks, waiting proposals, runs)

- `GET /api/planner/overview`: the sources and their parse status, the tasks file's lines and done tasks, open plan and backlog tasks (ready or what they wait on), pending triggers, blocked tasks and how each was routed, idle agents, the planner agent and when its next run can start
- `GET /api/planner/proposals?status=pending|applied|rejected|declined&limit=100`, `GET /api/planner/runs?limit=100`, `GET /api/planner/history?limit=100`
- `POST /api/planner/check`: check now
- `POST /api/planner/proposals/<id>/approve`, `.../reject`, `POST /api/planner/runs/<id>/approve`, `.../reject`, `POST /api/planner/resume`: each with `{"confirm": true}` (HTTP 400 without; 409 when nothing waits)

Events: `planner.changed`, `planner.run_started`, `planner.run_finished`, `planner.proposals_pending`, `planner.blocked`, `planner.tasks_file_restored`. Decisions are raised as module `planner`. Everything is kept in `data/planner.db`: a restart keeps the pending triggers, the planner run in progress, waiting proposals and the history.

## Brain bench

`lair brain-bench` scores candidate "brains" on recorded decisions: a small local model, a hosted model, or a set of deterministic rules. It is a command, not a server feature: there is no configuration key, it is off unless you run it, it never talks to the Lair server and changes nothing. A shadow mode that compares a model with the real answers later reuses the same scoring.

```
lair brain-bench --cases cases.jsonl --model ollama:qwen3:4b --model rules:rules.json [--endpoint <url>]
                 [--api-key-env <NAME>] [--threshold 0.5] [--limit <n>] [--json]
```

**Cases** are JSON Lines, one decision per line (at most 50,000 lines, 32 KB each, 16 MB in all):

```json
{"id": "d1", "kind": "escalation", "module": "agents", "evidence": {"class": "rate_limited", "attempts": 3},
 "options": [{"id": "wait", "label": "Wait for the cooldown"}, {"id": "switch", "label": "Switch profile"}],
 "label": "wait", "reason": "the cooldown ends soon"}
```

`evidence` holds structured fields (codes, counts, flags), not prose. `label` is the option id that was answered. `reason` is kept for people and never sent to a model. Three optional fields serve the [brain trainer](#brain-trainer) and are never sent to a model either: `at` (the decision's ISO-8601 time, for the time split), `recommended` (the option id Lair recommended) and `outcome` (`good`, `bad` or `pending`). An invalid value of one of these three is ignored (the field is left out, and the trainer counts a case without a usable `at` as unusable), so a file that scored before still scores. Other fields are ignored. A bad line stops the run with its line number.

**Models** (`--model`, repeat it to compare):

| Spec | What it is |
|---|---|
| `ollama:<name>` | An Ollama server (`/api/chat`), the answer constrained with a JSON schema. `--endpoint` defaults to `http://127.0.0.1:11434`. |
| `openai:<name>` | Any OpenAI-compatible server (`/chat/completions` with a strict `json_schema`): vLLM, LM Studio, llama.cpp, a hosted API. `--endpoint` defaults to `http://127.0.0.1:1234/v1`. `--api-key-env NAME` reads the bearer token from that environment variable; the token is never printed and an endpoint URL with embedded credentials is refused. |
| `rules:<file.json>` | Deterministic rules scored like a model: `{"rules": [{"when": {"module": "agents", "class": "rate_limited"}, "option": "wait", "reasonCode": "cooldown"}]}`. The first rule whose `when` fields all equal the case's `kind`, `module` or evidence fields answers with confidence 1. No match is an abstain. |

The model is asked for `{"option", "reason_code", "confidence"}` with `option` limited to the case's option ids. The case reaches the prompt as fenced data and is never treated as instructions. A reply that is not valid JSON, names an option the case does not offer, or has no confidence from 0 to 1 counts as an abstain and as an error; so does an endpoint that cannot be reached.

**The report**, overall and for each decision kind, for each model:

| Measure | Meaning |
|---|---|
| `accuracy` | correct / all cases (an abstain is not a hit) |
| `answeredAccuracy` | correct / (correct + wrong) |
| `abstainRate` | answers below `--threshold` confidence (default 0.5), plus errors |
| `wrongConfidentRate` | wrong answers at or above the threshold, over all cases: the number to keep near zero before a model may act |
| `errors` | replies that were unusable (a subset of the abstains) |
| latency | mean, p50 and p95 per case, in milliseconds |

`--json` prints the report as JSON. Exit code 0 means the bench ran; 2 means bad input and nothing ran. Cases are asked one at a time per model.

## Decision policies

[decision-policies.md](design/decision-policies.md) §3 and §5, rollout step 2: a **policy table** says which option a rule would choose for a class of decision, and Lair writes that proposal into a **policy trace** when the decision is raised. **Nothing answers a decision**: every policy is `shadow` (or `off`), a proposal is never shown with the decision, and the table's only effect is the agreement view for you. `suggest` and `act` do not exist yet; a file that asks for them is refused.

It is off until `data/server.yaml` says otherwise (read once at start, so a change needs a restart):

```yaml
decision_policies:
  enabled: true
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Off: nothing is proposed or written to the trace (not at start either), no module updates a raised decision's evidence (`cause_cleared`), and `GET /api/owner/decision-policies` shows the table and `enabled: false` with no agreement. A section with any other key or a value of another type is refused: the policies stay off and the reason is logged and shown in the view |

Without `data/policies.yaml` Lair uses a built-in table with rules C1 (`agents.provider_limit` → `wait` while its cause stands), C2 (`supervisor.check_failing` → `noted` when an issue tracks the check), C3 (`watchdog.idle_capacity` → `stand_down` after two playbook attempts, never with nothing running), C4 (`watchdog.orphan_claim` → `stand_down` while a runner is alive) and C11 (`agents.cannot_start` → `keep_held`). To change it, write the file and restart (it is read once at start):

```yaml
version: 1
policies:
  - id: c1-wait                  # unique; lowercase letters, digits, '_' and '-'
    class: agents.provider_limit # a class of the policy table (src/server/decisions/structure.ts)
    codes: [provider_rate_limit] # evidence codes it covers; empty: every code of the class
    answer: wait                 # the option it proposes: must be offered, and not irreversible or outward
    reason_code: provider_limit_clears
    state: shadow                # off | shadow
    max_tier: 1                  # 1 rules, 2 may also be a model's, 3 stays with you (never proposed)
    when:                        # every condition must hold
      - { fact: attempts, op: gte, value: 2 }
    unless:                      # any guard that holds, or cannot be evaluated, makes the rule abstain
      - { fact: cause_cleared, op: eq, value: true }
    expires: 2027-01-01T00:00:00Z   # optional; past it the rule abstains
```

A condition tests a key of the decision's `evidence.facts`, or `cause_cleared` / `linked_issue`. Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte` (numbers), `in` (a list), `present` (not null). A fact that is missing, null or of another type than the value never satisfies a condition. Validation fails closed: an entry with any problem (unknown class, a code the class does not take, a bad operator, a repeated id) is refused and listed in the view, the others load; a file that is not valid YAML, is larger than 256 KB or has the wrong shape gives no policies. Whatever the table says, a rule abstains for a decision of a kind that always waits for you (spend, pricing, legal, account, credentials, go/no-go, security), for an option that is `irreversible`, `outward` or has no effect, and for a decision without a class and evidence.

**The trace** is the `policy_trace` table in `data/decisions.db`: one row per decision, proposer and table version (the version is a hash of the table, so any change starts a new comparison): class, policy, proposed option (empty when it abstained), reason code, confidence, time. A repeated event or a restart writes no second row; open decisions raised while Lair was down (or while the policies were off) get theirs at the next start, all of them, a page at a time in the background. A proposal is written once, when the decision is raised (or at that catch-up): a later `cause_cleared` update does not make a new one. **Agreement** joins the trace to the answers people gave (counted in the database, so the view never reads the whole trace): per class and version, `compared` (answered), `agreed`, `disagreed`, `abstained`, `agreement` (agreed of agreed + disagreed), `coverage` (proposed of compared), `unsafeDisagreements` (a disagreement where the proposal was an `irreversible` or `outward` option), and the decisions still open or withdrawn. It is `GET /api/owner/decision-policies` (owner only) and the **Policy agreement** card on the Decisions page when you are signed in as the owner.

**`cause_cleared` and `linked_issue`** are set when a module raises a decision. A module that learns more later calls `updateEvidence` on the Decision Inbox (`DecisionProducer.updateEvidence`): only the module that raised an open decision, only those two facts, audited as `evidence_updated`, and the same value again changes nothing. While `decision_policies.enabled` is on, the agents module does it for a provider-limit decision when the reset time it named has passed; while it is off, no decision's evidence changes after it was raised. No module tracks an issue yet, so `linked_issue` stays empty and C2 abstains; the planner's C7 stays out of the table until its module re-evaluates `cause_cleared`.

## Brain trainer

The brain trainer starts the training that [decision-policies.md](design/decision-policies.md) §6 calls stage C, and keeps it going: every night it rebuilds the labelled set from the answered decisions, trains a small classifier, scores it on the [brain bench](#brain-bench) against the newest decisions, and keeps the result as a new version. The model that scores best then writes a **proposal into a trace** for each decision raised afterwards. **No model ever answers a decision**: the trainer is handed a read-only view of the Decision Inbox, nothing it produces is shown with a decision, and promoting a model past `shadow` is the owner's decision under the bars in §5 (30 comparisons, 90% agreement for a model, no unsafe disagreement, coverage 60%). It is off until `data/server.yaml` says otherwise.

```yaml
brain_trainer:
  enabled: true
  image: sha256:<64 hex>             # required: the id `docker build -q brain-trainer/` prints; Lair never pulls it
  run_hour: 3                        # local hour of the nightly run
  min_labels: 100                    # fewer usable labels: the run only writes its report
  test_fraction: 0.2                 # the newest share is held out for the bench
  min_test: 10                       # a newest window smaller than this is not scored
  confidence_floor: 0.7              # a proposal below it is an abstain
  timeout_minutes: 15
  shadow: true                       # the best model writes proposals into the trace
  cases_file: /abs/path/cases.jsonl  # optional: more labelled cases, in the brain bench format with "at"
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Nothing runs, is written or is subscribed to while this is off |
| `image` | `sha256:<64 hex>` or `name@sha256:<digest>` | none; required when `enabled` | The trainer image, named by content: a tag is refused, because a tag can be moved. Build it once with `docker build -q brain-trainer/` and put the id it prints here; a rebuilt image has a new id, so the config changes with it |
| `run_hour` | integer 0-23 | `3` | The nightly run starts at this local hour, once a day |
| `min_labels` | integer 20-100000 | `100` | Below this many usable labels a run only writes its report: no container starts, no model is made |
| `test_fraction` | number 0.05-0.5 | `0.2` | The newest share of the decisions, by time, held out as the test window |
| `min_test` | integer | `10` | A test window under this is not scored (the run reports `split_too_small`) |
| `confidence_floor` | number 0-1 | `0.7` | A proposal below it is an abstain, in the bench and in the trace |
| `timeout_minutes` | integer 1-240 | `15` | The container ends itself ten seconds sooner (an alarm inside it); one still running after this is killed by its exact name (then `docker rm -f`), and the run fails. A container that cannot be stopped is a failed run that says so |
| `shadow` | boolean | `true` | Whether the best model writes proposals into the trace |
| `cases_file` | absolute path | none | Extra labelled cases (the bench's JSON Lines, each with `at`, and `outcome` where known), read through the same file checks as `server.yaml` |

The file is read again at every use, through the checks of the rest of `server.yaml`; a refused file turns the trainer off and the status says why.

**Labels.** An answered decision is a label when a person chose its option; a default applied at expiry, a withdrawn decision and an open one are not. A decision with a single option is an acknowledgement, not a choice: it is never a label and the report counts it as `notices`. A decision raised before the cutoff but answered after it is not a training row (`lateAnswers`). An inbox decision carries an `outcome` when the [outcome tracker](#outcome-tracker) is on (otherwise it is `unknown`), and a case in the cases file can carry one too; `outcome: bad` from either is a negative label. `outcome: bad` on a case marks an answer that turned out wrong: it is never a positive label, and a proposal equal to it for the same evidence (the same class and features, older than the test window) is refused as an abstain. `outcome: pending` is not a label until it is resolved. Only structured fields become features: the class (`module/kind/option ids`), the module, the offered and the recommended option ids, the evidence fields of a case (numbers, flags, and short identifier-like strings), and the hour of the day. A title, a context or a note never reaches a feature.

**The time split.** Decisions are sorted by the time they were raised, and cut at a time, not at a position: everything strictly before the cutoff trains, everything at or after it tests. Decisions of the same instant therefore never fall on both sides, and no newer decision can reach the training set. The run keeps the cutoff in its report.

**The container.** The fit runs in `lair-brain-trainer` (`brain-trainer/`: Python with scikit-learn's gradient boosting, every dependency pinned in `requirements.txt`). The image is built from a base pinned by digest, and its dependencies are installed with `--require-hashes` (every wheel's sha256 is in `requirements.txt`). Lair starts it with `--network none`, `--pull never`, a read-only root, all capabilities dropped, 2 GB of memory with no swap, 2 CPUs and 256 processes, no environment from the host, and two mounts: the input rows read-only at `/in`, and a separate directory at `/out` that receives `model.json`. It never runs as root: it runs as Lair's own user, and Lair refuses to start it when that is uid 0 (run Lair as a regular user). A file the container writes must be a plain file under the size limit, never a link. The model comes back as trees in a JSON file, which Lair validates as untrusted input (bounded size, node counts, child indexes that always point forward) and evaluates itself: no Python is needed to make a proposal, and each proposal takes microseconds.

**Versions.** Each trained run keeps `data/brain/models/m-<UTC time>/model.json` and `report.json`; a version is never overwritten (a second run in the same second becomes `...-2`), and `data/brain/runs.jsonl` lists every run, including the ones that only reported. `data/brain/best.json` names the model that shadows: it moves to a new model only when that model is strictly better on its own test window (accuracy, then fewer wrong-but-confident answers). That is not a promotion: it changes only which model writes proposals.

**The report** is the brain bench's, per class (`module/kind/option ids`, or the `class`/`title_class` a case carries): accuracy, abstain rate and wrong-but-confident rate for the classifier and, beside it, for Lair's own recommended option on the same window, which is the bar to beat. **The shadow trace** (`data/brain/shadow-trace.jsonl`) holds `{decisionId, class, proposer, version, option, reasonCode, confidence, at}` per decision raised (`option` is `null` for an abstain); once a decision is answered, the status compares them: per class and version, proposals compared, agreed, abstained and wrong-but-confident.

**Routes (owner only).** `GET /api/owner/brain-trainer` returns the status: whether it is on, the runs over time with their reports (the curve), the model that shadows, the shadow agreement per class, and `skipped`, the number of lines in the run history and the trace that could not be read and were left out. A run's `reason` is a fixed sentence with a `reasonCode`; paths and the container's own output stay out of it (the detail goes to Lair's log). `POST /api/owner/brain-trainer/run` starts a run now in the background (`202`; `409` while it is off or a run is going).

**Not built yet:** the weekly LoRA run for a local language model (stage D), and the Decisions view's chart of the curve; both are tracked as follow-ups.

## Outcome tracker

The outcome tracker watches what happens after each answered decision and records whether the answer turned out `good`, `bad` or `unknown`, with structured evidence, on the decision itself (`outcome`, `outcomeAt`, `outcomeEvidence`, shown by `GET /api/decisions` and `/api/decisions/:id`). The [brain trainer](#brain-trainer) reads `outcome: bad` as a negative example. It is read-only towards the rest of Lair: it never answers, retries, reverts or changes a decision, and the only things it writes are the outcome fields and one `decision.outcome` event. It is off until `data/server.yaml` says otherwise, and it adds no route.

```yaml
outcome_tracker:
  enabled: true
  check_minutes: 10     # how often answers waiting for a verdict are looked at
  restart_hours: 24
  hold_hours: 6
  release_hours: 24
  planner_hours: 72
  merge_hours: 24
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Nothing is opened, subscribed to or written while this is off (`data/outcomes.db` is not created) |
| `check_minutes` | number 1-1440 | `10` | How often answered decisions without an outcome are judged. A server restart judges them at once |
| `restart_hours` | number 0.1-720 | `24` | Window after an agent restart answer |
| `hold_hours` | number 0.1-720 | `6` | Window after a wait / hold answer |
| `release_hours` | number 0.1-720 | `24` | Window after a release / stand-down answer |
| `planner_hours` | number 0.1-720 | `72` | Window after a planner proposal answer |
| `merge_hours` | number 0.1-720 | `24` | Window after a released merge hold |

The section is read when the server starts; a refused file or section leaves the tracker off and logs why.

**Rules.** Each rule is a small function over one answer and the facts that followed it, in the window after the answer (the answer's own instant is not in it; the window's last instant is). The first fact that settles it, in time order, decides. A fact is a code and an id taken from a bus event, kept in `data/outcomes.db` (so a restart in the middle of a window loses nothing) for the longest window plus a day. Anything a rule cannot judge is `unknown`: at once when no rule applies, otherwise when the window ends with nothing settled. An answer that Lair applied by itself at expiry is no label and gets no outcome.

| Answer | Good | Bad |
|---|---|---|
| Agent restart (`fresh_session` on an escalation) | a run of the task completes, or its line is marked done | the task fails again, or is escalated again |
| Wait / hold (`wait` by the agents module) | a run of the held task starts (the cause cleared) | the same hold (same module, key family and task) is raised again |
| Release / stand-down (`release`, `stop` by the agents module) | never recorded | the same task is escalated again |
| Planner proposals applied (`approve_all`, `follow_verifier`) | every task the planner added right after the answer is done | one of them is dropped or reworded after it was applied |
| A released merge hold on a pull request (a ref ending `:pr:<number>`) | never recorded | the merged commit turns the default branch red (`triage.culprit_found`) or is reverted (`triage.revert_requested`); the evidence says `review_miss` |

Facts come from `agent.recovery`, `agent.run.started`, `agent.run.ended`, `decision.raised`, `planner.changed`, `review.merged`, `triage.culprit_found` and `triage.revert_requested`. A "good" for a release or a merge would be a guess, so those end `unknown` when nothing went wrong. Evidence holds codes and ids only (`rule`, `fact`, `factAt`, `task`, `pr`, counts); no title, context, note or agent output.

**One outcome per answer.** The store records an outcome only while the decision has none, and only for the answer made at that time, so a repeat check, a restart or a decision undone and answered again never produces a second or a stale outcome. Each answered decision is judged on its own: a failure before a later answer does not count for it.

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

## Settings

The **Settings** view edits every key on this page, for the owner only (reads included: a config reveals paths and commands). It writes the project's YAML file itself, so a hand edit and a Settings edit are the same thing to Lair. Design: [docs/design/settings-ui.md](design/settings-ui.md) (the write path) and [docs/design/settings-v2.md](design/settings-v2.md) (the pages).

- **Pages, by task.** The list on the left has **Overview**, **AI** and **Team**, then **All settings (classic)**, **YAML** and **History**. Each page has its own URL (`#/settings?tab=ai`; `#/settings/<key>?tab=classic` opens the page at that field), and every page edits the same draft, so you can change things on several pages and save them together. The pages that are not rebuilt yet (work, gates, machines, reviews, notifications, delivery, advanced) are reached through All settings (classic) until then.
- **Overview** is a setup checklist, read-only: the repository (a git work tree, its GitHub remote), the AI tools signed in (`GET /api/ai/tools`), the agents, gates, machines (and whether they answer), notifications and reviews. Each part says ok, attention or off with one line, and links to where it is set. It shows no secret and nothing of a tool's output.
- **AI** has three parts ([AI tools, profiles and roles](#ai-tools-profiles-and-roles)):
  - **Tools:** each tool in use, per machine: installed, its version and whether it is signed in, with the exact command that fixes it ("Run `kiro-cli login` in a terminal on this machine"). **Refresh** runs the checks again now. The other tools Lair can start are listed below.
  - **Profiles:** added and edited in a drawer. **Tool** lists the presets, then the project's own adapters. **Model** lists the chosen tool's own models (its `models_cmd`, else its known list), each with the tool's notes and its default marked, and is filled again when the tool changes. **Other…** takes any model id, with a warning when the tool doesn't list it; it is saved anyway.
  - **Roles:** who builds, who reviews RED, AMBER and GREEN, who plans and who supervises. Each is an ordered list of profiles, the first used and the rest its fallbacks, with a dropdown per place, Up, Down, Remove and "Add a fallback". These edit `ai.profiles` and `ai.roles`.
- **Team** lists the agents (`dragons:`): name, role, profile (or tool and model), machine and state. A row opens its drawer, where the agent runs on a profile, on a tool and a model of its own (the model from that tool's list, as above), or on its role's first profile. Select rows, then **Move** them to a profile at once: each one's own tool and model are dropped.
- **Search** (⌘K, or Ctrl+K, inside Settings) finds any field by its label, its help text or its YAML key, advanced ones included, and opens it on its page, unfolded and focused.
- **One save bar.** While anything is changed, a bar at the bottom says how many changes there are, with **Review and save** and **Discard**. Review and save opens a drawer that runs the dry run and shows the keys that change, the diff, every error, and the commands and sensitive fields to confirm; **Save** is enabled once the dry run passes (and the confirmation is ticked). Edit either the forms or the YAML at a time: the other waits until the change is saved or discarded.
- **Forms** are drawn from each module's own schema: a section per module with its `enabled` switch, defaults shown as placeholders (clear a field to go back to its default), and errors under the field they belong to. Each field has a level in the registry: basic fields show, advanced and expert ones are folded under "Show advanced". Keys no section knows are kept as they are and shown read-only. The **YAML** page edits the whole file with the same checks.
- **Nothing invalid is written.** A change is checked first by the same parsers startup and [live reload](#live-config-reload) use; a refused change leaves the file untouched. A saved change is applied by live reload at once.
- **Only the changed lines change.** A form save edits the file's own text where it can: a changed value, a key removed from or added to a map (a new entry among one-line `{ ... }` entries is written like them). Every other line stays byte for byte: padded flow maps, comments aligned with several spaces, multi-line flow maps, list indentation. A change that can't be made that way (a list that grows or shrinks, a new nested block) writes the file from its parsed form instead: comments and key order still stay, and flow maps keep their padding when the file pads them. YAML anchors are kept too: changing an anchored value (`&name`) from the form changes every alias of it (`*name`), and changing an alias replaces only that alias with the new value (a key inside an alias is edited in the YAML tab).
- **No silent overwrite.** A save names the version of the file it started from. If the file changed since (a hand edit, another browser), it is refused (HTTP 409) with what saving would now change, and the review drawer offers to review the same changes again on top of the current file.
- **Commands are confirmed.** A change that adds or changes something Lair runs (any `*_cmd` key, adapters' `start_cmd` and `stop_cmd`, watchdog `actions`, triage `commands`, placement's `probe`, `load_cmd` and `move_cmd`, a step's `run`, a process's `command`, `gate_script`...) shows the exact argv lists and needs your confirmation; the server refuses it without (HTTP 428). So does a change to a field that decides what Lair runs or where it sends code and tokens: a machine's `host`, `user` and `key`, an environment's `compose_files`, `project_directory` and `deploy.repo`, `executors.github.checkout_action`, `review.api_url` and `review.merge.clone_url`, and a cloud machine's `profile` and `instance` and the cloud budget's `limit` and `period` (which account and instance Lair acts on, and how much it may spend).
- **No secrets.** A value whose key names a secret (`token`, `password`, `api_key`, `private_key`...) or that looks like one (a private key, a known token format, a URL with a password) is refused. Keep secrets in a file under `data/` (mode 0600) or an environment variable and name it in the config (`token_env`, `*_file`); the view shows whether the ones Lair knows are set, never their values. Comments are scanned too, for values shaped like a secret (a comment has no key to go by), and no error message ever quotes a secret.
- **History.** Every accepted version is kept in `data/config-history/<project>/` (the newest 50) with when and which owner session (its public id) made it; a version Settings finds on disk that it didn't write, such as a hand edit, is kept too before it is replaced. If that version holds something that is or looks like a secret, only a note of it (when, its hash) is kept, never its text, so it can't be restored. Each shows its diff, and **Restore** saves it again through the same checks.
- **Files.** Writes are atomic (a temporary file, `fsync`, `rename`). A project file that is a symlink, a `projects/local/` that is one, or anything but a regular file is refused. A save is at most 1 MiB, like the file.
- **New project** asks for an id, a name and a repository (a git work tree; its GitHub `owner/name` is read from `git remote -v`), proposes `<repo>/work/queue.md`, `<repo>/work/agents` and `<repo>/work/gates`, and switches on the modules you pick with their defaults. It writes `projects/local/<id>.yaml`.

| Route (owner only) | What |
|---|---|
| `GET /api/settings/modules` | the sections: their JSON Schema and hints |
| `GET /api/settings/projects`, `GET /api/settings/projects/:id` | the projects; one project's text, hash, values, problems, unknown keys and secret status |
| `PUT /api/settings/projects/:id` | save `{baseHash, changes \| yaml, confirmCommands?}`: 200, or 409, 413, 422, 428 with the check |
| `POST /api/settings/validate` | the same checks as a dry run (`{project, ...}`, `{project, restore, baseHash}` or `{create: {...}}`) |
| `POST /api/settings/projects` | create a project |
| `POST /api/settings/repo` | check a repository path |
| `GET /api/settings/projects/:id/history`, `.../history/:version`, `POST .../history/:version/restore` | the versions, one with its diffs, restoring one |

## Configuration lookup

Lair looks for project configurations in this order:

1. `projects/local/<name>.yaml`, then `projects/local/<name>.yml` — Private configs (gitignored)
2. `projects/<name>.yaml`, then `projects/<name>.yml` — Public configs

The first matching file is used. The server and the fleet bus (`npm run bus`) both load files ending in `.yaml` or `.yml`. Start Lair from the repository root: `projects/` and `data/` are found from the current directory, and the relative paths in `projects/example.yaml` (such as `./fixtures/queue.md`) assume it.

Project names (the file name without `.yaml` or `.yml`) must start with a letter or digit and contain only letters, digits, `.`, `_` and `-`; files with other names are not listed. API requests with an invalid or unknown `?project=` are refused with HTTP 400.

## Live config reload

The server watches `projects/` and `projects/local/`. When a project file changes (or a new one appears), it waits until the file has been quiet for a second, then reads it and checks it with every module's own parser, the same checks as at startup:

- **Valid:** only the modules whose part of the file changed are reloaded, each for that project only. A module's part is its own block (`watchdog:`, `delivery:`, `pipelines:` and `executors:`, `review:`, `agents:`, `triage:`, `placement:`, `planner:`, `supervisor:`), the blocks it also reads (the agents module reads `watchdog:`, the planner `agents:`), and every other top-level key a module may read (`repo`, `read_only`, `dragons`, `machines`, `agents_dir`, `outbox_file`...), so a change to one of those reloads every module of the project. Keys no module reads reload nothing: the dashboard's commands (`*_cmd`, `allow_direct_assign`, `backlog_file`), `merge_bar`, `processes`, `orchestrator`, `available_models` and `gate_runner`. Editing only a comment reloads nothing. The dashboard's reads use the new file from the next request.
- **Invalid** (YAML errors, missing required fields, any module's parser refusing its block, a file that is not a regular file or is over 1 MiB): nothing changes, and the modules keep running the previous config. The error is logged, emitted as a `config.invalid` event, and shown in a banner on the dashboard: "projects/x.yaml has an error; the previous config is still running: ..." until the file is fixed.
- **Another file:** the modules keep running the file they started with. When it is deleted (deleting `projects/local/x.yaml` would otherwise fall back to the public `projects/x.yaml`), or a new file takes its place (a new `projects/local/x.yaml`), nothing changes and the banner says so; restart Lair to switch files. Deleting a project's only file also keeps its previous config running until a restart.

Files changed between the server's startup and the moment it starts watching are checked once the watcher is ready, so no change is missed.

A module is reloaded by stopping its instance for the project cleanly and starting it with the new config:

| Module | What happens to work in progress |
|--------|----------------------------------|
| watchdog | As on shutdown: a tick in progress ends early and no further action starts |
| delivery | The operation in progress (Up, Deploy...) runs to the end, its commands are not killed; new operations get HTTP 409 until the new config runs |
| pipelines | Jobs in flight keep running: the attempt running now finishes with the settings it started with, and the job's next step uses the new ones |
| review | A merge in progress finishes; a merge asked for meanwhile gets HTTP 503 (a shutdown waits for it too, so its record is written) |
| agents | The agents keep running; the new config re-adopts them by pid, as after a restart |
| triage | The tick, ingests and outbox in progress finish first |
| placement | As on shutdown: a probe or `move_cmd` in progress is cut short, and a move it cut short is found again by the new instance's first tick. Learned durations, moves and cool-downs are kept (they are in the store); probe history starts again, so a machine is up again only after `min_up_seconds` |
| supervisor | A round of checks in progress finishes; the next one, a few seconds later, runs with the new settings. A check turned off withdraws its open notice |

Reloads of one module for one project never overlap: a change made while one runs is applied after it, with the latest file (also when the latest file is the one that ran before). A module that fails to start with the new config (for example, its store can't be opened) is started again with the previous one, and the banner says so; it is never left half-started.

Not reloaded: the process manager (`processes:`, read at startup for the default project) and the dashboard's project list (reload the page to see a new project). Restart Lair for those (see [Restart and update](#restart-and-update)). `GET /api/config/status` lists the files whose latest version is not running and the latest reloads.

## Restart and update

The footer of the dashboard has **Restart** and, when `server.update_cmd` is set, **Update and restart**. Both are for the owner only (`POST /api/owner/restart`, which needs the owner's session) and ask for confirmation.

Restart answers HTTP 202, then shuts Lair down gracefully (as on `SIGTERM`: the modules stop, a merge in progress finishes, the agents keep running, the managed processes are stopped) and exits with code 0. A shutdown that takes more than 60 seconds is given up on, and the process exits anyway (on `SIGTERM` and `SIGINT` too). While a merge or a delivery operation runs, Restart answers HTTP 409 and names it; after an update, the restart waits up to two minutes for one that started meanwhile.

**Something must start it again**: a service manager such as launchd with `KeepAlive` set to true, or systemd with `Restart=always`. Without one the process just exits. Lair looks for one: systemd sets `INVOCATION_ID`, but a terminal of a systemd user session inherits it, so it counts only beside `JOURNAL_STREAM` or a parent pid of 1; launchd sets `XPC_SERVICE_NAME`. What it finds is only probable, and the dashboard says so beside the buttons when it can't tell; set `server.service_manager` to be sure. Note that launchd's `KeepAlive` with `SuccessfulExit: false` and systemd's `Restart=on-failure` do **not** restart after exit code 0.

Update and restart first runs `server.update_cmd` from `data/server.yaml`, Lair's own config. Whoever can write that file can run commands as Lair, so Lair reads it only when it is a regular file (not a symbolic link, a FIFO or a directory), owned by the user Lair runs as, and not writable by its group or others (`chmod 600 data/server.yaml`); otherwise Update and restart is refused and the dashboard shows why. That protects it only as far as Lair's directory is protected: it sits beside the owner token and in no project's repository, but the agents Lair supervises run as the same OS user unless you sandbox them, and such an agent can write any file that user can.

```yaml
server:
  # One argv, or a list of argvs run in order. Never through a shell.
  update_cmd:
    - ["git", "pull", "--ff-only"]
    - ["npm", "ci"]
    - ["npm", "run", "build"]
  update_timeout_seconds: 900   # per step (10 to 7200)
  # What starts Lair again: launchd, systemd or none (default: detected)
  service_manager: launchd
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `update_cmd` | argv or list of argv | — | The update's steps, run from Lair's directory. The first word of a step can't start with `-` |
| `update_timeout_seconds` | integer | `900` | A step still running after this long is stopped (with its child processes), and the update fails |
| `service_manager` | `launchd`, `systemd` or `none` | detected | Says what starts Lair again, when the detection is wrong |

The steps get the server's environment without its `LAIR_*` variables and without the token variables the projects name (`review.token_env` where reviews are on, `executors.github.token_env` where pipelines are configured, `agents.env_passthrough` where the agents module is on). Their output goes to the server's log line by line and is shown in the dashboard. When a step fails (a non-zero exit, a timeout, a command that can't start), the update stops there, nothing restarts, and the error is shown. The file is read at each use, so changing it needs no restart. `GET /api/owner/restart` (owner only) returns the state, the steps, the service manager and the update's latest output.

## Notifications

Lair can tell you when something needs your answer, on this machine's desktop and on your phone (through [ntfy](https://ntfy.sh)), so you don't have to keep the dashboard open. It is off until you turn a channel on, in **Settings → Notifications** (the owner only) or in `data/server.yaml`, Lair's own config. Notifications are never configured in a project's YAML.

```yaml
notifications:
  desktop: true                        # macOS: osascript; Linux: notify-send, when it is installed
  ntfy:                                # optional phone push
    url: https://ntfy.sh/<topic>       # or your self-hosted ntfy
    token_file: ntfy.token             # optional; relative to data/
  reminder_hours: 4                    # daily reminder while action items stay open longer (0: off)
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `desktop` | boolean | `false` | Show a desktop notification. On macOS through `osascript`, on Linux through `notify-send` (libnotify) when it is on `PATH`; elsewhere this channel reports that it can't |
| `ntfy.url` | https URL | — | Your ntfy topic: `https://ntfy.sh/<topic>` or a self-hosted server. `http://` only to this machine (`localhost`, `127.0.0.1`, `[::1]`), so the token and the titles never cross a network in the clear. Use a topic nobody can guess, or a protected one with `token_file`. No user or password in the URL |
| `ntfy.token_file` | path | — | A file holding an ntfy access token, sent as `Authorization: Bearer`. It is never shown in the dashboard, returned by the API or logged |
| `reminder_hours` | integer, 0 to 168 | `4` | Remind you once a day while action items have been open longer than this; `0` turns the reminder off |

**When Lair notifies.** A new decision that needs your answer (an **action** item, see [Decision Inbox](#decision-inbox)) notifies within a minute. A **notice** (for your information, nothing to choose) never notifies. At most one notification goes out per minute: items raised together, or within a minute of the last notification, go out as one, as "Lair: 3 things need you". One item reads "Lair: kiro-7 is paused: its last run failed while Lair was restarting, needs you". An item answered or withdrawn before its turn is left out. The same hold asked again (its decision withdrawn, then raised again: a line edited out and back, say) doesn't notify again within `reminder_hours` (a day with the reminder off). While action items stay open longer than `reminder_hours`, Lair reminds you once a day ("Lair: 2 things still need you"); the time of the last reminder is kept in `data/notifications-state.json`, so a restart doesn't send another. Each notification links to the dashboard: the decision itself (`#/decisions/<id>`) for one item, the Decision Inbox for several.

**What a notification holds.** The item's title (a plain sentence, at most 120 characters with control characters removed) and the dashboard link. Never a decision's context, a log line or a secret.

**Safety.** `data/server.yaml` is read again at every use (a change needs no restart) through the same checks as for Restart: a regular file, not a symbolic link, owned by the user Lair runs as, and not writable by its group or others; a file that fails them turns notifications off, and Settings says why. The token file gets the same checks, and must not be readable by its group or others either (`chmod 600`). Commands are argv arrays, never a shell: on macOS the title and text reach a constant AppleScript only as its arguments (`osascript -e 'on run argv' ... <title> <text>`), and `notify-send` gets them after `--`. Each command and each ntfy request has a 10 second timeout. A channel that fails (an error, a non-zero exit, no answer, an HTTP error) is logged once per distinct problem and never holds anything up.

**Settings.** The Notifications card turns desktop notifications on or off, sets the ntfy topic and the reminder hours, and has **Send test notification**, which sends "Lair: test notification" through every channel that is on and shows what each did. Saving writes only the `notifications:` section of `data/server.yaml` (every other key and comment stays as it was, a `token_file` set in the file is kept) atomically, and leaves the file `0600`; a file that fails the checks above is refused, not overwritten. The routes are owner only: `GET /api/owner/notifications` (the settings, why the file was refused, whether desktop notifications work here, and the last send's results), `PUT /api/owner/notifications` (`{desktop, ntfyUrl, reminderHours}`), and `POST /api/owner/notifications/test` (`409` while notifications are off).

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
| `LAIR_OPS_TOKEN` | lair ops-mcp | An [ops token](#the-ops-api): one minted for a supervisor run, or yours from Home → Health (required). Never printed |
| `LAIR_URL` | lair ops-mcp, lair review submit | The Lair server (default `http://127.0.0.1:4777`) |
| `LAIR_GITHUB_TOKEN` | server | A fine-grained GitHub token for running gate pipelines on GitHub Actions (see [Gate pipelines](#gate-pipelines)). A project can name another variable with `executors.github.token_env`. Never passed to local steps |

The server refuses, with HTTP 403, browser requests whose `Origin` is not one of its own (`http://localhost`, `http://127.0.0.1` or `http://[::1]` on port 4777 or 5173, plus `LAIR_HOST`) and requests whose `Host` header names another host (DNS rebinding). Requests without an `Origin` header, such as `curl` or lair-node, are allowed. WebSocket handshakes get the same `Origin` check.
