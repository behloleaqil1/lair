# Lair phase 1 spec (read-only dashboard)

A SEPARATE app (not part of any product repo) to see and later control the AI coding fleet: the
orchestrators, the builder agents ("dragons"), the gate queue and the PRs. It must be project-agnostic from day one.

## Phase 1 scope: read-only, local
- A local web app at `http://127.0.0.1:4777` (bind to localhost only). One command to start: `npm start`; `npm run dev`
  for development. TypeScript everywhere: a small Node server (Fastify) that reads files and runs read-only commands, and
  a React + Vite client. Auto-refresh every 10 s. NO write actions in phase 1 (no buttons that change anything).
- Configuration per project in `projects/<name>.yaml`. An example configuration:
  - `repo`: /home/user/my-project (git; `origin/main` is main); `github`: example-org/my-project
    (PRs through the `gh` CLI, already logged in);
  - `queue_file`: agents/queue.md (agents append lines starting `- WAITING`,
    `- DONE`, `- BLOCKED`, `- PROGRESS`, `- TICK`, or `- (Orchestrator, …)`);
  - `agents_dir`: agents (`dragons.txt` = id, name, task; `<id>.running/` dir = a run in
    progress; `<id>-<UTC>.log` = run logs; `owners.txt` = task ownership, when it exists);
  - `gates_dir`: gates (`queue/<lane>.<pri>.<id>.req` queued, `.req.run` running,
    `.superseded` cancelled; `results/<id>.rc` + `.log`; `runner.log`);
  - `status_cmd`: bin/status.sh (may not exist yet: show "not installed");
  - `machines`: local machine and optional SSH machines (`ssh -i ~/.ssh/example_key -o IdentitiesOnly=yes -o BatchMode=yes
    -o ConnectTimeout=4 deploy@198.51.100.10 "echo up"`, checked at most once a minute).
  Every path, regex and command comes from the config; no project-specific path is hard-coded in the code.

## Views
1. **Overview:** main head + date, the local stack's head if configured, PRs merged in the last 24 h, the PROBLEMS list
   (from `status_cmd` if installed, otherwise the app's own checks: a `.req.run` older than 2 h, no runner process for a
   lane with queued requests, duplicate queued requests for one track, a running agent whose log is silent > 45 min),
   counts (agents running/idle, gates queued/running).
2. **Dragons:** one row per agent from `dragons.txt`: name, id, task, running? (lock dir), last log time + last
   meaningful line (skip `[INFO]`/`[tool]`), and per-agent stats from the queue file over the last 7 days: DONE /
   WAITING / BLOCKED counts, gates submitted and their rc (match gate ids that appear in the agent's lines), "first-time
   pass rate", early stops (a WAITING that wasn't followed by a gate). Click a row: the agent's recent queue lines and
   its latest log tail.
3. **Gates:** per lane: running (id, branch/track, age, current step from the log's last `STEP`/`PASS`/`FAIL` line) and
   queued (priority order); recent results (last 24 h) with rc and the failing step name; a gate detail page with the
   log tail.
4. **PRs:** open PRs (`gh pr list --json number,title,headRefName,headRefOid,mergeable,updatedAt`), each with its
   latest gate for that head sha (from `results/`), "merge-ready" when the latest gate at the PR head is rc 0.
5. **Orchestrator:** the last 30 `TICK` lines, whether the STOP file exists, and whether its LaunchAgent is loaded
   (`launchctl print gui/<uid>/<label>`; the label comes from the config).
6. **Machines:** each machine up/down, its runners (process check) and the last time it ran a gate.

## Quality bar
- Parsers (queue lines, gate file names, results, dragons.txt, logs) are pure functions with unit tests on fixture
  files copied from the real formats (strip anything sensitive); a smoke test renders every view from a fixture
  project. `npm test` must pass; `npm run lint` and `npm run typecheck` too.
- It never writes anywhere outside its own folder, never reads `.env` or credential files, and never shows secrets.
  Commands it runs are read-only (`git log/rev-parse/fetch`, `gh pr list`, `ps`, `launchctl print`, the ssh "echo up").
- A missing file or an offline machine shows as "unknown", never crashes a view.
- README: what it is, how to run it, how to add a project config.

## Later phases (not now)
2. Controls (pause/resume the orchestrator, start/stop/assign agents, cancel/re-run gates, approve merges), always
   through the project's own scripts, with confirmations. 3. Extract the generic orchestration kit (gate runner, agent
   launcher, rules templates) into this repo with an installer. 4. Several projects and orchestrators in one UI.
