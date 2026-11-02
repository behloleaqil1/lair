# Agent launch contract

- **Status:** design, not built.
- **Base:** main `0debc32`. Every file:line below was re-checked there. The first draft cited `d2b3d8e`; lines that moved since then are given at `0debc32`.
- **Related:** issue #327 (this design), #114 (adapter SDK with a conformance suite), #77, #78, #79 (adapters tested end to end), [phase3-bus.md](phase3-bus.md) (the fleet bus), [checks.md](checks.md) (checks on a runner), [sandbox.md](sandbox.md) (isolation, ROADMAP B4), [ai-spend.md](ai-spend.md) (the run records this spec adds to).

Lair starts agent runs with any of nine adapters. What a run is given today depends on the adapter, on how the owner set up that agent's tool by hand, and on free-text rules in `default_instructions`. When one of those is missing, the run still starts, and the agent fills the gap by guessing. This spec defines a **launch contract**: a fixed list of things every launch gives an agent, built by Lair from config, recorded on the run, checked before the spawn, watched after it, and pinned by a contract test for each adapter.

The contract has seven parts:

1. **Bus:** a bus token, the server's address, and the bus MCP server registered in the agent's tool. Or, for a tool without MCP, the `lair bus` command.
2. **Task message:** a header that Lair writes at the top of the prompt. It names the task, the run, the agent, how to report, the one file status lines may go to, the files they must never go to, and what proves a head ready to merge.
3. **Prompt delivery:** the prompt reaches the tool through a file (or stdin), never on the command line.
4. **Push and history rules:** the branch to push, and no force-push, rebase or amend of pushed commits. Lair states them, a git hook refuses the push, and Lair detects the rewrite when it reaches the remote anyway.
5. **Identity and no attribution:** the commit identity comes from the project, not from the worktree's git config. Attribution text is refused at commit time and checked again at merge.
6. **Checks, local and remote:** which check kinds exist, where each one runs, and which commands must not run on the agent's host.
7. **Evidence:** the contract each run got, recorded with no secrets in it, and the gaps Lair saw after the run.

Each part has a mode: `off`, `observe` or `on`. `observe` records what the contract would give and what is missing, and changes nothing about the launch. `on` gives the part. A part marked *required* also refuses to start a run that would lack it. Every part defaults to `off`. An install turns the parts on in `observe` first.

## 1. Why: what one real deployment shows

These numbers come from one project with 16 to 36 agents and from Lair's own repository, over the 12 days to 2 Nov 2026. They were read from the queue file, the tasks file, GitHub's PR timelines, the `main` history of both repositories and the deployment's incident notes.

| Fact | Count |
|---|---|
| Status lines (`- DONE`, `- WAITING`, `- BLOCKED`, `- READY`) written into the **tasks file** (the file Lair reads tasks from) instead of the queue file | 22 of 156 lines in the tasks file. Fill and the planner never read them as reports, so those runs looked like they had no result |
| Status lines in the queue file written by hand, with no `[bus:<id>]` marker, after the bus was rolled out to every agent | 134 hand-written lines and 121 bus lines. Most agents whose tool had no bus server fell back to hand-written lines. The rules said to use the bus, and nothing checked whether the agent could |
| Agents stopped by one agent's name-pattern kill (`pkill -f`) | 23 in one incident. Each agent's whole prompt was on its own command line, so a pattern taken from one task matched every sibling. The deployment's launchers were then changed to pass the prompt as a file, but one of them still put a 2.5 KB block of rules on the command line of the tool it starts |
| Pushes that rewrote a PR branch's history (GitHub `head_ref_force_pushed` events) | 58 events on 33 of the last 200 PRs across the two repositories (one PR had 13). Each one made the reviews and gates at the old head stale, and lost the commits a reviewer had seen |
| `main` commits authored with a placeholder identity from a worktree's local git config | 228 of 322 in one repository, until the config was fixed by hand. The merge guard (`review.merge.allowed_emails`) checks addresses at merge time only. By then the only fix is a history rewrite, which the rules forbid |
| Rules an agent received only as prompt text, with nothing checking them | the report channel, the queue file's path, no force-push, the branch name, the commit identity, no AI attribution, "builds run on the remote runner, not on this host", and which result is the merge signal (agents held READY waiting on the host's CI, which that project does not merge on) |

Six failure patterns follow:

1. **No bus, so status goes to the wrong place.** A run that can't reach the bus writes its status by hand, and sometimes to the wrong file. Lair then classifies the run as having no result, and the task is started again.
2. **The bus token can silently be absent.** When minting the token fails, the run starts anyway, without it (`src/server/bus/wiring.ts:57`).
3. **The prompt on the command line.** Anything on the argv is visible to every process on the host, is matched by name-pattern tools, and is copied into Lair's `started` event (`src/server/agents/service.ts:1625` `evidence: [argv.join(" ")]`, `:1627` `data.argv`).
4. **History rewrites.** A rebase or an amend followed by a force-push invalidates reviews and gates at a sha. The agent then reports READY at a head that nobody reviewed.
5. **Identity from the worktree.** A worktree whose local config has a placeholder name or address produces commits that the merge guard refuses only at the end.
6. **Host rules and the merge signal as prompt text.** Nothing tells the agent which checks run remotely or which result a merge waits for. A rule like "don't build on this host" is only a sentence in the prompt.

## 2. What exists today

The inventory below was found with `git grep` on `github/main` (`0debc32`) over `LAIR_BUS_TOKEN`, `mcpServers`, `queue_file`, `status_method`, `default_instructions`, `allowed_emails`, `identity`, `compare`, `force`, `attribution`, `prompt_file`, `dead_on_start` and `launchFailures` in `src/server/`, `src/cli/` and `docs/`.

