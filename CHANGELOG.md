# Changelog

Changes that need your attention when you upgrade Lair. Lair is 0.x: anything can change between versions, and this
file lists what needs action on your side.

## Unreleased

- **Outcome tracker (off by default).** `outcome_tracker:` in `data/server.yaml` turns on a read-only tracker that
  records `outcome` (good / bad / unknown) with structured evidence on answered decisions; the brain trainer reads
  `bad` as a negative example. The decisions file gets three nullable columns the first time it is opened (nothing to
  do). See [Outcome tracker](docs/configuration.md#outcome-tracker).

- **Brain trainer (off by default).** `brain_trainer:` in `data/server.yaml` turns on a nightly shadow-trained
  classifier for decisions; it needs the image built from `brain-trainer/` (named in the config by its `sha256:` id,
  never by a tag) and a non-root Lair user, and it never answers a decision. See
  [Brain trainer](docs/configuration.md#brain-trainer).
- **Watchdog escalations moved to the Decision Inbox.** A watchdog escalation is now a decision in the Decisions
  view, and is **no longer appended to `inbox_file`**. If you set `watchdog.escalation_file`, it still gets a copy of
  every escalation as an `- OWNER? ...` entry. `inbox_file` gets one only when a decision can't be raised. See
  [Watchdog](docs/configuration.md#watchdog).
