# Changelog

Changes that need your attention when you upgrade Lair. Lair is 0.x: anything can change between versions, and this
file lists what needs action on your side.

## Unreleased

- **Decision policies, shadow only.** Lair now proposes, in a trace, what its rules C1-C4 and C11 would answer for each
  decision, and compares that with your answers (Decisions page → Policy agreement, owner only). Nothing answers a
  decision. An optional `data/policies.yaml` replaces the built-in table; it is validated at start and an invalid
  entry is refused, never half-applied. `data/decisions.db` gets a `policy_trace` table (migrated on start). See
  [Decision policies](docs/configuration.md#decision-policies).

- **Brain trainer (off by default).** `brain_trainer:` in `data/server.yaml` turns on a nightly shadow-trained
  classifier for decisions; it needs the image built from `brain-trainer/` (named in the config by its `sha256:` id,
  never by a tag) and a non-root Lair user, and it never answers a decision. See
  [Brain trainer](docs/configuration.md#brain-trainer).
- **Watchdog escalations moved to the Decision Inbox.** A watchdog escalation is now a decision in the Decisions
  view, and is **no longer appended to `inbox_file`**. If you set `watchdog.escalation_file`, it still gets a copy of
  every escalation as an `- OWNER? ...` entry. `inbox_file` gets one only when a decision can't be raised. See
  [Watchdog](docs/configuration.md#watchdog).