| Item | Where | What it does | Gap |
|---|---|---|---|
| Run environment | `src/server/agents/service.ts:1712` `env()`; `src/server/agents/probes.ts:40` `agentEnvironment` | Gives `LAIR_RUN_ID`, `LAIR_TASK`, `LAIR_AGENT`, `LAIR_SESSION_ID`, `LAIR_SESSION_MODE`, `TASK`, `MODEL`, the adapter's `session_id_env`, `env_passthrough` and the module variables. It never passes on the rest of the server's environment | No git identity and no record of what was given |
| Bus token | `service.ts:1727-1732`; `src/server/bus/wiring.ts:40` `wantsTokens`, `:57` | Mints `LAIR_BUS_TOKEN` and sets `LAIR_URL` while `bus.consume` isn't `off` or the project has `checks:` | When minting fails, the run starts without a token (by design today). With the bus off, no run gets a token |
| Bus store | `src/server/bus/store.ts:23` `BUS_SCHEMA_VERSION = 1`; `:33-41` `bus_tokens`; `:45-58` `bus_reports` (with `run_id`); `:62-75` `bus_messages` (with `from_id`, `read_at`, `ack_at`, no `run_id`) | Stores token hashes, reports and messages | A token's use is not recorded. Which runs used the bus can only be derived from reports and messages |
| Module run variables | `service.ts:437` `MODULE_RUN_VARIABLES` | The review, supervisor and bus variables another module may pass to a run | n/a |
| Bus clients | `src/cli/bus-mcp.ts:184`, `src/cli/bus.ts:117`; `package.json` `bin.lair` is `./dist/cli/lair.js`, whose first line is `#!/usr/bin/env node` (`src/cli/lair.ts:1`) | `lair bus-mcp` (MCP over stdio) and `lair bus report`, both reading `LAIR_BUS_TOKEN` and `LAIR_URL` | Nothing registers `lair bus-mcp` in the agent's tool. `lair` finds its interpreter on `PATH` |
| Bus registration docs | `docs/agents.md:177-249`; `docs/design/phase3-bus.md:37-40` | The owner adds an `mcpServers` entry to each agent tool's config by hand | Not checked. A tool without the entry has no bus, and nobody is told |
| Bus mirror | `src/server/bus/mirror.ts:1-17` | Appends each bus report to the queue file with `[bus:<id>]` | n/a |
| Prompt file | `service.ts:1640` `writePrompt` | Writes `default_instructions`, the agent's `instructions`, the resume summary, the run's prompt and a hung-run block to a file; the run gets the path as `{prompt_file}` | No Lair-written header. The report channel and the rules are whatever the instructions say |
| Start command | `service.ts:1686` `startCommand`; `src/server/services/adapters.ts:578` `buildStartCommand` | Builds the argv from the adapter's template, one argument per placeholder. Placeholders are paths and names only (`:582-603`): Lair never puts prompt text on the argv itself | No placeholder for an MCP config file. Nothing checks literal text in an owner's template, or what a wrapper script puts on the argv of the tool it starts |
| Built-in presets' argv | `adapters.ts:81,106,128,144,161,191` | Six presets pass one fixed sentence ("Read the file {prompt_file} and carry out the task it describes.") next to the path | Short and fixed, never the prompt |
| Started event | `service.ts:1619-1636` | Records the whole argv (`evidence` and `data.argv`), pid, session and profile | Anything on the argv is persisted. It does not record which contract parts were given |
| Launch failure | `service.ts:1596-1603` | A spawn error leaves the run `queued`, counts `run.launchFailures` and retries on the next check, every tick, with no delay derived from the count | n/a |
| Start timeout and never-started | `src/server/agents/config.ts:269` `start_timeout_minutes` (default 10); `service.ts:1900-1942` | A run with no live process past `start_timeout_minutes` ends `never_started` with the reason, is retried with backoff, or is escalated (`dead_on_start` code) | n/a: this is the bound a launch refusal reuses (§4.2) |
| Dead on start | `config.ts:271` `dead_on_start_seconds` (default 60); `service.ts:2174-2178` | A process that ends within that time is recovered as `dead_on_start` | It doesn't say which launch change was new on that run |
| Process table | `src/server/watchdog/probes.ts:17-26` `ProcessInfo` (`pid`, `ppid`, `command`) | Each tick reads every process's command line | Never used to look at a run's child processes' argv |
| Built-in adapters | `adapters.ts:32-204` | kiro, aider, claude-code, cursor-agent, codex, gemini, opencode, goose, copilot. The kiro preset runs `--agent {agent_profile}` (`:37`), and `{agent_profile}` is the agent's id (`service.ts:1698`) | Only kiro is tested end to end. The aider preset's `queue_file: .aider/status.md` (`adapters.ts:67`) differs from the project's `queue_file` |
| Adapter status fields | `adapters.ts:478` `validateAdapter`; `src/server/parsers/adapter-config.ts:25-26,64-65` | Validates `status_method` (file, stdout, mcp), `queue_file`, `status_pattern` and `mcp_endpoint` | The run path reads only the project's `queue_file` (`service.ts:2131`). An adapter's `queue_file` is validated and then never used |
| Merge identity and guard | `src/server/review/config.ts:148` `review.merge.identity`, `:149` `allowed_emails`, `:582,639` (allowed emails default to the identity's address); `src/server/review/executor.ts:198` (the refusal) | Refuses a merge when a commit's author, committer or message address isn't in `allowed_emails` | Runs only at merge time. It doesn't check text such as "Generated with". The identity is a review-module key |
| Merge signal | `review/config.ts:141` `review.merge.gate` (`source: checks` with named host checks, `:106-114`, or `source: signed` with Lair gate pipeline ids, `:115-129`), `:152` `hold_when_default_red` | Says what a merge waits for | The agent isn't told |
| Compare API | `src/server/review/github.ts:289` `compare` | Returns `aheadBy` and `behindBy` for two shas | Never used to detect a rewritten head |
| Checks API | `docs/agents.md:251-288`; `src/server/checks/config.ts:61`; `src/server/checks/git.ts:62` `shaOnPushedBranch` | Targeted tests on the Lair server, with the run's bus token, for a pushed sha | The agent isn't told which kinds exist or where they run (`checks.md:149` plans `executor: cloud\|local\|auto`) |
| Module report commands | `src/server/review/agent-assigner.ts:24` and `src/server/review/prompt.ts:75` (`lair review submit`); `src/server/supervisor/chat-prompt.ts:136-147` (`lair supervisor answer`), `src/server/supervisor/config.ts:107` (or an answer file) | Each module's prompt says how its run reports | n/a: the header reuses these (§4.3) |
| Lair's own pushes | `docs/design/importer.md:67` | Lair never force-pushes | Agents' pushes aren't covered |
| Sandbox | `docs/design/sandbox.md` | Planned isolation of runs (B4) | Not built. Every guard below is a guard rail for an agent that makes a mistake, not a defence against one that tries to get around it |

Two more checks found nothing on `0debc32`: `git grep -n -E "launch_contract|launch_gap|history_rewrite|mcp_config|on_argv|prompt_via|exec_commands"` and `git grep -n "hooksPath"` over `src/`. Everything in §4 marked *new* is absent today.

## 3. Gaps

1. Nothing makes sure that a run can reach the bus. Nothing notices when it doesn't use the bus.
2. The prompt has no fixed, Lair-written part. Task id, run id, report channel, status file and merge signal are left to hand-written instructions that drift from the config.
3. Nothing keeps prompt text off the command line of the tool, or out of the `started` event.
4. Nothing stops or detects a history rewrite on an agent's branch.
5. The commit identity is whatever the worktree's git config says. Attribution text is never checked.
6. The agent is never told which checks exist and where they run, and host rules aren't enforced at all.
7. No test checks what a launch gives, for any adapter.

## 4. Design

### 4.1 Where it lives

- *New:* `src/server/agents/launch.ts`. `buildLaunch(run, adapter, project, settings)` returns `{ env, argv, files, header, given, wouldGive, gaps }`. `startRun` calls it between `writePrompt` and `spawner.spawn` (`service.ts:1590-1594`), so every run goes through it: fill, the review assigner, the planner, the verifier, the supervisor, and the owner's own starts. `given`, `wouldGive` and `gaps` go into the `started` event's `data.launch`.
- *New:* `src/server/agents/launch-watch.ts`. Checks during and after the run (§4.8), called from the tick and where the run's end is classified.
- *New:* `assets/git-hooks/` with `pre-push` and `commit-msg`. These are POSIX sh scripts that take their limits from the environment, read only their arguments and stdin, and never run text from the repository.
- *Changed:* `adapters.ts` gets the adapter fields `bus_via`, `mcp_config_format`, `owner_mcp_file`, `prompt_via` and `exec_commands`, and a `{mcp_config_file}` placeholder. `validateAdapter` warns when an adapter's `queue_file` differs from the project's.
- *Changed:* the review module's PR poll gets `history_rewrite` detection (§4.5).

### 4.2 Part 1: bus

**What a run gets** (`agents.launch.bus: on`):

- `LAIR_BUS_TOKEN` and `LAIR_URL`, with the bus token minted for each run under `agents.launch.bus` even when `bus.consume` is `off`. Reports are then stored and mirrored, but fill and the planner keep reading text lines, as they do today with the bus off. `wantsTokens` (`wiring.ts:40`) gains this third reason.
- A registration of `lair bus-mcp` in the agent's tool, by the adapter's `bus_via`:

| `bus_via` | What Lair does | Used by default by |
|---|---|---|
| `flag` | Writes `<session_dir>/lair-mcp-<run>.json`, holding one `mcpServers.lair` entry whose `command` and `args` are the resolved `bus_command` (below). The adapter's own `start_cmd` must carry `{mcp_config_file}` where the tool takes it (for example `--mcp-config {mcp_config_file}`); Lair never appends a flag to an argv | claude-code, copilot, if the flag is confirmed (below) |
| `owner_file` | Reads the owner's tool config file `owner_mcp_file`, a path template relative to the repository. It checks that the file has a server whose command line ends in `bus-mcp`. It never writes the file | kiro, cursor-agent, gemini, opencode, codex |
| `cli` | Nothing to register. The header tells the agent to report with the resolved `lair bus report` command | aider, goose |

The default for each built-in adapter is checked against that CLI's public reference in PR 3, and the contract test pins it. Until that check passes, an adapter stays `owner_file` or `cli`. `flag` is only for tools that read a JSON file in the `mcpServers` shape: `mcp_config_format` has one value, `mcp-servers-json`, today. A tool with another format (TOML, its own settings file) uses `owner_file` until a format is added.

**Resolving `bus_command`.** `agents.launch.bus_command` (default `["lair", "bus-mcp"]`) is resolved with the server's original `PATH`, before any deny stub is added (§4.7): its first element becomes an absolute path, and when that file starts with `#!/usr/bin/env <name>`, `<name>` is resolved too and put first. The default becomes `[<absolute node>, <absolute lair.js>, "bus-mcp"]`. The MCP file, the `cli` header command and the `owner_file` check all use the resolved form, so a deny stub for the interpreter never reaches the bus.

**The token is never written to a file.** The MCP config file has no `env` block. `lair bus-mcp` reads the token from the environment it inherits from the agent's process. An adapter whose CLI doesn't pass its environment on to MCP servers must use `owner_file`, with the owner's wrapper, or `cli`. The contract test runs a stub agent that starts the registered server the way the CLI does, and checks that the server sees the token (AT-4).

**Wrapper adapters.** Many installs start a tool through their own script (`start_cmd: "<script> {prompt_file} {model}"`), which shifts its arguments and runs the real tool with arguments of its own. Lair can't see what such a script does with its arguments. So:

- `bus_via: flag` is refused at config load unless `start_cmd` itself contains `{mcp_config_file}`. A wrapper that takes the path has to pass it on. `given` then lists `bus:flag` as *offered*, and the watch (§4.8) records the gap `bus:flag_unused` when the run made no bus call. A wrapper that drops the argument is seen that way, not recorded as given.
- `owner_mcp_file` has no default for a custom adapter. The kiro preset's default `.kiro/agents/{agent}.json` is right only because the preset runs `--agent {agent_profile}` and `{agent_profile}` is the agent's id (`service.ts:1698`). A wrapper that picks its own profile (for example `--agent <fixed name>`) must set `owner_mcp_file` to that profile's file, or every run gets `bus:owner_file_missing`.
- `exec_commands` (adapter field, default empty) names the commands a wrapper runs, for example `["kiro-cli"]`. §4.7 uses it to protect them from deny stubs.

**Dead on start.** A new flag, header or hook can make a tool exit at once. When a run ends as `dead_on_start` (`service.ts:2174-2178`) while any part is `on`, the watch records the gap `died_on_start` with the parts that were `on` for that run. Two such gaps for one adapter within an hour are the rollback trigger in §6.

**Required.** With `agents.launch.require: [bus]`, a run whose token can't be minted, or whose `owner_file` check fails, isn't spawned. It goes the same way a spawn error goes today (`service.ts:1596-1603`): it stays `queued` with `detail: launch: <gap>`, `run.launchFailures` counts the refusal, and it is tried again on the next check. There is no extra backoff. The bound is `start_timeout_minutes`: past it, `startTimedOut` ends the run `never_started` with the reason `launch: <gap>` (`service.ts:1900-1942`), and the existing never-started path retries it with its backoff or escalates it. At the first `never_started` whose reason is a launch gap, Lair raises one `launch` decision for that (agent, gap), keyed so a retry or a restart never raises a second one while it is open. Without `require`, the gap is recorded and the run starts, as today.

**Clean-up.** The per-run MCP file is removed when the run ends, by every path that revokes the bus token. At start-up, files whose run is no longer active are removed. A resumed run gets a new file and a new token. The file's name includes the run id, so a retry never adds a second entry.

### 4.3 Part 2: task message

With `agents.launch.header: on`, `writePrompt` puts a `<lair_run>` block first, before `default_instructions`. Lair writes it from config only. The block is JSON inside the tag, so no value can break out of it (the same approach as `formatHungInfo`, `service.ts:1666`):

```json
{
  "task": "<run.task>", "run": "<run.id>", "agent": "<run.agent>", "role": "builder | reviewer | planner | verifier | supervisor",
  "report": { "via": "mcp | cli | file", "tools": ["claim", "report", "inbox", "ack"], "command": "<absolute lair> bus report --kind <KIND> --task <task> --summary-file <file>" },
  "status_file": "<absolute path of the project's queue_file>",
  "status_file_when": "<by report.via, below>",
  "never_write_status_to": ["<tasks_file>", "<prompts_dir>", "<agents_dir>"],
  "branch": "<agents.launch.git.branch_template, rendered>",
  "history": "no force-push, no rebase, no amend or squash of pushed commits; fix forward and merge",
  "identity": "commits are authored by the project identity; no AI attribution in commits, PR titles or bodies",
  "merge": { "signal": "an approving review and a passing gate, both at the exact head", "gate": "signed: <pipeline ids> | host checks: <check names>", "host_ci": "ignored | required", "default_branch_green": true },
  "checks": [{ "kind": "<checks.<kind>>", "runs_on": "lair-server | <executor>", "how": "POST /api/checks with LAIR_BUS_TOKEN" }],
  "host_rules": ["<agents.launch.host_rules[]>"]
}
```

`status_file_when` follows `report.via`: for `mcp` and `cli`, "only when the bus call fails; say 'bus failed: <error>' in the line"; for `file`, "every report goes here as one line".

**Merge signal.** `merge` is built from `review.merge`: `gate` lists the signed pipeline ids for `gate.source: signed`, or the required check names for `gate.source: checks`; `host_ci` is `required` only with `source: checks` and `ignored` otherwise (only Lair's gate results at the head count); `default_branch_green` is `review.merge.hold_when_default_red`. A project without the review module gets no `merge` field.

**Module runs.** A module's own runs get the same block, with the `report` value the module passes to `buildLaunch` from the prompt it already builds, so there is one copy of each command: a review run's comes from the review assigner (`lair review submit`, `review/agent-assigner.ts:24`, `review/prompt.ts:75`), and a supervisor run's from the supervisor (`lair supervisor answer`, `supervisor/chat-prompt.ts:136-147`, or `via: file` with the answer file's path when `supervisor/config.ts:107` is set). Fields that don't apply to a role are left out: a supervisor run gets no `branch` and no `merge`. The header is at most 8 KB. Free text such as `host_rules` is cut at 300 characters per entry and at 20 entries, and control characters are removed.

`status_file` is always the project's `queue_file`, the file Lair reads. When an adapter's `queue_file` differs from it, `validateAdapter` warns (`adapter <id>: queue_file <x> is not the project's queue_file <y>; Lair reads only <y>`). The aider preset's `queue_file` is removed in PR 2.

### 4.4 Part 3: prompt delivery

With `agents.launch.prompt: on`:

- **The prompt reaches the tool only through a file or stdin.** The adapter field `prompt_via` is `file` (default, every preset: the tool gets `{prompt_file}`) or `stdin` (*new*: the spawner opens the prompt file as the child's stdin; `SpawnOptions`, `probes.ts:23-29`, gains `stdinPath`).
- **The argv is checked before the spawn.** `buildLaunch` records `given: prompt:file` (or `prompt:stdin`), or the gap `prompt:on_argv` when any argv element is longer than 512 bytes, or contains a line of at least 40 characters from the prompt file. The presets' fixed sentence (`adapters.ts:81,106,128,144,161,191`) is short and holds no prompt line, so the nine presets have no gap (AT-21). `require: [prompt]` refuses such a run the way §4.2 describes.
- **A wrapper's argv is checked after the spawn.** Lair can't see what a wrapper script puts on its tool's argv before the tool runs. Once, at `dead_on_start_seconds` after the spawn, the watch reads the run's descendant processes from the tick's process table (`watchdog/probes.ts:17-26`, by `ppid` from the run's pid) and records the gap `prompt:on_argv` when a descendant's command line is longer than 2 KB or holds a 40-character prompt line. The gap names the process's executable, never the text.
- **The header replaces text a wrapper put on the argv.** The rules the deployment above passed on the argv (report channel, status file, push rules, host rules, merge signal) are all header fields now, so a wrapper has no reason to add text of its own.
- **The `started` event keeps no prompt text.** With the part `on`, each argv element in `evidence` and `data.argv` is cut to 512 bytes followed by `…(+<n> bytes)`.

### 4.5 Part 4: push and history

With `agents.launch.git: on`:

- **Hooks.** The run's environment sets `core.hooksPath` through `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`. These settings take precedence over every config file, and they reach every git command the agent runs, in **every** repository it works in, not only the project's. They point to a per-run directory `<session_dir>/lair-hooks-<run>/`, which holds Lair's `pre-push` and `commit-msg`.
- **Chaining, computed inside the hook.** The chained hooks path is not baked in at launch, because the agent may commit in more than one repository. Each Lair hook, after its own check passes, finds the repository's own hooks path for the repository it is running in, with the environment override removed: `GIT_CONFIG_COUNT=0 git config --get core.hooksPath`, else `GIT_CONFIG_COUNT=0 git rev-parse --git-path hooks`. It then runs that path's hook of the same name, if it exists and isn't Lair's own directory, so a project's hooks keep running in each repository.
- **Which rules apply where.** `LAIR_HOOKS_REPO_URLS` holds the project repository's remote URLs. In a repository with one of those remotes, the hooks apply every rule below. In any other repository they apply only the non-fast-forward rule and the attribution rule, because the protected names and `allowed_emails` are the project's and may not fit another repository.
- **`pre-push`** refuses (exit 1, with one line saying why) a ref update where:
  - the remote sha exists (isn't all zeros) and isn't an ancestor of the local sha (a non-fast-forward: `git merge-base --is-ancestor <remote> <local>`, with a 10 s timeout, and a timeout refuses);
  - the remote ref is a deletion of a branch other than the run's own;
  - the destination is a protected name (`agents.launch.git.protected`, default `["main", "master"]`).
- **Detection on the remote.** A guard on the agent's host can be bypassed (`--no-verify`, another git), so Lair also watches the result. When the review module's PR poll sees a new head for a PR, it calls `compare(previousHead, newHead)` (`review/github.ts:289`). `behindBy > 0` means the old head is no longer in the branch's history. Lair then records a `history_rewrite` event (PR, old and new head, the agent named by the branch prefix, when), once for each (PR, old head), with a unique key. With `agents.launch.git.on_rewrite: decide`, it also raises one `security` decision for each PR: "PR #n's history was rewritten; reviews at <old> are stale". A compare call that fails or times out (10 s) records `history_unknown`, never "ok".

### 4.6 Part 5: identity and no attribution

- **Identity.** The same `GIT_CONFIG_*` variables set `user.name` and `user.email` from `agents.launch.git.identity`, which defaults to `review.merge.identity` (`review/config.ts:148`). This is a cross-module read: the agents module reads the review module's parsed identity at config load, and a config reload updates both. A worktree's local config can't override them. The identity applies to every repository the run commits in (the variables can't be scoped to one repository). With neither key set (for example a project without the review module), nothing is set, and the gap `identity_missing` is recorded.
- **`commit-msg`** refuses a message that matches `agents.launch.git.attribution_patterns`. The default is `["^Co-Authored-By: .*(noreply@anthropic|claude|copilot|codex|gemini|cursor)", "^Generated with .*(claude|copilot|codex|gemini|cursor|aider)", "🤖"]`, case-insensitive and multiline (so `^` matches at each line), each one run with a 100 ms limit per message. It also refuses a `Co-authored-by` address that isn't in `allowed_emails`.
- **`pre-push`** also refuses commits in the pushed range whose author or committer isn't in `allowed_emails`. The range is `git rev-list <local> --not --remotes=<remote>` (so a new branch, whose remote sha is all zeros, checks only the commits no remote branch has), at most 500 commits; more than 500 refuses with a line saying so. This is the merge guard's rule, applied at the first push instead of at merge.
- **At merge.** The merge guard (`review/executor.ts:198`) also checks the PR's title and body, and every commit message, against the same patterns. A match refuses the merge and names the pattern's index, never the text. There is no override for a false match other than editing the title, body or message, or narrowing `attribution_patterns` in config; the defaults name tools, so "Generated with openapi-generator" doesn't match.

### 4.7 Part 6: checks, local and remote

- The header's `checks` lists every `checks.<kind>` with where it runs: `lair-server` today, the kind's `executor` once [checks.md](checks.md#how-it-moves-to-the-cloud-executor) builds it. It also says how to call it. The agent learns about checks from config, not from a sentence in its brief.
- `agents.launch.host_rules` is a list of sentences shown in the header (for example "run builds and tests through checks, not on this host").
- `agents.launch.deny_commands` (default `[]`) is a list of command names, for example `["docker", "npm", "node"]`. For each name, Lair puts a stub in a per-run directory that comes first on the run's `PATH`. The stub prints `<name> is not run on this host for agent runs: <host rule>; use a check` and exits 126.
- **The stubs never break the tool or the bus.** With the original `PATH`, before the stubs are added, Lair resolves the *needed set*: `argv[0]`, each `exec_commands` entry, and the resolved `bus_command`, each with its `#!/usr/bin/env <name>` interpreter. For a wrapper, `argv[0]` is the script, so `exec_commands` is how Lair learns about the tool the script runs.
  - `bus_command` is always written in its resolved, absolute form (§4.2), so denying its interpreter is allowed: with `deny_commands: [node]` the registered bus server still starts (AT-18).
  - `argv[0]` is spawned by its absolute path, and when it has an `env` interpreter, as `[<absolute interpreter>, <absolute script>, ...]`, so denying that interpreter is allowed too.
  - A denied name that a wrapper or tool still looks up on `PATH` (an `exec_commands` entry or its interpreter) isn't stubbed for that run, and the gap `deny:needed_by_tool` names it. At config load, a deny name equal to an adapter's `argv[0]` or `exec_commands` name is refused.
- The stubs catch mistakes, not attempts to get around them: an absolute path bypasses them, as [sandbox.md](sandbox.md) says of every guard on the same user.

### 4.8 Part 7: evidence and watch

- **`started` event.** `data.launch` records `{ mode, given, would_give, gaps }`. In `on`, `given` lists what the run got, for example `["bus:flag", "header", "prompt:file", "git:hooks", "git:identity", "checks:2", "deny:2"]`, and `would_give` is empty. In `observe`, `given` is empty and `would_give` lists what `on` would give, so a reader never mistakes one for the other. `gaps` lists gap codes, for example `["bus:mint_failed"]`. It never holds token values, file contents, prompt text or the identity's address: only part names and gap codes.
- **During and after the run** (`launch-watch.ts`):
  - `bus_unused` (and `bus:flag_unused` for `bus_via: flag`): the run had a token, wrote a queue line for its task with no `[bus:]` marker, and made no bus call. "No bus call" is derived from the existing store with no schema change: there is no `bus_reports` row with the run's `run_id`, and no `bus_messages` row sent by the run's agent (`from_id`), or read or acknowledged by it (`read_at`, `ack_at`), between the run's `spawnedAt` and its end. `whoami` and `claim` leave no row, so a run that only called those counts as unused; the gap is evidence and never changes the run's class.
  - `status_in_wrong_file`: the tasks file gained a line that matches fill's `done_pattern`, `waiting_pattern` or `blocked_pattern` for this agent during the run. The tasks file is compared with an in-memory copy taken at the run's start (lines only, at most 1 MB). The event names the line number, never the text. A run adopted after a restart has no copy: the check is skipped for it and records nothing, never a clean result.
  - `prompt:on_argv` for a descendant process (§4.4) and `died_on_start` (§4.2).
  - Each of these records one `launch_gap` event for each (run, code). The Agents view shows a run's gaps next to its outcome. They feed the waste classes in [ai-spend.md](ai-spend.md) as evidence, and never change a run's class by themselves.
- **Observe.** In `observe`, `buildLaunch` runs, and `would_give` and `gaps` say what `on` would give. The argv, the environment, the prompt, the `started` event's argv and the files are the ones the run gets today. No file, hook or stub is written. The watch runs in `observe` too, because it only reads.

### 4.9 Configuration

```yaml
agents:
  launch:
    mode: off                 # off | observe | on: the default for every part below
    require: []               # parts whose gap refuses the spawn when on: bus, header, prompt, git
    bus: inherit              # inherit | off | observe | on
    bus_command: ["lair", "bus-mcp"]   # argv; resolved to absolute paths, interpreter included, at launch
    header: inherit
    prompt: inherit
    git:
      mode: inherit
      identity: { name: "...", email: "..." }   # optional; defaults to review.merge.identity
      branch_template: "agent/{agent}/{task}"
      protected: ["main", "master"]
      attribution_patterns: [...]      # the defaults in §4.6
      on_rewrite: record      # record | decide
    checks_header: inherit
    host_rules: []            # sentences, at most 20, each at most 300 characters
    deny_commands: []         # command names, [A-Za-z0-9._-]{1,64}

agent_adapters:
  my-tool:
    start_cmd: "my-tool --mcp-config {mcp_config_file} {prompt_file}"
    bus_via: flag             # flag | owner_file | cli
    mcp_config_format: mcp-servers-json   # with bus_via: flag; the only format today
    owner_mcp_file: ".tool/agents/{agent}.json"   # with bus_via: owner_file, relative to the repo
    prompt_via: file          # file | stdin
    exec_commands: []         # commands a wrapper script runs by name
```

Validation: unknown keys are refused, as in `parseBusConfig` (`src/server/bus/config.ts:19`). `require` may only name parts that are `on`. `bus_via: flag` needs `{mcp_config_file}` in `start_cmd`. `bus_via: owner_file` on a custom adapter needs `owner_mcp_file`. `owner_mcp_file` must stay inside the repo (no `..`, no absolute path). A pattern that doesn't compile is refused. A `deny_commands` name equal to an adapter's `argv[0]` or `exec_commands` name is refused. `docs/configuration.md` gets an "Agent launch contract" section.

### 4.10 Security

- Tokens live in the environment only, never in a file, an event, an argv or a log. `buildLaunch` has a test that scans every file it writes and every event it emits for the token.
- Prompt text stays off the argv and out of the `started` event (§4.4).
- The hooks and stubs are Lair's own files, and their contents are fixed. Nothing from the task, the prompt or the repository is put into them. The only values they read are environment variables that Lair sets and the output of the two `git` calls in §4.5, and they read those as data (no `eval`, no `sh -c`).
- Detection on the remote is read-only, with one decision for each PR and a unique key, so a restart or a second poll never raises a second one.
- The owner's tool config (`owner_mcp_file`) is read only, never written, and is opened without following a symlink out of the repo (the rule `prompts.ts` uses).

### 4.11 Reliability

- `buildLaunch` is synchronous and pure, apart from resolving paths and writing the per-run files. Those writes happen before the spawn and are named by run id, so a retry overwrites them and doesn't add a second set.
- A refused launch has no loop of its own: it is bounded by `start_timeout_minutes` and then handled by the never-started path (§4.2).
- Every git call in the hooks has a timeout (10 s), and a timeout refuses the push. Every compare call has a timeout (10 s), and a timeout records `history_unknown`.
- When the server restarts, adopted runs keep their files. Files of runs that are no longer active are removed at start, after `reconcile`.

## 5. Acceptance tests

Each test drives the real entry point (the agents tick through `requestRun` at `service.ts:3820`, a real `git push` to a local bare repository, the review poll) and fakes one named boundary: the process spawner, the GitHub client, or the clock. The adapters are the built-in presets as they are on main.

| # | Name | Given | When | Then |
|---|---|---|---|---|
| AT-1 | `launch observe changes nothing` | `agents.launch.mode: observe`, adapter claude-code, bus off, `review.merge.identity` set | a run starts | argv, env, prompt and `started.data.argv` are byte-identical to `mode: off`. No file is written under `session_dir`. `started.data.launch.given` is empty and `would_give` lists `bus:flag, header, prompt:file, git:hooks, git:identity` |
| AT-2 | `launch on gives the bus to a flag adapter` | `mode: on`, claude-code with `bus_via: flag` and `{mcp_config_file}` in its `start_cmd`, bus.consume off | a run starts | env has `LAIR_BUS_TOKEN` and `LAIR_URL`. argv holds `<session_dir>/lair-mcp-<run>.json` where the template put it. The file has `mcpServers.lair` with an absolute command and no `env` key |
| AT-3 | `the token is in no file event or argv` | as AT-2 | the run starts, then ends | a scan of every file written, the `started` and `completed` events, the argv and the run log finds no token |
| AT-4 | `the registered server sees the run's token` | a new stub agent `fixtures/stubs/agent-launch.sh` (next to `agent-run.sh`), which starts the registered server command with its own environment, as the CLIs do | it calls `whoami` and `report DONE` | the bus records the report under that run. The queue file gets one line ending `[bus:<id>]` |
| AT-5 | `owner_file adapter without the bus server is a gap` | kiro with `owner_mcp_file`, the file has no `bus-mcp` server | a run starts, without `require`, then with `require: [bus]` | first: it starts with gap `bus:owner_file_missing`. Second: it isn't spawned, `detail` is `launch: bus:owner_file_missing`, and each tick refuses again until `start_timeout_minutes` (fake clock), when it ends `never_started` with that reason and one `launch` decision is raised. A retry that is refused again, and a restart, add no second decision |
| AT-6 | `mint failure is refused when bus is required` | the bus store fails to issue a token | a run starts, with `require: [bus]` | not spawned, `detail` is `launch: bus:mint_failed`, `launchFailures` counts it. Without `require`, it starts with gap `bus:mint_failed` |
| AT-7 | `header names the task report channel and status file` | `header: on`, a builder run, `bus_via: cli` | a run starts | the prompt's first block is `<lair_run>` with the task, run, agent, `report.via: cli` with an absolute command, `status_file` equal to the absolute `queue_file`, and the tasks file in `never_write_status_to`. A task id holding `</lair_run>` stays inside the JSON string |
| AT-8 | `review and supervisor runs get their own report channel` | a review run and a supervisor run | they start | review: `report.command` is the one the review assigner builds (`lair review submit ...`), with no `branch`. Supervisor: the one the supervisor builds (`lair supervisor answer ...`), or `via: file` with the answer path when the answer file is configured. No `merge` on the supervisor run |
| AT-9 | `adapter queue_file other than the project's warns` | an adapter with `queue_file: other.md` | config load | one warning naming both paths. The run's `status_file` is the project's |
| AT-10 | `pre-push refuses a force push` | `git: on`, a branch pushed at A, then the agent amends to A' | `git push --force` | push exits non-zero with `refused: not a fast-forward of the remote`. The remote is still at A. A normal merge commit on top of A pushes |
| AT-11 | `pre-push refuses a push to main and a foreign identity` | as AT-10 | push to `main`, then push a commit authored by `someone@example.com` | both refused. The project's own hooks still ran on the allowed push (a marker file) |
| AT-12 | `identity comes from the project, not the worktree` | worktree `user.name=Placeholder`, project identity set | the stub agent commits | the commit's author and committer are the project identity |
| AT-13 | `commit-msg refuses attribution` | `git: on` | commit with `Generated with Claude` on its own line, and with a `Co-Authored-By` naming a tool address on the third line | both refused. A plain message and `Generated with openapi-generator` are accepted |
| AT-14 | `merge guard refuses attribution in the PR body` | a PR whose body has a `Generated with Claude` line, commits clean | merge | refused, naming the pattern index, not the text |
| AT-15 | `rewrite on the remote is detected once` | review poll sees PR #7 at A, then at B with `compare(A,B).behindBy = 1` | two polls, a restart, a third poll | one `history_rewrite` event, and with `on_rewrite: decide` one decision. A compare timeout records `history_unknown`, never a clean head |
| AT-16 | `status in the tasks file is detected` | a run writes `- DONE <task> by <agent> ...` into the tasks file | the run ends | one `launch_gap status_in_wrong_file` with the line number. The event holds no line text. A run adopted after a restart gets no event |
| AT-17 | `bus_unused is detected from reports and messages` | a run with a token writes a queue line by hand and has no report or message row | the run ends | one `launch_gap bus_unused`. A run with a `bus_reports` row for its `run_id`, and a run that read a message during its life, get none |
| AT-18 | `deny stubs block a command but not the tool or the bus` | `deny_commands: [docker, node]`, claude-code with `bus_via: flag` | the stub agent runs `docker ps` and `node -v`, then starts the registered server | both exit 126 with the rule. The adapter's command starts, and the registered bus server starts and answers `whoami`. `deny_commands` naming an adapter's own command or an `exec_commands` entry is a config error |
| AT-19 | `contract per built-in adapter` | each of the nine presets, in `mode: on` | `buildLaunch` | a snapshot for each adapter: `bus_via`, argv, env names (not values), header present, git variables. A new preset with no snapshot fails the test |
| AT-20 | `files are removed when the run ends and at start` | a run ends, then a server starts with a file left by a run that is no longer active | end, start | no `lair-mcp-*`, `lair-hooks-*` or deny directory is left for runs that aren't active. An adopted active run keeps its files |
| AT-21 | `prompt text on the argv is a gap` | `prompt: on`; an adapter whose `start_cmd` holds a 600-byte literal, and a stub wrapper that runs a child with a prompt line on its argv | a run starts with each | the first: gap `prompt:on_argv` before the spawn, and with `require: [prompt]` it isn't spawned. The second: one `prompt:on_argv` gap naming the child's executable after `dead_on_start_seconds`. The nine presets have no gap, and `started.data.argv` elements are at most 512 bytes plus the marker |
| AT-22 | `a wrapper that drops the flag is not given the bus` | a stub wrapper adapter with `{mcp_config_file}` in `start_cmd` that ignores that argument | the run ends with no bus call | `given` had `bus:flag` and the run gets gap `bus:flag_unused`. A wrapper with no `{mcp_config_file}` and `bus_via: flag` is a config error |
| AT-23 | `hooks chain per repository` | `git: on`, two repositories with their own `pre-push` marker hooks, only the first with the project's remote | the agent pushes in each | each repository's own hook ran (its own marker). A push to `main` is refused in the first and not in the second; a force-push is refused in both |
| AT-24 | `dead on start names the parts that were on` | `header: on`, a stub that exits at once | the run ends `dead_on_start` | one `launch_gap died_on_start` listing `header` |

AT-19 is the contract test for each adapter, and the seed of the conformance suite in #114. Each test fails on main: the module, the fields and the events don't exist there.

## 6. Rollout

1. Ship with every part `off` (the defaults).
2. Turn on `agents.launch.mode: observe` for a project. For a week, read `started.data.launch.gaps` and the `launch_gap` events on the Agents view. Fix each agent tool's registration until `bus:*` gaps stop, and each wrapper until `prompt:on_argv` stops.
3. Turn on `prompt: on` and `header: on`, then `git: on`. Watch `history_rewrite` and the hooks' refusals in the run logs.
4. Turn on `bus: on` with `require: [bus]` once no run has had a `bus:*` gap for 3 days.
5. Roll back by setting a part, or `mode`, back to `observe` or `off`. This is a config reload with no restart, and the next spawn uses it. The trigger is two `died_on_start` gaps for one adapter within an hour (§4.2): set the parts that gap names back to `observe`.

## 7. PR plan

Each PR has its tests and its `docs/configuration.md` section, sits behind its switch (default `off`), and stays under ~600 changed lines that aren't tests. None of them changes a store schema: `bus_unused` is derived from the existing `bus_reports` and `bus_messages` rows (§4.8).

1. **Contract builder and observe.** `launch.ts` (`buildLaunch`, `given`/`would_give`/`gaps`, and observe changing nothing), the config block and its validation, and `started.data.launch`. ATs 1, 19 (`would_give` only).
2. **Task header and prompt delivery.** `<lair_run>` for every role with the `merge` field and the modules' own `report` values, `status_file` from the project, the adapter `queue_file` warning, removing the aider preset's `queue_file`, `prompt_via`, the argv check and the cut of the `started` event's argv. ATs 7, 8, 9, 21 (before the spawn).
3. **Bus registration.** `bus_via`, `mcp_config_format`, `owner_mcp_file`, `exec_commands`, the `{mcp_config_file}` placeholder, resolving `bus_command`, the token minted under `agents.launch.bus`, `require` through the never-started path and the decision, file clean-up, and checking each preset's default against its CLI's reference. ATs 2-6, 20.
4. **Git guards.** The hooks directory, the `GIT_CONFIG_*` variables, `pre-push` and `commit-msg`, `agents.launch.git.identity`, and chaining computed in the hook. ATs 10-13, 23.
5. **Remote detection and merge text.** `history_rewrite` in the review poll, `on_rewrite`, and the merge guard's attribution check of the title, body and messages. ATs 14, 15.
6. **Watch and checks.** `launch-watch.ts` (`bus_unused`, `bus:flag_unused`, `status_in_wrong_file`, the descendant argv check, `died_on_start`), the header's `checks` and `host_rules`, `deny_commands` stubs with the needed set, and the Agents view's gap column. ATs 16-18, 21 (after the spawn), 22, 24. Also the full AT-19 snapshot, and `docs/agents.md` replacing "Ensure agents write to the queue" with the contract.

PRs 2-6 depend on PR 1. PR 4 and PR 5 don't depend on each other.

## 8. Risks

- **A CLI changes its MCP flag or its environment handling.** AT-19 pins the argv, and AT-4 checks inheritance only against a stub. A real CLI that drops the environment shows up as `bus_unused` on its runs. The fix is `bus_via: owner_file` or `cli` for that adapter.
- **Wrapper scripts hide what the tool gets.** Lair checks what it can see (the template, the descendants' command lines, bus use after the run) and records the rest as gaps. A wrapper that keeps its own rules on the argv is reported, not fixed, until its owner moves them into config.
- **`core.hooksPath` collides with a project's hook manager.** Lair's hooks chain to the repository's own hooks path. A hook manager that sets `core.hooksPath` on each command would win over Lair's. AT-11 and AT-23 cover chaining, and the refusals in the logs show whether the guard is active.
- **Identity in a second repository.** The `GIT_CONFIG_*` identity applies to every repository the run commits in. An install whose agents commit to repositories with another identity leaves `git.identity` unset and keeps the merge guard as the check.
- **Guards on the same user can be bypassed.** `--no-verify`, an absolute path or another git binary all get around them. Remote detection (§4.5) and the merge guard catch what the agent's host doesn't. Real isolation is [sandbox.md](sandbox.md).
- **The header grows into a second instructions file.** It holds only values derived from config, with a size cap, and its fields are fixed by this spec. Free text stays in `default_instructions`.
- **False `status_in_wrong_file`.** An owner editing the tasks file by hand during a run could match the patterns. The event names the line and records only. It never changes a run's outcome.
