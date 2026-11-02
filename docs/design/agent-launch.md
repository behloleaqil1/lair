# Agent launch contract

- **Status:** design, not built.
- **Base:** main `d2b3d8e`.
- **Related:** issue #327 (this design), #114 (adapter SDK with a conformance suite), #77, #78, #79 (adapters tested end to end), [phase3-bus.md](phase3-bus.md) (the fleet bus), [checks.md](checks.md) (checks on a runner), [sandbox.md](sandbox.md) (isolation, ROADMAP B4), [ai-spend.md](ai-spend.md) (the run records this spec adds to).

Lair starts agent runs with any of nine adapters. What a run is given today depends on the adapter, on how the owner set up that agent's tool by hand, and on free-text rules in `default_instructions`. When one of those is missing, the run still starts, and the agent fills the gap by guessing. This spec defines a **launch contract**: a fixed list of things every launch gives an agent, built by Lair from config, recorded on the run, checked before the spawn, watched after it, and pinned by a contract test for each adapter.

The contract has six parts:

1. **Bus:** a bus token, the server's address, and the bus MCP server registered in the agent's tool. Or, for a tool without MCP, the `lair bus` command.
2. **Task message:** a header that Lair writes at the top of the prompt. It names the task, the run, the agent, how to report, the one file status lines may go to, and the files they must never go to.
3. **Push and history rules:** the branch to push, and no force-push, rebase or amend of pushed commits. Lair states them, a git hook refuses the push, and Lair detects the rewrite when it reaches the remote anyway.
4. **Identity and no attribution:** the commit identity comes from the project, not from the worktree's git config. Attribution text is refused at commit time and checked again at merge.
5. **Checks, local and remote:** which check kinds exist, where each one runs, and which commands must not run on the agent's host.
6. **Evidence:** the contract each run got, recorded with no secrets in it, and the gaps Lair saw after the run.

Each part has a mode: `off`, `observe` or `on`. `observe` records what the contract would give and what is missing, and changes nothing about the launch. `on` gives the part. A part marked *required* also refuses to start a run that would lack it. Every part defaults to `off`. An install turns the parts on in `observe` first.

## 1. Why: what one real deployment shows

These numbers come from one project with 16 to 36 agents and from Lair's own repository, over the 12 days to 2 Nov 2026. They were read from the queue file, the tasks file, GitHub's PR timelines and the `main` history of both repositories.

| Fact | Count |
|---|---|
| Status lines (`- DONE`, `- WAITING`, `- BLOCKED`, `- READY`) written into the **tasks file** (the file Lair reads tasks from) instead of the queue file | 22 of 156 lines in the tasks file. Fill and the planner never read them as reports, so those runs looked like they had no result |
| Status lines in the queue file written by hand, with no `[bus:<id>]` marker, after the bus was rolled out to every agent | 134 hand-written lines and 121 bus lines. Most agents whose tool had no bus server fell back to hand-written lines. The rules said to use the bus, and nothing checked whether the agent could |
| Pushes that rewrote a PR branch's history (GitHub `head_ref_force_pushed` events) | 58 events on 33 of the last 200 PRs across the two repositories (one PR had 13). Each one made the reviews and gates at the old head stale, and lost the commits a reviewer had seen |
| `main` commits authored with a placeholder identity from a worktree's local git config | 228 of 322 in one repository, until the config was fixed by hand. The merge guard (`review.merge.allowed_emails`) checks addresses at merge time only. By then the only fix is a history rewrite, which the rules forbid |
| Rules an agent received only as prompt text, with nothing checking them | the report channel, the queue file's path, no force-push, the branch name, the commit identity, no AI attribution, and "builds run on the remote runner, not on this host" |

Five failure patterns follow:

