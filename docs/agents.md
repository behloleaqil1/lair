# Connecting Agents

Lair is agent-agnostic: it works with any CLI-based AI coding agent, such as Kiro, Claude Code or Aider (Kiro is the only one tested so far). This guide explains how to connect and configure agents.

## How Lair monitors agents

Lair monitors agents through **file-based status reporting**. Agents write their status to markdown files, and Lair parses these files to determine:

- Which agents are running
- What task each agent is working on
- Recent activity (WAITING, DONE, BLOCKED)
- Agent statistics (pass rates, gate submissions)

## Queue file format

Agents report status by appending lines to the queue file. Each line follows this format:

```markdown
- WAITING task-name gate-id by kiro-A (Smaug) 14:30Z: summary message
- DONE task-name by kiro-A (Smaug) 15:45Z: completed with sha abc1234
- BLOCKED task-name by kiro-A (Smaug) 16:00Z: reason for block
- PROGRESS task-name chunk 2 by kiro-A (Smaug) 16:30Z: progress update
```

### Line types

| Type | Description |
|------|-------------|
| `WAITING` | Agent is waiting for a gate or review |
| `DONE` | Task completed successfully |
| `BLOCKED` | Task is blocked, needs intervention |
| `PROGRESS` | Intermediate progress on a multi-part task |
| `TICK` | Orchestrator heartbeat (from the orchestrator, not agents) |

### Required fields

- **task**: The task identifier (e.g., `feature-login`, `fix-123`)
- **agent**: The agent ID with optional display name (e.g., `kiro-A`, `kiro-A (Smaug)`)
- **timestamp**: UTC time in HH:MMZ format
- **summary**: Brief description of the status

## Agent adapters

An adapter describes an AI coding tool: command templates to start and stop it, and how it reports status. Lair ships a few built-in adapters and lets you define your own. Each dragon names its adapter with `adapter:` (default `kiro`).

Today adapters are **descriptive**: Lair lists them in the Settings view and in the dragon management config, and validates that every dragon names a known adapter. Starting and stopping a dragon from the UI runs your project's `dragon_start_cmd` and `dragon_stop_cmd` (see [Setting up an agent](#setting-up-an-agent)), not the adapter's templates.

### Built-in adapters

| ID | Tool | Status method | Status |
|----|------|---------------|--------|
| `kiro` | Kiro CLI | `file` | Used and tested |
| `aider` | Aider | `file` | Experimental, untested |
| `claude-code` | Claude Code | `stdout` | Experimental, untested |
| `cursor-agent` | Cursor Agent | `mcp` | Experimental, untested |
| `codex` | Codex CLI | `file` | Experimental, untested |
| `gemini` | Gemini CLI | `file` | Experimental, untested |
| `opencode` | OpenCode | `file` | Experimental, untested |
| `goose` | Goose | `file` | Experimental, untested |
| `copilot` | GitHub Copilot CLI | `file` | Experimental, untested |

