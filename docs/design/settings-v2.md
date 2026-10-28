# Settings v2, and Lair's look and feel

> Status: T1 built; S2-1 in part (the shell, search, save bar and Overview: `src/client/components/Settings.tsx`), the
> AI and Team pages next. Roadmap: [ROADMAP.md](ROADMAP.md) A7. Builds on [settings-ui.md](settings-ui.md) (phase 1:
> the write path, validation, history and the schema registry stay as they are). Related: [ai-roles.md](ai-roles.md).

Phase 1 made every setting editable from the dashboard. But its forms mirror the YAML file: one section per
top-level key, field names as labels, and everything shown at once. An engineer has to know the file to use the page.
Settings v2 keeps all of that power and changes how it is presented, so that someone setting up their first project
and someone tuning a fleet of 50 agents are both at home.

## Principles

1. **Organised by task, not by file.** Pages answer "what do I want to do?" (add an agent, change who reviews, add a
   machine), not "which YAML key is this?".
2. **Plain language first, the key second.** Every field has:
   - a label in words;
   - one line of help;
   - its default;
   - what changes when you change it;
   - the YAML key, shown small, for experts and for searching.
3. **Progressive disclosure.** Three levels:
   - **Basic:** what most teams touch.
   - **Advanced:** folded.
   - **YAML:** the whole file, as today.

   A registry hint `level: basic | advanced | expert` places each field. Nothing is hidden for good: search finds
   every field at every level.
4. **Safe by default.** The phase-1 write path is unchanged: dry run, a diff, confirmation for commands and
   sensitive fields, history and restore. A sticky "N unsaved changes · Review and save" bar replaces per-section
   saves.
5. **Test it where you set it.** Each thing that can be checked has a button next to it:
   - **AI tool:** check sign-in, list models.
   - **Machine:** SSH, capacity.
   - **Notification:** send a test.
   - **Gate pipeline:** dry run.
   - **Command:** run `--help`.
6. **Customizable without code.** Modules register their own pages and fields through the registry, and unknown keys
   are kept and shown read-only, as today. Everything the UI does is also possible in YAML, and round-trips.

## Pages

| Page | What it holds | Basic level |
|---|---|---|
| **Overview** | A setup checklist with a status for each part: repository, AI tools signed in, agents, gates, machines, notifications, reviews. A broken part links to its fix | the checklist |
| **AI** | Tools and their sign-in per machine, models, profiles, and **roles**: who builds, who reviews per tier, who plans and who supervises ([ai-roles.md](ai-roles.md)); API keys (write-only) | role dropdowns, sign-in status |
| **Team** | The agents as a table: name, role, profile (tool + model), machine, state. Add or edit in a side drawer. Bulk change ("move these 5 to profile X") | the table, add an agent |
| **Work** | Where tasks come from (tasks file or planner), limits (max active, waits, recovery budget) and the capacity check | max active, the tasks source |
| **Gates** | Pipelines, lanes, an external gate queue, placement, triage and re-checks | the pipeline list |
| **Machines** | Machines and nodes, slots, reachability; add one with a guided SSH check | the machine list |
| **Reviews and merging** | Risk tiers (paths to tiers), reviewers per tier (a role from AI), the merge policy, branch protection | tiers and reviewers |
| **Notifications** | Desktop, phone (ntfy), reminders, what counts as an action item | on/off, test |
| **Delivery** | Environments and deploy targets | the environment list |
| **Advanced** | Watchdog and playbooks, planner, supervisor autonomy, retention, the raw YAML, history | — |

A settings search box (⌘K) jumps to any field by its label, help text or YAML key.

**Templates for a new project:**
- **Solo, one machine:** one builder, self-review on GREEN, local gates.
- **Small team:** builders, peer review on AMBER, CI gates.
- **Fleet:** remote runners, placement, a supervisor.

A template fills the forms. It never hides anything.

## Patterns, used on every page

- **Edit in a drawer.** A list row opens a side drawer with its form. The list stays visible, so the context isn't
  lost.
- **Inline validation** as you type, with the server's error at the field after the dry run.
- **Empty states** say what the thing is, why you'd want it, and give one button to add the first one.
- **"What does this do?"** A short explanation panel per page, with a link to the docs section.
- **Status everywhere uses the same badges and words**, on Home, Work, Gates and Settings alike: ok, waiting,
  attention, failing, off.

## Look and feel (the whole dashboard)

- **Design tokens** in one file for colour, spacing (a 4 px scale), type scale, radius, elevation and motion. They
  replace ad-hoc styles.
- **Light, dark and system themes,** with AA contrast in both.
- **Colour:**
  - a calm neutral base, one accent colour, and semantic colours for success, warning, danger and info;
  - status colours are never the only signal: each has an icon and a word.
- **Type:** the system UI font stack (no external font requests; Lair is local-first), with a monospace face for
  ids, commands and logs. Two densities: comfortable (default) and compact (for big fleets).
- **A small component kit** used by every view: Button, Field, Select, Combobox, Switch, Table (sortable, sticky
  header), Badge, Drawer, Dialog, Tabs, Toast, Tooltip, EmptyState, CodeBlock and Skeleton. This replaces one-off
  markup, so the views look and behave the same.
- **Layout:**
  - **Navigation:** a left nav that collapses on narrow screens, with a project switcher at the top and Lair's
    status and owner state at the bottom.
  - **Detail pages:** breadcrumbs and a page header (title, status, actions).
- **Accessibility:**
  - every control is labelled, and focus is visible;
  - keyboard paths for every action;
  - reduced motion is respected;
  - an axe check runs in CI on every view.

## Phases

| Phase | Delivers | Acceptance (summary) |
|---|---|---|
| T1 (built) | Tokens, themes, the component kit; the existing views moved onto it with no behaviour change (`src/client/ui/`) | Every view renders with the kit in light and dark; axe is clean on every view; no client test changes behaviour |
| S2-1 (part built: the shell, search, save bar and Overview; the AI and Team pages next) | The new Settings shell: page list, search, sticky save bar, drawers; Overview checklist; AI and Team pages ([ai-roles.md](ai-roles.md) roles and sign-in status) | A new user sets the reviewer for AMBER from a dropdown and saves, with no YAML seen. The diff shows exactly that key |
| S2-2 | The remaining pages (Work, Gates, Machines, Reviews and merging, Notifications, Delivery, Advanced); registry levels and help for every field; templates | Every field of the schema is reachable from a page or search; every field has a label, help and a default; round-trip tests UI → YAML → UI |
| S2-3 | Test-it buttons (AI sign-in, models, machines, notifications, pipelines); guided "add a machine" and "add an AI tool" | Each button runs its check through the module's own route, with a timeout, and shows the result and the fix |