1. **No bus, so status goes to the wrong place.** A run that can't reach the bus writes its status by hand, and sometimes to the wrong file. Lair then classifies the run as having no result, and the task is started again.
2. **The bus token can silently be absent.** When minting the token fails, the run starts anyway, without it (`src/server/bus/wiring.ts:57`).
3. **History rewrites.** A rebase or an amend followed by a force-push invalidates reviews and gates at a sha. The agent then reports READY at a head that nobody reviewed.
4. **Identity from the worktree.** A worktree whose local config has a placeholder name or address produces commits that the merge guard refuses only at the end.
5. **Host rules as prompt text.** Nothing tells the agent which checks run remotely. A rule like "don't build on this host" is only a sentence in the prompt.

## 2. What exists today

The inventory below was found with `git grep` on `github/main` (`d2b3d8e`) over `LAIR_BUS_TOKEN`, `mcpServers`, `queue_file`, `status_method`, `default_instructions`, `allowed_emails`, `compare`, `force` and `attribution` in `src/server/`, `src/cli/` and `docs/`.

| Item | Where | What it does | Gap |
|---|---|---|---|
| Run environment | `src/server/agents/service.ts:1692` `env()`; `src/server/agents/probes.ts:40` `agentEnvironment` | Gives `LAIR_RUN_ID`, `LAIR_TASK`, `LAIR_AGENT`, `LAIR_SESSION_ID`, `LAIR_SESSION_MODE`, `TASK`, `MODEL`, the adapter's `session_id_env`, `env_passthrough` and the module variables. It never passes on the rest of the server's environment | No git identity and no record of what was given |
| Bus token | `service.ts:1706-1711`; `src/server/bus/wiring.ts:40` `wantsTokens`, `:57` | Mints `LAIR_BUS_TOKEN` and sets `LAIR_URL` while `bus.consume` isn't `off` or the project has `checks:` | When minting fails, the run starts without a token (by design today). With the bus off, no run gets a token |
| Module run variables | `service.ts:435` `MODULE_RUN_VARIABLES` | The review, supervisor and bus variables another module may pass to a run | n/a |
| Bus clients | `src/cli/bus-mcp.ts:184`, `src/cli/bus.ts:117` | `lair bus-mcp` (MCP over stdio) and `lair bus report`, both reading `LAIR_BUS_TOKEN` and `LAIR_URL` | Nothing registers `lair bus-mcp` in the agent's tool |
| Bus registration docs | `docs/agents.md:177-249`; `docs/design/phase3-bus.md:37-40` | The owner adds an `mcpServers` entry to each agent tool's config by hand | Not checked. A tool without the entry has no bus, and nobody is told |
| Bus mirror | `src/server/bus/mirror.ts:1-17` | Appends each bus report to the queue file with `[bus:<id>]` | n/a |
| Prompt file | `service.ts:1620` `writePrompt` | `default_instructions`, the agent's `instructions`, the resume summary, the run's prompt and a hung-run block | No Lair-written header. The report channel and the rules are whatever the instructions say |
| Start command | `service.ts:1666` `startCommand`; `src/server/services/adapters.ts:578` `buildStartCommand` | Builds the argv from the adapter's template (one argument per placeholder) | No placeholder for an MCP config file |
| Started event | `service.ts:1598-1615` | Records the argv, pid, session and profile | It does not record which contract parts were given |
| Built-in adapters | `adapters.ts:31-218` | kiro, aider, claude-code, cursor-agent, codex, gemini, opencode, goose, copilot | Only kiro is tested end to end. The aider preset's `queue_file: .aider/status.md` (`adapters.ts:67`) differs from the project's `queue_file` |
| Adapter status fields | `adapters.ts:478-545` `validateAdapter`; `src/server/parsers/adapter-config.ts:29,64` | Validates `status_method` (file, stdout, mcp), `queue_file`, `status_pattern` and `mcp_endpoint` | The run path reads only the project's `queue_file` (`service.ts:2111`). An adapter's `queue_file` is validated and then never used |
| Merge identity guard | `src/server/review/config.ts:639`; `src/server/review/executor.ts:109` | Refuses a merge when a commit's author, committer or message address isn't in `allowed_emails` | Runs only at merge time. It doesn't check text such as "Generated with" |
| Compare API | `src/server/review/github.ts:290` `compare` | Returns `aheadBy` and `behindBy` for two shas | Never used to detect a rewritten head |
| Checks API | `docs/agents.md:251-288`; `src/server/checks/config.ts:62`; `src/server/checks/git.ts:62` `shaOnPushedBranch` | Targeted tests on the Lair server, with the run's bus token, for a pushed sha | The agent isn't told which kinds exist or where they run (`checks.md:149` plans `executor: cloud\|local\|auto`) |
| Lair's own pushes | `docs/design/importer.md:67` | Lair never force-pushes | Agents' pushes aren't covered |
| Sandbox | `docs/design/sandbox.md` | Planned isolation of runs (B4) | Not built. Every guard below is a guard rail for an agent that makes a mistake, not a defence against one that tries to get around it |