How each one lists its models and checks its sign-in: [Tool presets](configuration.md#tool-presets). A dragon can also name an [AI profile](configuration.md#ai-tools-profiles-and-roles) (a tool and a model) instead of an adapter and a model.

The exact command templates may change between releases; the current definitions are in [`src/server/services/adapters.ts`](../src/server/services/adapters.ts). Check them against your tool's own CLI documentation before relying on them, and override any built-in adapter in your project config (below) if its flags don't match your installed version.

### Custom adapters

Define custom adapters, or override a built-in one by reusing its ID, in your project config:

```yaml
agent_adapters:
  my-agent:
    name: My Custom Agent
    start_cmd: my-agent --prompt {prompt_file} --output {output_dir}
    stop_cmd: kill -INT {pid}
    status_method: file
    queue_file: work/agent-queue.md
    log_dir: work/agent-logs
    session_id_env: MY_AGENT_SESSION
    resume_flag: --resume {session_id}
```

### Adapter options

| Option | Type | Description |
|--------|------|-------------|
| `id` | string | Unique identifier (defaults to the key under `agent_adapters`) |
| `name` | string | Display name (defaults to the ID) |
| `start_cmd` | string | Command template to start the agent (required) |
| `stop_cmd` | string | Command template to stop the agent (required) |
| `status_method` | `file` \| `stdout` \| `mcp` | How status is reported (default `file`) |
| `queue_file` | string | Path to queue/status file, relative to the project root (for `file`) |
| `log_dir` | string | Path to log directory, relative to the project root (for `file`) |
| `status_pattern` | string | Regex matching JSON status lines (for `stdout`) |
| `mcp_endpoint` | string | MCP endpoint, e.g. `stdio` (for `mcp`) |
| `session_id_env` | string | Environment variable that carries the session ID |
| `resume_flag` | string | Flag to resume a session, with a `{session_id}` placeholder |
| `models_cmd`, `models_parser`, `models` | | How the tool's models are listed ([Tool presets](configuration.md#tool-presets)) |
| `auth_check_cmd`, `login_hint`, `version_cmd`, `experimental` | | Its sign-in check, the command that signs it in, its version, and whether it is experimental |

The program (a template's first argument) never comes from a placeholder, and a placeholder that starts an argument is refused when its value starts with `-`, so no value becomes the program or an option.

### Command placeholders

| Placeholder | Description |
|-------------|-------------|
| `{agent_id}` | Dragon ID (e.g. `kiro-A`) |
| `{agent_name}` | Dragon display name |
| `{task}` | Task identifier |
| `{prompt_file}` | Path to the prompt/task file |
| `{model}` | AI model ID |
| `{agent_profile}` | Agent profile name |
| `{session_id}` | Session identifier |
| `{session_dir}` | Path to the session directory |
| `{output_dir}` | Path to the output directory |
| `{pid}` | Process ID (for stop commands) |

Templates are split into arguments first (whitespace separates them; single or double quotes keep text together) and placeholders are substituted inside each argument, so a value always stays one argument. Commands never run through a shell. Values that contain shell metacharacters are not substituted at all.

## Setting up an agent

### 1. Define the agent in your project config

```yaml
dragons:
  kiro-A:
    name: Smaug
    model: claude-opus-4.5
    machine: local
    adapter: kiro
    instructions: |
      Follow the project conventions.
      Run tests before committing.
  aider-1:
    name: Saphira
    adapter: aider
```

The key is the dragon's ID. Any ID that starts with a letter and uses only letters, digits, `_` and `-` (at most 64 characters, ending in a letter or digit) works; entries with other IDs are skipped.

### 2. Configure the start/stop commands

Controls must be enabled (`read_only: false`) for the Start and Stop buttons to work.

```yaml
dragon_start_cmd: ["./bin/dragon-start.sh", "{dragon}", "{task}", "{prompt_file}"]
dragon_stop_cmd: ["./bin/dragon-stop.sh", "{dragon}"]
```

Lair runs these commands as argument arrays (no shell) on the machine where the server runs. `{dragon}`, `{task}` and `{prompt_file}` are substituted; the start command also gets the environment variables `TASK`, and `MODEL` and `EXTRA_INSTRUCTIONS` when they are set in the start dialog. Lair writes the prompt to a file in `prompts_dir` (default `data/prompts`, relative to the directory Lair was started from) and passes its path as `{prompt_file}`.

### 3. Write a start script

Example `dragon-start.sh`. Replace the placeholder command with your agent's own CLI and flags:

```bash
#!/bin/bash
DRAGON=$1
TASK=$2
PROMPT_FILE=$3

# Create session directory
SESSION_DIR="./sessions/$DRAGON"
mkdir -p "$SESSION_DIR"

# Start the agent in the background (placeholder command)
your-agent-cli --model "${MODEL:-default}" "$PROMPT_FILE" \
  > "$SESSION_DIR/run.log" 2>&1 &

echo $! > "$SESSION_DIR/pid"
```

### 4. Ensure agents write to the queue

Agents must append status lines to the queue file. Tell the agent to do so in its instructions, connect it to the fleet bus (below), which mirrors every report into the queue file, or write a wrapper that turns the agent's output into queue lines.

## Fleet bus (MCP)

For tighter integration, agents can connect to Lair's fleet bus, an MCP (Model Context Protocol) server that talks over stdio. The bus is not published on npm; run it from your Lair checkout:

```bash
cd /path/to/lair
LAIR_AGENT_ID=kiro-A npm run --silent bus -- --project myproject
```

Run it from the Lair repository root: the bus stores its database in `data/<project name>.db` relative to the current directory, and the Lair server reads the same file to show the activity feed. Keep `--silent` so npm's banner doesn't end up on stdout, which carries the MCP protocol.

Most agents start MCP servers themselves from a config file. A typical entry looks like this (the exact file and format depend on your agent):

```json
{
  "mcpServers": {
    "lair": {
      "command": "npm",
      "args": ["run", "--silent", "--prefix", "/path/to/lair", "bus", "--", "--project", "myproject"],
      "env": { "LAIR_AGENT_ID": "kiro-A" }
    }
  }
}
```

After `npm run build` you can use `node /path/to/lair/dist/bus/cli.js --project myproject` instead, but the current directory still decides where the database goes.

### MCP tools

| Tool | Description |
|------|-------------|
| `whoami()` | Get agent identity and current claims |
| `claim(task)` | Claim ownership of a task (atomic) |
| `release(task)` | Release a task claim |
| `report(kind, task, summary)` | Report status (WAITING, DONE, BLOCKED, PROGRESS, TICK) |
| `inbox()` | Get unread messages for this agent |
| `ack(message_id, note)` | Acknowledge a message |
| `send(to, text, priority)` | Send a message to orchestrator or owner |
| `board()` | Get the full board state |

The fleet bus ensures atomic task claims (no two agents can claim the same task) and provides instant updates to the UI.

## Monitoring agent health

Lair detects common problems:

- **Silent agent**: No log activity for extended period
- **Stale run**: Agent marked running but no recent output
- **Duplicate claims**: Multiple agents claiming same task (prevented by fleet bus)

These appear in the Overview as warnings.

## Multi-machine agents

Machines are configured in the project config, and a dragon can name the machine it runs on:

```yaml
machines:
  build-server:
    name: Build Server
    type: ssh
    host: 198.51.100.10
    user: deploy
    key: ~/.ssh/example_key
    kiro_cli: /usr/local/bin/kiro-cli

dragons:
  kiro-B:
    name: Saphira
    machine: build-server
```

Lair uses SSH to check the machine's health and shows it in the Machines view. Lair does not start agents over SSH itself: `dragon_start_cmd` runs on the Lair host, so a start script for a remote dragon must do the SSH step (for example `ssh deploy@198.51.100.10 ...`). Remote agents report status the same way as local ones: through files Lair can read, or through the fleet bus.
