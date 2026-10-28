# Cloud accounts: connect once, and Lair runs everything it creates there

Goal: a project connects its cloud account to Lair once, with a guided step and without pasting keys, and from then on
Lair creates, runs, watches, prices and removes every cloud resource the project needs: gate machines
([cloud-runners.md](cloud-runners.md)), preview, staging and production environments ([phase5-deploy.md](phase5-deploy.md)),
and the services an architecture picks ([app-architecture.md](app-architecture.md)). Generic: a provider interface,
AWS first, then GCP, Azure and others, and the project's own servers through the same model. Status: planned.

## 0. Principles
1. **No admin keys in Lair.** The account owner creates Lair's access in their own console from a template Lair
   generates. Lair runs with short-lived credentials limited to what it manages.
2. **Everything Lair creates is tagged, listed and removable.** Nothing it made can keep billing after "remove".
3. **Desired state.** Lair records what should exist and in what state; a controller keeps the account matching it and
   reports drift (a change made outside Lair) instead of fighting it silently.
4. **Money is a hard limit.** Every resource belongs to a budget with Lair's guard and the provider's own budget
   action ([cloud-runners.md §4](cloud-runners.md)); costly changes need a human decision.
5. **No inbound ports by default.** Lair reaches machines through the provider's control channel (§3).

## 1. Connecting an account (Settings > Cloud)
1. **Provider.** The user picks one (AWS, GCP, Azure, Hetzner, or "my own servers").
2. **Template.** Lair generates the provider's infrastructure template (AWS CloudFormation; Terraform or the
   provider's own format elsewhere) and shows a "Launch in <provider>" button. It opens the user's console, signed in
   as themselves, with the template filled in. The template creates:
   - Lair's **runtime role**: create and change only resources tagged `lair:managed` with this project's id, read
     costs and quotas, use the control channel; nothing else;
   - the **tags and cost allocation** Lair reports by;
   - the **project budget** and its automatic actions (stop Lair's machines, deny new starts);
   - the **network baseline**: a private network, security groups with no inbound rules.
   The user reviews and creates it. Lair never holds an administrator credential, and no temporary setup user exists.
3. **Credentials.** In order: a role Lair assumes (with an external id), a named profile on Lair's host (single
   sign-on or `credential_process`, so credentials are short-lived), or, as a last resort, access keys in Lair's
   write-only key store with a rotation reminder.
4. **Checks.** Lair verifies the role's permissions, the **quotas** (for example the vCPU limit of a new AWS account,
   with the exact steps to raise it), the budget and its actions, and the cost data. It says what is missing in plain
   words.
5. **Done.** The account appears in the Cloud view (§5) with its budget, and every later step (gate machines,
   environments, architecture services) uses it.

## 2. Resources and desired state
- Lair keeps an **inventory**: every resource it created, with its purpose (gate machine, preview environment, staging
  database...), its owner step and its budget.
- A **controller** reconciles the inventory with the account on a schedule and after every change: a gate machine
  should be stopped unless jobs are waiting; a preview environment exists only while its pull request is open; staging
  matches the merged infrastructure code.
- **Drift** (a resource changed or created outside Lair under its tags) is shown, and a Decision Inbox item asks
  whether to adopt the change into the infrastructure code or revert it.
- Changes Lair makes are **audited**: who or what asked (a job, a merge, the owner), when, and the provider's own
  audit trail link.

## 3. Reaching machines
1. **The provider's control channel** (default): AWS Systems Manager, GCP IAP, Azure Run Command. Lair runs commands
   and copies files through the provider's API: no SSH keys, no open ports, no VPN.
2. **lair-node** ([node.md](node.md)) on the machine, connected out to Lair.
3. **A private network** (a tailnet or VPN) with SSH, for "my own servers" and providers without a control channel.

## 4. Machine images
- Lair builds a **machine image** from the project's detected toolchain (the languages, runtimes, container engine and
  test infrastructure its pipelines need) and the security baseline, versions it, and rebuilds it on a schedule
  (weekly by default) and when the toolchain changes.
- Machines are **replaced, not patched**: a new image means new machines. Boots are faster and every machine is the
  same.
- **Spot capacity** is an option where the work can be retried: an interruption is an infrastructure failure and the
  job runs again.

## 5. The Cloud view
Per account and project: every resource with its state and purpose; spend today, this month and this budget period
against the limit; a forecast from learned usage (gate durations, environment hours, traffic); cost per gate, per
environment and per service; quotas; drift; buttons for "stop now", "pause cloud" and "remove". The daily digest
carries the same totals, and Decision Inbox items cover spend, quota, drift and idle resources.

## 6. Cost
- **Estimates before creation:** every proposal (an architecture option, an infrastructure pull request, a bigger gate
  machine) shows its monthly cost from the provider's price list, at current load and at ten times the load.
- **Cost diff on infrastructure pull requests:** "this change adds about $34 a month"; above a project threshold it
  becomes a human decision.
- **Right-sizing:** from the provider's metrics, Lair suggests smaller or larger sizes with the saving or the cost.
- **Credits:** budgets can count usage before credits over a custom period, so they stop before promotional credits
  run out and never charge the card.

## 7. Removing
"Remove from Lair" deletes what Lair created (through the template's own stack, so nothing is missed), shows the final
spend, and leaves the account as it was before Lair. A single environment or machine can be removed the same way.

## 8. Build order
1. Provider interface, AWS template generation, the runtime role, credentials and the checks (§1).
2. Inventory, controller, drift and audit (§2); the Cloud view, read-only (§5).
3. Control channel (§3) and machine images (§4).
4. Cost: estimates, cost diff, right-sizing (§6). Removal (§7).
Gate machines ([cloud-runners.md](cloud-runners.md)) build on steps 1-3; environments ([phase5-deploy.md](phase5-deploy.md))
and architecture services ([app-architecture.md](app-architecture.md)) on all four.

## 9. Acceptance (summary)
- A new project connects an AWS account from Settings without any key being typed into Lair, and the checks name a
  missing quota with the steps to raise it.
- A resource Lair created and a resource changed outside Lair both show in the Cloud view; the second raises one drift
  decision.
- "Remove" leaves no resource tagged for the project and no budget action behind.
- An infrastructure pull request that adds a database shows its monthly cost before review; one above the threshold
  waits for the owner.