Two more checks found nothing on main: `git grep -n -E "launch_contract|launch_gap|history_rewrite|mcp_config"` and `git grep -n "hooksPath"` over `src/`. Everything in §4 marked *new* is absent today.

## 3. Gaps

1. Nothing makes sure that a run can reach the bus. Nothing notices when it doesn't use the bus.
2. The prompt has no fixed, Lair-written part. Task id, run id, report channel and status file are left to hand-written instructions that drift from the config.
3. Nothing stops or detects a history rewrite on an agent's branch.
4. The commit identity is whatever the worktree's git config says. Attribution text is never checked.
5. The agent is never told which checks exist and where they run, and host rules aren't enforced at all.
6. No test checks what a launch gives, for any adapter.

## 4. Design

### 4.1 Where it lives

- *New:* `src/server/agents/launch.ts`. `buildLaunch(run, adapter, project, settings)` is a pure function that returns `{ env, argvExtras, files, header, given, gaps }`. `startRun` calls it between `writePrompt` and `spawner.spawn` (`service.ts:1570-1575`), so every run goes through it: fill, the review assigner, the planner, the verifier, the supervisor, and the owner's own starts. `given` and `gaps` go into the `started` event's `data.launch`.
- *New:* `src/server/agents/launch-watch.ts`. Checks after the run (§4.7), called where the run's end is classified.
- *New:* `assets/git-hooks/` with `pre-push` and `commit-msg`. These are POSIX sh scripts that take their limits from the environment, read only their arguments and stdin, and never run text from the repository.
- *Changed:* `adapters.ts` gets three adapter fields (`bus_via`, `mcp_config`, `owner_mcp_file`) and a `{mcp_config_file}` placeholder. `validateAdapter` warns when an adapter's `queue_file` differs from the project's.
- *Changed:* the review module's PR poll gets `history_rewrite` detection (§4.4).

### 4.2 Part 1: bus

**What a run gets** (`agents.launch.bus: on`):

- `LAIR_BUS_TOKEN` and `LAIR_URL`, with the bus token minted for each run under `agents.launch.bus` even when `bus.consume` is `off`. Reports are then stored and mirrored, but fill and the planner keep reading text lines, as they do today with the bus off. `wantsTokens` (`wiring.ts:40`) gains this third reason.
- A registration of `lair bus-mcp` in the agent's tool, by the adapter's `bus_via`:

| `bus_via` | What Lair does | Used by default by |
|---|---|---|
| `flag` | Writes `<session_dir>/lair-mcp-<run>.json`, holding one `mcpServers.lair` entry (`command`: `agents.launch.bus_command`, default `["lair", "bus-mcp"]`), and appends `mcp_config` (for example `--mcp-config {mcp_config_file}`) to the argv | claude-code, copilot, if the flag is confirmed (below) |
| `owner_file` | Reads the owner's tool config file `owner_mcp_file` (a path template, for example `.kiro/agents/{agent}.json`). It checks that the file has a server whose command line ends in `bus-mcp`. It never writes the file | kiro, cursor-agent, gemini, opencode, codex |
| `cli` | Nothing to register. The header tells the agent to report with `lair bus report ...` | aider, goose |

