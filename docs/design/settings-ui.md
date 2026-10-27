# Settings: every project setting from the dashboard

Goal: a developer never has to edit a project's YAML by hand. Every setting of every module can be read, changed,
checked and rolled back from the dashboard's **Settings** view, and a new project can be created there. The YAML file
stays the one place the configuration lives: Settings writes it, a hand edit is still welcome, and neither silently
overwrites the other.

Status: phase 1 is built (`src/server/settings/`, `src/client/components/Settings.tsx`). Phases 2 and 3 are planned.
The rules in [ROADMAP.md](ROADMAP.md#rules-every-new-module-follows) apply to all three.

## Principles

1. **The YAML is the store.** No second copy of the configuration (no database row, no JSON cache). Live reload
   ([configuration](../configuration.md#live-config-reload)) applies what Settings writes, exactly as it applies a hand
   edit.
2. **Nothing invalid is written.** A change is checked by the same parsers that live reload and startup use before a
   byte is written. A refused change leaves the file as it was.
3. **No silent clobbering.** Every save names the version of the file it was based on. When the file changed since
   (a hand edit, another browser), the save is refused with what changed, and nothing is written.
4. **Commands are confirmed, secrets are refused.** A change that makes Lair run something new needs the owner to see
   the exact argv and confirm it. A secret never goes into the YAML.
5. **Generic.** A module that adds a config block registers one small entry (its zod schema and a few hints); its form
   appears with no UI code. New fields of an existing block appear by themselves.
6. **The owner only.** Configuration reveals paths and commands, so even reading it needs the owner's session.

## Phase 1: settings forms, project create and edit (built)

### Storage and the write path

- The file edited is the project's effective file (`getConfigPath`: `projects/local/<id>.yaml` first, then
  `projects/<id>.yaml`). New projects go to `projects/local/<id>.yaml`.
- Form changes are applied to the parsed document with the `yaml` library's Document API (the library Lair already
  uses), node by node: a scalar is changed in place, so its comments, quoting and position stay; maps and lists are
  updated item by item. Keys nobody changed are never touched, unknown keys included. The raw YAML tab saves the text
  as typed.
- Writes are atomic: a temporary file in the same directory (`O_EXCL`, the old file's mode, else 0600), `fsync`,
  `rename` over the file, then `fsync` of the directory. A crash leaves the old file or the new one, never half of
  one.
- **Symlinks are refused.** The project file, `projects/` and `projects/local/` are checked with `lstat`: a symlink
  or anything but a regular file (a directory) is refused for reading and writing. `rename` replaces a directory entry,
  so even a symlink that appears between the check and the rename is replaced, not written through.
- **Optimistic concurrency.** Reads return the file's SHA-256. A save carries that hash (`baseHash`); a different hash
  on disk gives HTTP 409 with the current hash and the diff the save would now make (for form changes: the same
  changes re-applied to the current file), so the owner reviews and saves again. The hash is checked again right
  before the rename. Saves of the server itself are synchronous from read to rename, so two browsers can't interleave.

### Validation before any write

A candidate (the file after the change) is checked in this order, and the first failing stage refuses the save with
HTTP 422 and errors per field (`{path, message}`; a message no field owns has an empty path):

1. size (at most `MAX_CONFIG_BYTES`, 1 MiB, the same cap as loading: HTTP 413) and YAML syntax;
2. secrets (below);
3. `parseProjectConfig`, the text half of `loadProjectConfig` (required fields, `dragon_defaults`);
4. every module's own parser, through `ConfigReloader.validate()`: the exact checks live reload runs on a changed
   file (`serverModules`: delivery, watchdog, pipelines and executors, review, agents, triage, placement).

The parsers' messages already start with the field's path (`watchdog.interval_seconds: ...`), which is how errors are
shown under the field. `POST /api/settings/validate` runs all of this as a dry run and also returns the diff and the
command changes, so the UI previews a save before it is made.

### History and rollback

- Every accepted version is kept in `data/config-history/<project>/<version>.yaml` (mode 0600) with a
  `<version>.json` beside it: when, what (`create`, `save`, `restore`, or `file` for a version found on disk that
  Settings had not written, such as a hand edit, recorded before the save that replaces it), the file's hash, and who:
  the owner session's public id, never its value. The newest 50 versions are kept.
- A version found on disk that holds anything that is or looks like a secret (a value by its key or shape, any line
  by its shape, comments included) is never copied: only a note of it is kept (when, its hash), and it can't be
  shown or restored.
- Each version shows its diff from the version before it and to the current file. **Restore** saves that version's
  text through the same path as any save: validation, command confirmation, the 409 check, a new history entry.

### Schema-driven forms

- One registry (`src/server/settings/registry.ts`): `{ key, title, schema, hints, docs }` per section. A module's
  section is its top-level block and its zod schema (the one its parser uses, now exported). The core settings that
  have no zod parser (project, controls, dragons and models, adapters, machines, processes, bus, merge bar,
  orchestrator, gate runner) get descriptive schemas in `core-schemas.ts` that are only used to draw the forms: their
  real checks stay in `parseProjectConfig` and the existing parsers.
- zod is v3 (`zod@3.25`), whose classic schemas `z.toJSONSchema` (zod 4) does not read, so `json-schema.ts` converts
  the zod features Lair uses (objects, strict and passthrough, records, arrays, unions, discriminated unions, enums,
  literals, defaults, optionals, nullables, effects, pipelines, lazy) to JSON Schema. No new dependency.
- Hints, per field path (`*` matches any record key or list index): help text, a widget (`argv`, `list`, `globs`,
  `path`, `textarea`, `select`, `yaml`), known values to pick from (`agents`, `adapters`, `models`, `lanes`,
  `machines`) and `advanced`. Most widgets are inferred from the schema and the key (`*_cmd` and lists of strings
  under `actions`, `commands` or `probes` are argv lists, `paths` is a glob list, `adapter` picks an adapter), so
  hints stay few.
- Forms render from the JSON Schema: a section per entry, its `enabled` switch in the header, defaults shown as
  placeholders ("default: 60") and restored by clearing the field, advanced fields folded, unions and other shapes a
  form can't draw edited as a YAML snippet. Keys that no section knows (top level, or inside a block that allows them)
  are kept as they are and shown read-only, with a pointer to the YAML tab.
- The **YAML** tab edits the whole file, with the same validation, diff, confirmation and save path.

### Command-bearing fields

A field makes Lair execute something when its key is `*_cmd` (`dragon_start_cmd`, `branch_state_cmd`, `capacity_cmd`,
`update_cmd`, adapters' `start_cmd` and `stop_cmd`, delivery's `fetch_cmd` and `prepare_cmd`, placement's `load_cmd`
and `move_cmd`, ...), when it is an argv under `actions`, `commands`, `probes` or `hooks` (watchdog actions, triage
commands), a step's `run`, a process's `command`, a placement machine's `probe`, or one of `gate_script`, `kiro_cli`,
`ssh_cmd`; and a step's or process's `env` and `cwd`. The
rule is in `src/shared/settings-rules.ts`, by key name and value shape, so blocks that other modules add later are
covered; a hint can mark any other field. Hints mark the fields that are not commands but decide what Lair
runs or where it sends code and tokens as `sensitive`, which needs the same confirmation: a machine's `host`, `user`
and `key`, an environment's `compose_files`, `project_directory` and `deploy.repo`, `executors.github.checkout_action`
(it runs in CI with the repository's token), `review.api_url` (where the token is sent) and `review.merge.clone_url`.

A save that adds or changes one of them is refused with HTTP 428 and the exact before and after of each (the argv
lists as they will run), plus a digest of that list. The UI shows them and the owner confirms; the save is sent again
with `confirmCommands: <digest>`. A digest of other commands (the file changed, or the change did) is refused again, so
a confirmation covers exactly what was shown. Removing a command needs no confirmation.

### No secrets in config

A value is refused (HTTP 422, at its field) when its key names a secret (`token`, `secret`, `password`, `passphrase`,
`api_key`, `private_key`, `client_secret`, ...; `*_env`, `*_file` and `*_cmd` keys that point at one are fine) or when
it looks like one wherever it is: a private key block, a known token format (GitHub, GitLab, Slack, AWS, npm, Google,
`sk-...` API keys), or a URL with a password. The message points at `data/` files (mode 0600) and environment
variables, which the config names instead. The page shows "set" or "not set" for the secrets Lair knows: the owner
token file, the environment variables the config names (`token_env` keys, with their defaults), and
`LAIR_NODE_TOKEN`. Values never leave the server.

Comments are scanned for values shaped like a secret too (a comment has no key). No error message quotes a secret: a
parser's message (an enum's "received '...'") has every secret value of the config replaced by `[hidden]`, and a YAML
error keeps only its first line, not the source lines it quotes.

### Owner only, bounded

All routes are under `/api/settings`, already in `OWNER_ONLY_PREFIXES` (no CORS), behind `requireOwner()`, reads
included:

| Route | What |
|---|---|
| `GET /api/settings/modules` | the sections: JSON Schema, hints, docs link |
| `GET /api/settings/projects` | the projects, their files, whether Settings can write them |
| `GET /api/settings/projects/:id` | the file's text, hash, values, problems, unknown keys, known values, secret status |
| `PUT /api/settings/projects/:id` | save form changes (`changes`) or text (`yaml`), with `baseHash` and `confirmCommands` |
| `POST /api/settings/validate` | the same checks as a dry run (also for a new project) |
| `POST /api/settings/projects` | create a project |
| `POST /api/settings/repo` | check a repository path: a git work tree, its GitHub remote (`git remote -v`) |
| `GET /api/settings/projects/:id/history` | the versions |
| `GET /api/settings/projects/:id/history/:version` | a version's text and diffs |
| `POST /api/settings/projects/:id/history/:version/restore` | restore it (validated like any save) |

Bodies are capped (2 MiB + 64 KiB; the file itself at 1 MiB), as are the number of changes (500) and a path's depth
(32). Path segments `__proto__`, `constructor` and `prototype` are refused. `git` runs as argv with a timeout, with
`core.fsmonitor` off and no prompt, and the path can't start with `-`. The previous `GET /api/settings` (open) and
`POST /api/settings` (an unvalidated rewrite that dropped comments and left `.backup-*` files in `projects/local/`)
are removed; `POST /api/settings/test-machine` stays as it was (owner only).

### Project create

The wizard asks for the id (a project name: letters, digits, `.`, `_`, `-`), a display name and the repository path,
which must be a git work tree; it proposes the GitHub `owner/name` from the remotes (`origin` first), and the queue,
agents and gates paths (`<repo>/work/queue.md`, `<repo>/work/agents`, `<repo>/work/gates`). Then the modules to
switch on: each section with an `enabled` switch, written as `<block>: {enabled: true}` so their defaults apply. A dry
run shows the file and any error per field before it is written to `projects/local/<id>.yaml` (refused with 409 when
the project exists), and live reload starts its modules.

### UI

- **Settings** in the nav. Signed out, the view shows the sign-in hint and requests nothing.
- A project whose file is in `projects/` (tracked by git in Lair's checkout, unlike `projects/local/`) shows that
  saving changes a tracked file, and how to move it to `projects/local/`.
- A project list with **New project**, and per project the tabs **Form**, **YAML** and **History**.
- **Review changes** shows the diff, every error at its field and in a list, and the command changes with a
  confirmation box; **Save** is enabled only when the dry run passed. A 409 shows what changed and offers to review
  the changes again on top of the current file.

### Tests (through the real routes and parsers, a temporary `projects/` and `data/`)

Owner only (403 for no session, a browser that is not signed in, and an invalid session, on every route); an invalid
change refused with nothing written; a valid change written with comments kept and a reload run by the reloader; 409
on a concurrent hand edit; a symlink refused; a command change refused without confirmation and accepted with it; a
secret refused; history and restore; project create; a form for every registered module and every module block that
live reload knows; unknown keys preserved; the size cap.

## Phase 2: guided setup actions (planned)

Each action is a button next to the settings it fills, and each writes through phase 1's save path (validated,
confirmed, in the history). New routes go under `/api/settings/actions/...`, owner only.

1. **Gate-signing node key.** Generate an Ed25519 key pair for a gate node (`lair-node keygen`, argv), keep the private
   key where the node runs (never in `data/` of the server unless the node is this machine, mode 0600), and register
   the public key as a trusted node: `triage.trusted_nodes[]` (`id`, `public_key_file`) and, for signed merge gates,
   `review.merge.gate.node_keys`. Shows the key's fingerprint; never returns the private key.
2. **Add a machine** with a **Test** button: fill `machines.<id>` (type, host, user, key path, runners), then run its
   probe (the existing machine health check, and the probes other modules add) and show the result line by line
   (reachable, SSH auth, the runner lanes, free memory and load). Saving does not wait for the test; a failed test is
   shown, not enforced.
3. **Test an agent adapter.** Run the adapter's start command in a dry mode where it supports one (version or help
   argv), with the agent environment rules (no server secrets), a timeout and captured output; show which
   placeholders it uses and whether the binary resolves.
4. **Preview review tiers against an open PR.** Pick an open PR; run the review module's tier rules and reviewer
   selection on its changed files and labels with the edited (unsaved) `review:` block, and show the tier, the rule
   that set it, and the reviewers it would ask. Nothing is posted to the PR.
5. **Agents fill tasks and prompts.** Edit the fill tasks file (`agents.fill.tasks_file`, lines
   `<agent>|<name>|<task>|<description>`) as a table, and the prompt files (`prompt_files`) as text, with the same
   hash-based conflict check, atomic writes and history as the project file; paths must stay inside the repository
   or `prompts_dir`, and symlinks are refused.

## Phase 3: auto-detection (planned)

Read the repository and propose settings, shown as a diff the owner accepts per item (never saved by itself):

- **Git remote** → `github`, `review.repo`, `executors.github.repo`; the default branch → `review.default_branch`,
  `triage.default_branch`, `delivery...deploy.ref`.
- **CI workflows** (`.github/workflows/*.yml`): job and check names → `review.merge.gate.required` (checks source);
  whether the repository is public → which `executors.github` options apply (no self-hosted for public ones);
  existing Lair workflow → `executors.github.workflow`.
- **An existing gate queue** (a directory with `queue/*.req` and `results/*.rc`) → `gates_dir` and lanes; a queue or
  status file → `queue_file`; agent logs → `agents_dir`; `dragons.txt` → dragons.
- **Compose files** → a `delivery.environments` entry with its services; **package scripts** (`test`, `lint`,
  `build`) → a `pipelines` draft.

Detection only reads files (bounded, no symlinks followed out of the repository) and runs `git` as argv; it never runs
the project's own scripts.

## Decided

- **A dedicated 428 for command confirmation**, not a 409 or 422: the change is valid and current, it only needs the
  owner's explicit yes, bound to a digest of what was shown.
- **Form saves send changes, not the whole object**, so keys nobody touched (comments, unknown keys, keys added by a
  newer module the browser doesn't know) can't be lost, and a 409 can re-apply the same changes to the new file.
- **Secrets refused in the whole file**, not only in changed fields: a save would otherwise copy an existing secret
  into the history. The error names every field to move out.
- **Core settings get descriptive schemas** rather than new parsers: changing what loads would be a behaviour change
  for every existing project; their forms are a view, their checks stay where they are.
