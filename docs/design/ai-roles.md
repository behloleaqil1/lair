# AI roles: any tool, any model

> Status: part built (A6-1, below). Roadmap: [ROADMAP.md](ROADMAP.md) A6. Related: [supervisor.md](supervisor.md),
> [settings-v2.md](settings-v2.md), [autonomy.md §5-6](autonomy.md) (reviews, agents). Reference:
> [configuration.md](../configuration.md#ai-tools-profiles-and-roles).

## What is built, and what remains

| Part | What | State |
|---|---|---|
| **A6-1** | `ai.profiles` and `ai.roles`, checked when the project loads (errors name the key); a dragon's `profile:`; a dragon that names nothing runs on its role's first profile (`build`, or `plan` for the planner agent); failover along the role; reviewer pools by role (`role:review.<tier>`; a tier without a pool takes its role), with `different_model` across every profile and fallback; the presets Codex CLI, Gemini CLI, OpenCode, Goose and GitHub Copilot CLI (experimental); model lists (`models_cmd` with a parser, `kiro` or `lines`, else a known list), cached for an hour; sign-in checks (`auth_check_cmd`, `login_hint`) per machine, here and over SSH; a tool signed out on this machine starts nothing here, with one decision per tool; `GET /api/ai/tools`, `GET /api/ai/models` and `POST /api/ai/models/refresh` (owner only); the Settings registry entry | built (`src/server/ai/`) |
| **A6-2** | The write-only secret store for API-key tools (OS keychain, Secret Service, else a 0600 file), a profile's `secret_env`, rotation and removal | to do |
| **A6-3** | Usage and cost per profile and role, budgets per role; reviewer calibration, and the warning for a weak profile on RED | to do |
| **A6-4** | The supervisor started through `ai.roles.supervise` (with the supervisor, A3); ACP adapters; the conformance suite for every preset (B3) | to do |
| **A7** | The UI: Settings → AI (tools and sign-in per machine, model dropdowns refilled per tool, "Other…" with its warning, "not offered any more", profiles, role dropdowns), on the APIs above | to do ([settings-v2.md](settings-v2.md)) |

Not in A6-1: a model a tool no longer lists is not yet flagged on the dragons and roles that use it (the lists are there; the check
is A7's), and the agents module starts its runs on this machine only, so only this machine's sign-in state refuses a start (SSH
machines are checked and shown).

Lair must not depend on one AI vendor, one agent tool or one model. A team on Kiro, a team on Claude Code, a team on
Cursor, Codex, Gemini CLI or Aider, a team running local models: each should get the same Lair. Today a dragon names
an adapter and a model. This design makes the choice of AI a first-class, per-role decision that any engineer can
make from the dashboard, and says how Lair reaches those tools without holding their credentials.

## Concepts

| Term | What it is | Example |
|---|---|---|
| **Tool** | An agent CLI Lair starts, through an adapter (start, stop, resume, status, log) | Kiro CLI, Claude Code, Cursor Agent, Codex CLI, Gemini CLI, Aider, OpenCode, Goose; any custom one |
| **Model** | What the tool runs. Free text: Lair never hard-codes a model list | `claude-opus-4.5`, `gpt-5-codex`, `gemini-2.5-pro`, `qwen3-coder` |
| **Profile** | A named tool + model + options (effort, flags, machine) | `kiro-opus`: Kiro CLI, `claude-opus-4.5` |
| **Role** | A job Lair gives an AI | build, review (per risk tier), plan, triage, supervise |

A role points at an ordered list of profiles: the first is used, and the next ones are fallbacks. The agents module's
existing failover (cooldowns, transient errors, `max_failovers`) applies unchanged.

```yaml
ai:
  profiles:
    kiro-opus:   { tool: kiro, model: claude-opus-4.5 }
    kiro-cheap:  { tool: kiro, model: claude-haiku-4.5 }
    claude-best: { tool: claude-code, model: <the strongest model your plan offers> }
  roles:
    build:      [kiro-opus]
    review:
      red:      [claude-best, kiro-opus]     # the strongest reviewer first
      amber:    [kiro-opus]
      green:    [kiro-cheap]
    plan:       [kiro-opus]
    supervise:  [kiro-opus]
```

A dragon can still name its own profile (a specialist), and a role can be left unset (that job is then not automated).

## Tools

- **Built-in presets:**
  - today: Kiro CLI, Claude Code, Cursor Agent, Aider;
  - added: Codex CLI, Gemini CLI, OpenCode, Goose and GitHub Copilot CLI, as presets only.
  - A preset is a tested start command, plus its resume, status and log conventions. Lair never bundles or installs a tool.
- **Custom tools:** a YAML adapter, as today. The adapter conformance suite (roadmap B3) says what an adapter must do
  and checks it against a fake tool, so a community adapter can be trusted without core changes.
- **ACP** (Agent Client Protocol), as the long-term path: several agent tools speak it (the Kiro CLI already does).
  An ACP adapter gives Lair structured progress, tool calls and usage instead of log scraping, and one adapter covers
  every ACP tool.
- **Models: a dropdown of what the chosen tool offers.** Every place that takes a model is a dropdown filled from that
  tool's own list: a dragon, a profile, and each role and fallback. It is refilled when the tool changes.
  - **Where the list comes from:**
    - each preset has a `models_cmd` and a parser (for Kiro, `kiro-cli chat --list-models`). Lair runs it on each
      machine the tool is used on, with a timeout, and caches the result (1 h, plus a Refresh button);
    - the dropdown shows each model with the tool's own notes (default marked, cost multiplier, context size);
    - a tool with no list command ships a known list in its preset.
  - **Typing still works.** An "Other…" entry accepts any model name, since tools add models faster than Lair
    releases. A name the tool doesn't list is saved with a warning, never refused.
  - **Checks:**
    - a model that disappears from a tool's list shows as "not offered any more" on every dragon and role using it;
    - a model missing on one machine is flagged per machine.

## Authentication: Lair never logs in for you

Lair never stores, asks for or forwards the credentials of a subscription you sign in to. It only checks that a tool
is ready on a machine and tells you the exact command to fix it when it isn't. There are two kinds of tool.

1. **Account sign-in tools** (Kiro, Claude Code, Cursor, Gemini CLI, Copilot CLI, Codex with an account).
   - You sign in once per machine, in a terminal, as the OS user the agents run as: `kiro-cli login`,
     `claude login`, and so on. The tool keeps its own token in its own place.
   - Each preset has an `auth_check_cmd` (e.g. `kiro-cli whoami`) that Lair runs with a timeout. Settings → AI then
     shows per machine:
     - "Signed in (as …)";
     - "Not signed in: run `kiro-cli login` in Terminal on this machine";
     - "Not installed".
   - Lair never reads the tool's token file.
2. **API-key tools** (Aider, any OpenAI-compatible or Anthropic API endpoint, hosted or local).
   - Keys are entered once in Settings and stored in Lair's secret store: the OS keychain on macOS, Secret Service
     on Linux, otherwise a 0600 file in `data/secrets/`.
   - The form is write-only. A key is never shown again, never written to project YAML, never logged and never in
     an API response.
   - A profile names the secret it needs, e.g. `secret_env: { OPENAI_API_KEY: openai-main }`. Lair puts that one
     variable into that one process's environment and nothing else: rule 2 still holds, and an agent never sees
     Lair's own environment, the owner token or another profile's key.
   - Keys can be rotated and removed from the same page. Removing one stops new starts of the profiles that use it.
   - Local models (Ollama, LM Studio) need no key: the profile points at the local endpoint.

Remote machines (SSH runners, lair-node) are checked the same way, per machine: a tool signed in on the Mac isn't
signed in on the build box.

## Usage, cost and quality

- **Usage per profile and role:** runs, minutes and the tool's own usage lines where it prints them (credits,
  tokens). The budgets that exist today can be set per role, e.g. "reviews may use at most N runs a day".
- **Reviewer quality is measured, not assumed.**
  - A review role can be calibrated. Lair runs blind reviews of PRs with a known reference review, then shows recall
    (blockers found) and false alarms per profile.
  - Settings shows a profile's last calibration next to the review tier it is assigned to, and warns when an
    uncalibrated or weak profile is put on the RED tier.
- **Switching** a role's profile is one dropdown. It applies to new runs; running ones finish as they are.

## The supervisor is a role

The supervisor ([supervisor.md](supervisor.md)) is started like any other role, through `ai.roles.supervise`, so it
runs on whatever tool and model the team uses: Kiro for a Kiro team, a local model for an offline team. It talks to
Lair through the ops API (MCP), which any MCP-capable tool can use.

## Acceptance

- One project runs builders on tool A and reviewers on tool B, and both appear in Work with their tool and model.
- On a dragon, choosing tool A then tool B refills the model dropdown with B's own models, read from B's list command
  (a fake tool in tests). "Other…" saves a typed model with a warning.
- Changing `review.amber` in Settings makes the next AMBER review start on the new profile. A failing first profile
  falls back to the second.
- On a machine where the tool is signed out, Settings → AI shows "Not signed in" with the exact command. No start is
  tried on that machine for that tool, and the Decision Inbox gets one notice, not one per agent.
- An API-key profile's process has its one key variable and nothing else from Lair. The key appears in no log, no
  YAML file and no response. Tested by scanning everything written during a run.
- The conformance suite passes for every preset against a fake tool.