The default for each built-in adapter is checked against that CLI's public reference in PR 3, and the contract test pins it. Until that check passes, an adapter stays `owner_file` or `cli`.

**The token is never written to a file.** The MCP config file has no `env` block. `lair bus-mcp` reads the token from the environment it inherits from the agent's process. An adapter whose CLI doesn't pass its environment on to MCP servers must use `owner_file`, with the owner's wrapper, or `cli`. The contract test runs a stub agent that starts the registered server the way the CLI does, and checks that the server sees the token (AT-4).

**Required.** With `agents.launch.require: [bus]`, a run whose token can't be minted, or whose `owner_file` check fails, isn't spawned. It stays `queued`, with `detail: launch: <gap>`, and is retried on later ticks with the existing launch backoff (`run.launchFailures`). After `agents.launch.max_refusals` refusals (default 5), it raises one `launch` decision for each agent and gap. Without `require`, the gap is recorded and the run starts, as today.

**Clean-up.** The per-run MCP file is removed when the run ends, by every path that revokes the bus token. At start-up, files whose run is no longer active are removed. A resumed run gets a new file and a new token. The file's name includes the run id, so a retry never adds a second entry.

### 4.3 Part 2: task message

With `agents.launch.header: on`, `writePrompt` puts a `<lair_run>` block first, before `default_instructions`. Lair writes it from config only. The block is JSON inside the tag, so no value can break out of it (the same approach as `formatHungInfo`, `service.ts:1646`):

```json
{
  "task": "<run.task>", "run": "<run.id>", "agent": "<run.agent>", "role": "builder | reviewer | planner | verifier | supervisor",
  "report": { "via": "mcp | cli | file", "tools": ["claim", "report", "inbox", "ack"], "command": "lair bus report --kind <KIND> --task <task> --summary-file <file>" },
  "status_file": "<absolute path of the project's queue_file>",
  "status_file_when": "only when the bus call fails; say 'bus failed: <error>' in the line",
  "never_write_status_to": ["<tasks_file>", "<prompts_dir>", "<agents_dir>"],
  "branch": "<agents.launch.git.branch_template, rendered>",
  "history": "no force-push, no rebase, no amend or squash of pushed commits; fix forward and merge",
  "identity": "commits are authored by the project identity; no AI attribution in commits, PR titles or bodies",
  "checks": [{ "kind": "<checks.<kind>>", "runs_on": "lair-server | <executor>", "how": "POST /api/checks with LAIR_BUS_TOKEN" }],
  "host_rules": ["<agents.launch.host_rules[]>"]
}
```

A module's own runs get the same block with their own `report` value. A review run reports with `lair review-submit`, and a supervisor run with `lair supervisor-answer`. Fields that don't apply to a role are left out: a supervisor run gets no `branch`. The header is at most 8 KB. Free text such as `host_rules` is cut at 300 characters per entry and at 20 entries, and control characters are removed.

`status_file` is always the project's `queue_file`, the file Lair reads. When an adapter's `queue_file` differs from it, `validateAdapter` warns (`adapter <id>: queue_file <x> is not the project's queue_file <y>; Lair reads only <y>`). The aider preset's `queue_file` is removed in PR 2.

### 4.4 Part 3: push and history

With `agents.launch.git: on`:

- **Hooks.** The run's environment sets `core.hooksPath` through `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`. These settings take precedence over the worktree's own config, and they reach every git command the agent runs. They point to a per-run directory `<session_dir>/lair-hooks-<run>/`, which holds Lair's `pre-push` and `commit-msg` and a copy of the variables they read (`LAIR_HOOKS_CHAIN`: the repository's own hooks path, from `git config core.hooksPath` or `.git/hooks`). Each Lair hook runs the repository's hook of the same name after its own check passes, so a project's hooks keep running.
- **`pre-push`** refuses (exit 1, with one line saying why) a ref update where:
  - the remote sha exists and isn't an ancestor of the local sha (a non-fast-forward: `git merge-base --is-ancestor <remote> <local>`, with a 10 s timeout, and a timeout refuses);
  - the remote ref is a deletion of a branch other than the run's own;
  - the destination is a protected name (`agents.launch.git.protected`, default `["main", "master"]`).
