# Lair phase 2: the command bar and controls

Phase 1 shows; phase 2 lets the owner talk to the fleet and act, without a terminal. No private details: every path
and command comes from the project config (see [CONTRIBUTING.md](../../CONTRIBUTING.md)). Status: partly built; the
write-request token in §3 is not built, and there is no authentication today.

## 1. The command bar (prompting)
An always-visible bar at the top of every view ("Tell the fleet…") with three modes:
1. **Ask** (default, read-only). Lair starts a one-off run of the project's `ask_cmd` with the question and a preamble
   "QUESTION MODE: change nothing; answer only from commands you run now". The answer streams into a side panel. Several
   asks may run at once. The `ask_cmd` can run any AI agent headless.
2. **Instruct the orchestrator.** The text is appended to the project's `inbox_file` as
   `- OWNER <UTC time> [<id>]: <text>`. The orchestrator handles open inbox items FIRST on its next tick and answers in
   `outbox_file` as `- REPLY <id> <UTC time> by <agent>: <what it did>`. Lair shows each instruction as a thread
   (pending → answered). A "Run a tick now" button (`tick_now_cmd`) is enabled only when no tick is running.
3. **Send a dragon a task.** From the Dragons view: prompt text + a task id (branch). Lair runs `agent_run_cmd` with the
   task id; when the agent is busy or another agent owns the task, the refusal is shown, not hidden.
- "Ask about this" on any PR, gate, dragon or problem pre-fills the bar with its id and context.
- Every prompt and its answer is kept in Lair's own `data/` folder (gitignored) and is searchable.

## 2. Controls (buttons)
Each button runs ONE command from the project config; Lair never edits project files itself, except appending to the
inbox file.
- **Orchestrator:** pause / resume (`pause_cmd` / `resume_cmd`, e.g. create or remove a STOP file), run a tick now.
- **Dragons:** start with a task (above), stop a run (`agent_stop_cmd`), release a task (`agent_release_cmd`).
- **Gates:** submit a gate for a branch (`gate_submit_cmd`: track, scope, lane, priority), replace a queued request,
  mark a stuck one (`gate_stuck_cmd`).
- **PRs:** merge, enabled only when the merge bar passes and shown as a checklist: the latest gate rc 0 at the PR's
  exact head sha, every required step present in that gate's log, a review recorded by a different agent. It runs
  `merge_cmd` with the head sha (`--match-head-commit`). Type-to-confirm.
- **Backlog:** list READY items from `backlog_file`; "assign" sends one to a free dragon (via the inbox, so the
  orchestrator stays the only one starting work, or directly with `agent_run_cmd` when the config allows it).
- **Decisions:** queue lines tagged `OWNER?` show as an "Owner decisions" list; each has an answer box whose text goes
  to the inbox.

## 3. Safety
- Bound to 127.0.0.1. At first start, Lair creates a random owner token in `data/`; every write request needs it
  (an httpOnly cookie set by a one-time login link printed in the terminal), plus CSRF protection.
- Commands run as argument arrays, never through a shell; user text is passed as one argument or a temp file. Lair
  runs only commands named in the config.
- Confirmation dialogs for merge, stop, replace, mark stuck and pause.
- `data/audit.log`: every action (time, action, command, exit code, output tail), shown in an Activity view.
- `read_only: true` in the config disables every write, and that's the example config's default.

## 4. Config additions (`projects/<name>.yaml`)
`inbox_file`, `outbox_file`, `ask_cmd`, `tick_now_cmd`, `pause_cmd`, `resume_cmd`, `agent_run_cmd`, `agent_stop_cmd`,
`agent_release_cmd`, `gate_submit_cmd`, `gate_stuck_cmd`, `merge_cmd`, `merge_bar` (required steps, review rule),
`backlog_file`, `read_only`, `allow_direct_assign`.

## 5. Quality bar
Unit tests: the command builder (user text like `x; rm -rf ~` stays ONE argument and never reaches a shell), the merge
bar, the inbox/outbox parser and thread matching. An integration test with a fake project whose commands are stub
scripts that record their arguments. The example project uses those stubs. README: a "Controls and safety" section.
`npm test`, `npm run lint` and `npm run typecheck` pass.
