# Changelog

Changes that need your attention when you upgrade Lair. Lair is 0.x: anything can change between versions, and this
file lists what needs action on your side.

## Unreleased

- **Outcome tracker (off by default).** `outcome_tracker:` in `data/server.yaml` turns on a read-only tracker that
  records `outcome` (good / bad / unknown) with structured evidence on answered decisions; the brain trainer reads
  `bad` as a negative example. The decisions file gets three nullable columns the first time it is opened (nothing to
  do). See [Outcome tracker](docs/configuration.md#outcome-tracker).

- **Ready guard fixes.** The planner settles a done line through the same guard as fill; the PR and head are read from the bus line's tail (or the PR the task names), a line with no PR or head for PR work is refused, a PR on another agent's branch is refused, pending CI or an unreachable host is held for at most `fill.ready_wait_minutes` and then asked once, GitHub calls time out and back off on rate limits, and host text in the next prompt is fenced as data.
- **Ready guard (off by default).** `agents.fill.ready_guard: true` refuses a done line that names a PR whose CI is
  red or pending, whose branch is behind or conflicting, whose gate did not pass at the head, or that lacks a
  finding-to-commit map; the agent gets the reason as its next instruction. See
  [Fill](docs/configuration.md#fill).

- **Brain trainer (off by default).** `brain_trainer:` in `data/server.yaml` turns on a nightly shadow-trained
  classifier for decisions; it needs the image built from `brain-trainer/` (named in the config by its `sha256:` id,
  never by a tag) and a non-root Lair user, and it never answers a decision. See
  [Brain trainer](docs/configuration.md#brain-trainer).
- **Watchdog escalations moved to the Decision Inbox.** A watchdog escalation is now a decision in the Decisions
  view, and is **no longer appended to `inbox_file`**. If you set `watchdog.escalation_file`, it still gets a copy of
  every escalation as an `- OWNER? ...` entry. `inbox_file` gets one only when a decision can't be raised. See
  [Watchdog](docs/configuration.md#watchdog).