- **Detection on the remote.** A guard on the agent's host can be bypassed (`--no-verify`, another git), so Lair also watches the result. When the review module's PR poll sees a new head for a PR, it calls `compare(previousHead, newHead)` (`review/github.ts:290`). `behindBy > 0` means the old head is no longer in the branch's history. Lair then records a `history_rewrite` event (PR, old and new head, the agent named by the branch prefix, when), once for each (PR, old head), with a unique key. With `agents.launch.git.on_rewrite: decide`, it also raises one `security` decision for each PR: "PR #n's history was rewritten; reviews at <old> are stale". A compare call that fails or times out (10 s) records `history_unknown`, never "ok".

### 4.5 Part 4: identity and no attribution

- **Identity.** The same `GIT_CONFIG_*` variables set `user.name` and `user.email` from the project's `identity` (the one `review.merge.allowed_emails` defaults to, `review/config.ts:639`). A worktree's local config can't override them. With no `identity`, nothing is set, and the gap `identity_missing` is recorded.
- **`commit-msg`** refuses a message that matches `agents.launch.git.attribution_patterns`. The default is `["^Co-Authored-By: .*(noreply@anthropic|claude|copilot|codex|gemini|cursor)", "Generated with ", "🤖"]`, case-insensitive, each one run with a 100 ms limit per message. It also refuses a `Co-authored-by` address that isn't in `allowed_emails`.
- **`pre-push`** also refuses commits in the pushed range (`<remote>..<local>`, at most 500) whose author or committer isn't in `allowed_emails`. This is the merge guard's rule, applied at the first push instead of at merge.
- **At merge.** The merge guard (`review/executor.ts:109`) also checks the PR's title and body, and every commit message, against the same patterns. A match refuses the merge and names the pattern, never the text.

### 4.6 Part 5: checks, local and remote

