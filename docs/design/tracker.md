# Tracker Module Design

Lair keeps GitHub issues, Projects v2 boards and milestones in sync with its
tasks, runs and PRs. The module is off unless a project sets `tracker.enabled:
true`.

## Purpose

The owner had every task, bug and feature on GitHub (issues, Projects boards
with Status columns, milestones with due dates). Instead of manually moving
cards or closing issues, Lair keeps GitHub true to what is actually happening.

Generic: any project with a GitHub repo and a user or org Project. Other
trackers (GitLab, Jira, Linear) come later through the same provider interface.

## Architecture

```
Events (bus)              Tracker Service              GitHub API
─────────────────────────────────────────────────────────────────
agent.run.started    →   moveToStatus(in_progress)  →  GraphQL: update field
agent.run.ended      →   moveToStatus(done)         →  REST: close issue
review.merged        →   closeIssue                 →  REST: PATCH /issues/:n
planner.changed      →   linkTaskToIssue            →  GraphQL: add to project
                         reconcile()                →  fix drift periodically
```

### Components

- **TrackerService** (`service.ts`): Event handlers, reconciliation, write
  budget, observe/act mode.
- **TrackerStore** (`store.ts`): SQLite tables for links, sync state, write
  history.
- **GitHubProjectsClient** (`github-projects.ts`): GraphQL for Projects v2,
  REST for issues and milestones.
- **Config** (`config.ts`): The `tracker:` block validation with defaults.

## Mode

- `off`: Module is loaded but does nothing.
- `observe`: Records what would be written but sends nothing to GitHub. Useful
  for dry-run verification.
- `act`: Writes to GitHub (moves cards, closes issues, adds labels).

## Link between tasks and issues

A task is linked to an issue by:

1. The task description naming `Closes #N`, `#N` or an issue URL.
2. An exact title match (adopt existing issue).
3. Creating a new issue when `create_issues_for_new_tasks: true` and `mode:
   act`.

Links are stored in `tracker_links` and persist across restarts.

## Events → board updates

| Event | Board action |
|-------|-------------|
| `agent.run.started` | Move to In progress, set Agent field |
| `agent.run.ended` (done) | Move to Done, close issue |
| `agent.run.ended` (blocked) | Add `blocked` label, comment with reason |
| `review.merged` | Move to Done, close linked issue |
| `planner.changed` (added) | Link task, move to Backlog or Ready |
| `planner.changed` (done) | Move to Done, close issue |

All updates are idempotent: a second event for the same state is a no-op.

## Reconciliation

A periodic full reconcile (every 15 minutes by default) fixes drift: if someone
moves a card by hand to the wrong column, reconcile moves it back to the
expected status. Every drift fix is counted and auditable.

## Rate limiting

GitHub's rate limits are respected:

- A write budget per minute (default 30) prevents bursts.
- 403/429 responses trigger a backoff.
- Rate-limited writes are recorded as `rate_limited` in the write history.

## Milestones

- Milestones with zero open issues are closed when `close_when_complete: true`.
- A milestone is reopened if an issue under it reopens.
- Due dates are the owner's: Lair never sets or changes them.

## Security

- The token never reaches agents (rule 2 from lair-shared-rules.md).
- Text from agents (descriptions, blocked reasons) is bounded and redacted
  before it goes to GitHub.
- `redact_patterns` is applied to every outgoing text.

## Configuration

See [configuration.md#tracker](../configuration.md#tracker) for the full
reference. Key settings:

```yaml
tracker:
  enabled: true
  mode: observe  # off | observe | act
  repo: owner/repo  # or from project.github
  project:
    owner: my-org
    number: 1
  status_field: Status
  status_options:
    backlog: Backlog
    ready: Ready
    in_progress: In progress
    in_review: In review
    done: Done
  agent_field: Agent
  create_issues_for_new_tasks: false
  redact_patterns:
    - "/private/"
```

## Status view

`GET /api/tracker/status?project=<name>` returns:

- `enabled`, `mode`, `repo`, `projectNumber`, `projectUrl`
- `syncState`: last reconcile, drift count, errors
- `links`: task-to-issue mappings
- `recentWrites`: audit log of operations
- `warnings`, `errors`

## Future work (PR 2)

- Routes for the Tracker tab in the dashboard
- Full wiring into server index.ts
- Live reload integration