- The header's `checks` lists every `checks.<kind>` with where it runs: `lair-server` today, the kind's `executor` once [checks.md](checks.md#how-it-moves-to-the-cloud-executor) builds it. It also says how to call it. The agent learns about checks from config, not from a sentence in its brief.
- `agents.launch.host_rules` is a list of sentences shown in the header (for example "run builds and tests through checks, not on this host").
- `agents.launch.deny_commands` (default `[]`) is a list of command names, for example `["docker", "npm"]`. For each name, Lair puts a stub in a per-run directory that comes first on the run's `PATH`. The stub prints `<name> is not run on this host for agent runs: <host rule>; use a check` and exits 126. Lair resolves the adapter's own command (`argv[0]`) and `bus_command` to absolute paths with the original `PATH` before it adds the stubs. A denied name used by the adapter, or by the bus command, is a config error, so the stubs never break the tool itself. The stubs catch mistakes, not attempts to get around them: an absolute path bypasses them, as [sandbox.md](sandbox.md) says of every guard on the same user.

### 4.7 Part 6: evidence and watch

- **`started` event.** `data.launch` records `{ mode, given: ["bus:flag", "header", "git:hooks", "git:identity", "checks:2", "deny:2"], gaps: ["bus:mint_failed"] }`. It never holds token values, file contents or the identity's address: only part names and gap codes.
- **After the run** (`launch-watch.ts`, when the run's end is classified):
  - `bus_unused`: the run had a token, wrote a queue line for its task with no `[bus:]` marker, and made no bus call (the bus store records the token's last use).
  - `status_in_wrong_file`: the tasks file gained a line that matches fill's `done_pattern`, `waiting_pattern` or `blocked_pattern` for this agent during the run. The tasks file is compared with the copy taken at the run's start (lines only, at most 1 MB). The event names the line number, never the text.
  - Each of these records one `launch_gap` event for each (run, code). The Agents view shows a run's gaps next to its outcome. They feed the waste classes in [ai-spend.md](ai-spend.md) as evidence, and never change a run's class by themselves.
- **Observe.** In `observe`, `buildLaunch` runs, and `given` and `gaps` say what `on` would give. The argv, the environment, the prompt and the files are the ones the run gets today. No file, hook or stub is written. The watch runs in `observe` too, because it only reads.

### 4.8 Configuration

```yaml
agents:
  launch:
    mode: off                 # off | observe | on: the default for every part below
    require: []               # parts whose gap refuses the spawn when on: bus, header, git
    max_refusals: 5           # refused spawns of one run before a `launch` decision
    bus: inherit              # inherit | off | observe | on
    bus_command: ["lair", "bus-mcp"]   # argv; resolved to an absolute path at launch
    header: inherit
    git:
      mode: inherit
      branch_template: "agent/{agent}/{task}"
      protected: ["main", "master"]
      attribution_patterns: [...]      # the defaults in §4.5
      on_rewrite: record      # record | decide
    checks_header: inherit
    host_rules: []            # sentences, at most 20, each at most 300 characters
    deny_commands: []         # command names, [A-Za-z0-9._-]{1,64}

agent_adapters:
  my-tool:
    bus_via: owner_file       # flag | owner_file | cli
    mcp_config: "--mcp-config {mcp_config_file}"   # with bus_via: flag
    owner_mcp_file: ".tool/agents/{agent}.json"    # with bus_via: owner_file, relative to the repo
```

Validation: unknown keys are refused, as in `parseBusConfig`. `require` may only name parts that are `on`. `bus_via: flag` needs `mcp_config` with `{mcp_config_file}`. `owner_mcp_file` must stay inside the repo (no `..`, no absolute path). A pattern that doesn't compile is refused. `docs/configuration.md` gets an "Agent launch contract" section.

### 4.9 Security

- Tokens live in the environment only, never in a file, an event, an argv or a log. `buildLaunch` has a test that scans every file it writes and every event it emits for the token.
- The hooks and stubs are Lair's own files, and their contents are fixed. Nothing from the task, the prompt or the repository is put into them. The only values they read are environment variables that Lair sets, and they read those as data (no `eval`, no `sh -c`).
- Detection on the remote is read-only, with one decision for each PR and a unique key, so a restart or a second poll never raises a second one.
- The owner's tool config (`owner_mcp_file`) is read only, never written, and is opened without following a symlink out of the repo (the rule `prompts.ts` uses).

### 4.10 Reliability

- `buildLaunch` is synchronous and pure, apart from writing the per-run files. Those writes happen before the spawn and are named by run id, so a retry overwrites them and doesn't add a second set.
- Every git call in the hooks has a timeout (10 s), and a timeout refuses the push. Every compare call has a timeout (10 s), and a timeout records `history_unknown`.
- When the server restarts, adopted runs keep their files. Files of runs that are no longer active are removed at start, after `reconcile`.

## 5. Acceptance tests

Each test drives the real entry point (the agents tick through `requestRun`, a real `git push` to a local bare repository, the review poll) and fakes one named boundary: the process spawner, the GitHub client, or the clock. The adapters are the built-in presets as they are on main.

| # | Name | Given | When | Then |
|---|---|---|---|---|
| AT-1 | `launch observe changes nothing` | `agents.launch.mode: observe`, adapter claude-code, bus off | a run starts | argv, env and prompt are byte-identical to `mode: off`. No file is written under `session_dir`. `started.data.launch.given` lists `bus:flag, header, git:hooks, git:identity` |
| AT-2 | `launch on gives the bus to a flag adapter` | `mode: on`, claude-code with `bus_via: flag`, bus.consume off | a run starts | env has `LAIR_BUS_TOKEN` and `LAIR_URL`. argv ends with `--mcp-config <session_dir>/lair-mcp-<run>.json`. The file has `mcpServers.lair` with an absolute command and no `env` key |
| AT-3 | `the token is in no file event or argv` | as AT-2 | the run starts, then ends | a scan of every file written, the `started` and `completed` events, the argv and the run log finds no token |
| AT-4 | `the registered server sees the run's token` | a new stub agent `fixtures/stubs/agent-launch.sh` (next to `agent-run.sh`), which starts the registered server command with its own environment, as the CLIs do | it calls `whoami` and `report DONE` | the bus records the report under that run. The queue file gets one line ending `[bus:<id>]` |
| AT-5 | `owner_file adapter without the bus server is a gap` | kiro with `owner_mcp_file`, the file has no `bus-mcp` server | a run starts, without `require`, then with `require: [bus]` | first: it starts with gap `bus:owner_file_missing`. Second: it isn't spawned, `detail` is `launch: bus:owner_file_missing`, and after 5 ticks there is one `launch` decision. A sixth tick adds no second decision |
| AT-6 | `mint failure is refused when bus is required` | the bus store fails to issue a token | a run starts, with `require: [bus]` | not spawned and retried with backoff. Without `require`, it starts with gap `bus:mint_failed` |
| AT-7 | `header names the task report channel and status file` | `header: on`, a builder run, `bus_via: cli` | a run starts | the prompt's first block is `<lair_run>` with the task, run, agent, `report.via: cli`, `status_file` equal to the absolute `queue_file`, and the tasks file in `never_write_status_to`. A task id holding `</lair_run>` stays inside the JSON string |
| AT-8 | `review and supervisor runs get their own report channel` | a review run and a supervisor run | they start | review: `report.command` uses `lair review-submit` and has no `branch`. Supervisor: `lair supervisor-answer` |
| AT-9 | `adapter queue_file other than the project's warns` | an adapter with `queue_file: other.md` | config load | one warning naming both paths. The run's `status_file` is the project's |
| AT-10 | `pre-push refuses a force push` | `git: on`, a branch pushed at A, then the agent amends to A' | `git push --force` | push exits non-zero with `refused: not a fast-forward of the remote`. The remote is still at A. A normal merge commit on top of A pushes |
| AT-11 | `pre-push refuses a push to main and a foreign identity` | as AT-10 | push to `main`, then push a commit authored by `someone@example.com` | both refused. The project's own hooks still ran on the allowed push (a marker file) |
| AT-12 | `identity comes from the project, not the worktree` | worktree `user.name=Placeholder`, project `identity` set | the stub agent commits | the commit's author and committer are the project identity |
| AT-13 | `commit-msg refuses attribution` | `git: on` | commit with `Generated with X`, and with a `Co-Authored-By` naming a tool address | both refused. A plain message is accepted |
| AT-14 | `merge guard refuses attribution in the PR body` | a PR whose body has `Generated with X`, commits clean | merge | refused, naming the pattern index, not the text |
| AT-15 | `rewrite on the remote is detected once` | review poll sees PR #7 at A, then at B with `compare(A,B).behindBy = 1` | two polls, a restart, a third poll | one `history_rewrite` event, and with `on_rewrite: decide` one decision. A compare timeout records `history_unknown`, never a clean head |
| AT-16 | `status in the tasks file is detected` | a run writes `- DONE <task> by <agent> ...` into the tasks file | the run ends | one `launch_gap status_in_wrong_file` with the line number. The event holds no line text |
| AT-17 | `bus_unused is detected` | a run with a token writes a queue line by hand and makes no bus call | the run ends | one `launch_gap bus_unused`. A run that reported through the bus gets none |
| AT-18 | `deny stub blocks a command but not the tool` | `deny_commands: [docker]` | the stub agent runs `docker ps` | exit 126 with the rule. The adapter's own command starts. `deny_commands` naming the adapter's own command is a config error |
| AT-19 | `contract per built-in adapter` | each of the nine presets, in `mode: on` | `buildLaunch` | a snapshot for each adapter: `bus_via`, argv extras, env names (not values), header present, git variables. A new preset with no snapshot fails the test |
| AT-20 | `files are removed when the run ends and at start` | a run ends, then a server starts with a file left by a run that is no longer active | end, start | no `lair-mcp-*`, `lair-hooks-*` or deny directory is left for runs that aren't active. An adopted active run keeps its files |

AT-19 is the contract test for each adapter, and the seed of the conformance suite in #114. Each test fails on main: the module, the fields and the events don't exist there.

## 6. Rollout

1. Ship with every part `off` (the defaults).
2. Turn on `agents.launch.mode: observe` for a project. For a week, read `started.data.launch.gaps` and the `launch_gap` events on the Agents view. Fix each agent tool's registration until `bus:*` gaps stop.
3. Turn on `header: on`, then `git: on`. Watch `history_rewrite` and the hooks' refusals in the run logs.
4. Turn on `bus: on` with `require: [bus]` once no run has had a `bus:*` gap for 3 days.
5. Roll back by setting a part, or `mode`, back to `observe` or `off`. This is a config reload with no restart, and the next spawn uses it.

## 7. PR plan

Each PR has its tests and its `docs/configuration.md` section, sits behind its switch (default `off`), and stays under ~600 changed lines that aren't tests.

1. **Contract builder and observe.** `launch.ts` (`buildLaunch`, `given`/`gaps`, and observe changing nothing), the config block and its validation, and `started.data.launch`. ATs 1, 19 (`given` only).
2. **Task header.** `<lair_run>` for every role, `status_file` from the project, the adapter `queue_file` warning, and removing the aider preset's `queue_file`. ATs 7, 8, 9.
3. **Bus registration.** `bus_via`, `mcp_config`, `owner_mcp_file`, the `{mcp_config_file}` placeholder, the token minted under `agents.launch.bus`, `require` with the refusal backoff and the decision, file clean-up, and checking each preset's default against its CLI's reference. ATs 2-6, 20.
4. **Git guards.** The hooks directory, the `GIT_CONFIG_*` variables, `pre-push` and `commit-msg`, and chaining to the project's own hooks. ATs 10-13.
5. **Remote detection and merge text.** `history_rewrite` in the review poll, `on_rewrite`, and the merge guard's attribution check of the title, body and messages. ATs 14, 15.
6. **Watch and checks.** `launch-watch.ts` (`bus_unused`, `status_in_wrong_file`), the header's `checks` and `host_rules`, `deny_commands` stubs, and the Agents view's gap column. ATs 16-18. Also the full AT-19 snapshot, and `docs/agents.md` replacing "Ensure agents write to the queue" with the contract.

PRs 2-6 depend on PR 1. PR 4 and PR 5 don't depend on each other.

## 8. Risks

- **A CLI changes its MCP flag or its environment handling.** AT-19 pins the argv, and AT-4 checks inheritance only against a stub. A real CLI that drops the environment shows up as `bus_unused` on its runs. The fix is `bus_via: owner_file` or `cli` for that adapter.
- **`core.hooksPath` collides with a project's hook manager.** Lair's hooks chain to the previous hooks path. A hook manager that sets `core.hooksPath` on each command would win over Lair's. AT-11 covers chaining, and the refusals in the logs show whether the guard is active.
- **Guards on the same user can be bypassed.** `--no-verify`, an absolute path or another git binary all get around them. Remote detection (§4.4) and the merge guard catch what the agent's host doesn't. Real isolation is [sandbox.md](sandbox.md).
- **The header grows into a second instructions file.** It holds only values derived from config, with a size cap, and its fields are fixed by this spec. Free text stays in `default_instructions`.
- **False `status_in_wrong_file`.** An owner editing the tasks file by hand during a run could match the patterns. The event names the line and records only. It never changes a run's outcome.
