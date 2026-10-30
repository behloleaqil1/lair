# AWS deployment: how Lair runs application environments on AWS

Goal: Lair provisions, updates and monitors a project's cloud environments on AWS—preview, staging and
production—through code, with cost estimates before every change, gated reviews, and a hard money limit. This extends
[cloud-accounts.md](cloud-accounts.md) (account connection), [cloud-runners.md](cloud-runners.md) (on-demand machines),
and [phase5-deploy.md](phase5-deploy.md) (application deployment). Status: planned.

## 0. Principles

1. **Infrastructure as code.** Every resource is defined in versioned configuration; manual console changes are
   drift, detected and reported.
2. **Plan → cost → review → apply.** A change shows its cost estimate before review; production changes and cost
   increases above a threshold need owner approval in the Decision Inbox.
3. **Agents never hold cloud credentials.** The sandbox design (B4) keeps agent runs isolated; cloud operations
   run on the control plane with scoped, short-lived credentials from the secrets broker.
4. **Money is a hard limit.** Each environment has a budget with Lair's guard and the provider's own budget actions;
   spending stops before the limit.
5. **Observe first.** New behaviour is wired behind a config switch that starts in observe mode.

## 1. Infrastructure-as-code tooling

### 1.1 OpenTofu vs CDK

| Factor | OpenTofu | AWS CDK |
|--------|----------|---------|
| **Language** | HCL (declarative) | TypeScript, Python, Java, Go |
| **State** | Explicit state file; locking in S3 + DynamoDB | CloudFormation stack state managed by AWS |
| **Drift detection** | `tofu plan` shows drift | CloudFormation drift detection |
| **Portability** | Same code can target GCP, Azure later | AWS only |
| **Community** | Terraform-compatible ecosystem | AWS-maintained constructs |
| **Cost tools** | Infracost, native OpenTofu estimates | CloudFormation cost estimates |

**Recommendation:** OpenTofu (the open-source Terraform fork).

- Declarative: the configuration is the desired state, easy to review.
- Portable: the same patterns work when Lair supports other providers.
- State is explicit: Lair manages the state file, can lock it, and can restore from backup.
- Infracost integration gives accurate cost estimates before apply.

### 1.2 State storage and locking

| Item | Configuration |
|------|---------------|
| **State bucket** | S3 in the project's connected account, versioned, encrypted with KMS, private (no public access) |
| **Lock table** | DynamoDB with a partition key on `LockID`; pay-per-request pricing |
| **State per environment** | Separate state files: `<project>/<env>/terraform.tfstate` |
| **Access** | Only Lair's runtime role can read or write the state; agents never access it |

The account-connection template ([cloud-accounts.md §1](cloud-accounts.md)) creates the bucket and table as part of the
baseline.

## 2. The pipeline

Every infrastructure change—manual or from a merge—goes through this pipeline:

```
┌─────────┐    ┌────────────┐    ┌─────────────┐    ┌───────┐
│ Change  │───▶│ tofu plan  │───▶│ Cost est.   │───▶│ Review│───▶ apply
│ (code)  │    │ (dry run)  │    │ (Infracost) │    │ (gate)│     (controlled)
└─────────┘    └────────────┘    └─────────────┘    └───────┘
```

### 2.1 Plan

`tofu plan` runs against the environment's state and produces a plan file. The plan shows:
- Resources to create, update or destroy.
- Sensitive values masked.
- A summary of the change.

### 2.2 Cost estimate

Lair runs Infracost (or the native OpenTofu cost estimate when available) on the plan. The estimate shows:
- Monthly cost before and after the change.
- Cost difference ("+$34/month", "−$12/month").
- A breakdown by resource type.

### 2.3 Review gate

| Environment | Review rule |
|-------------|-------------|
| Preview | Automatic if cost delta < `infra.preview.auto_approve_delta` (default $10/month) |
| Staging | Automatic if cost delta < `infra.staging.auto_approve_delta` (default $50/month) |
| Production | Always a Decision Inbox item for the owner |

A review that exceeds the threshold becomes a Decision Inbox item:

```
Infrastructure change: staging (+$72/month)

Plan: 2 to add, 1 to change, 0 to destroy
Cost: $145/month → $217/month (+$72)

[Approve] [Reject] [View plan]
```

The plan and cost estimate are attached to the decision.

### 2.4 Apply

Once approved, `tofu apply` runs on the control plane with the plan file. Apply is:
- **Atomic:** the whole plan succeeds or fails; partial applies are rolled back.
- **Logged:** every apply is recorded in the audit log with the plan, the decision id, and the outcome.
- **Notified:** the owner gets a notification when apply completes or fails.

A failed apply raises a new Decision Inbox item with the error and a "Retry" action.

## 3. Releases

The release pipeline runs after a merge to the environment's branch (or on a tagged release for production):

```
┌───────────┐    ┌───────────┐    ┌─────────┐    ┌─────────┐    ┌──────────┐
│ Build     │───▶│ Push to   │───▶│ Migrate │───▶│ Rollout │───▶│ Verify   │
│ image     │    │ registry  │    │ (gated) │    │ (health)│    │ (smoke)  │
└───────────┘    └───────────┘    └─────────┘    └─────────┘    └──────────┘
```

### 3.1 Image build

- Multi-architecture images (amd64, arm64) for Graviton and x86.
- Built by GitHub Actions (or the project's CI) on merge.
- Pushed to ECR in the project's account; images are signed with Sigstore.

### 3.2 Push to registry

- ECR with image scanning enabled (vulnerabilities block the rollout above a threshold).
- Image tags: `<env>-<sha>`, `<env>-latest`.

### 3.3 Database migrations (gated)

Migrations run as a pre-deploy step:
1. **Backup:** take a snapshot (RDS automated snapshot or manual).
2. **Run:** `flyway migrate` (or the project's migration tool) in a one-shot task.
3. **Verify:** check the schema version matches the expected version.
4. **Gate:** if the migration fails, the rollout does not proceed; the snapshot is available for restore.

Migrations are always backward compatible: the old code must work with the new schema during the rollout.

A migration that changes behaviour (not just adding columns) is a Decision Inbox item before apply.

### 3.4 Rollout with health checks

| Strategy | How it works | Use case |
|----------|--------------|----------|
| **Rolling** | Replace instances one at a time; health check between each | Default for most services |
| **Blue-green** | Deploy to a standby; switch traffic atomically | Zero-downtime for stateful services |
| **Canary** | Route a percentage of traffic to the new version; increase on success | High-risk changes |

Health checks:
- **Startup:** the container starts and the process is running.
- **Liveness:** the `/health` endpoint returns 200.
- **Readiness:** the service is ready to accept traffic (dependencies connected).

A health check failure triggers automatic rollback to the previous version.

### 3.5 Automatic rollback

Rollback triggers:
- Health check failure during rollout.
- Error rate exceeds threshold in the first N minutes after deploy.
- Manual rollback from the Lair dashboard or a Decision Inbox action.

Rollback:
- Reverts to the previous image tag.
- Does NOT revert database migrations (they are forward-only and backward compatible).
- Records the rollback in the audit log and notifies the owner.

## 4. Secrets

### 4.1 Short-lived, scoped credentials

- **Deploy role:** an IAM role with permissions to update ECS services, run migrations, and read from ECR.
- **Assumed by Lair:** the control plane assumes the role with `sts:AssumeRole`; credentials expire in 1 hour.
- **Never stored:** credentials are fetched at the start of each pipeline run; they are never written to disk or logs.

### 4.2 Application secrets

- Stored in AWS Secrets Manager or SSM Parameter Store (encrypted with KMS).
- Injected into containers at runtime as environment variables.
- Rotated on a schedule (configurable); rotation is a Decision Inbox item when it requires a restart.

### 4.3 Agent isolation (sandbox design B4)

Agents run in sandboxes without cloud credentials. They cannot:
- Call AWS APIs directly.
- Read the deploy role's credentials.
- Access the state bucket or secrets.

All cloud operations go through the control plane's API, which checks permissions and audits every call.

## 5. The money guard per environment

Each environment has a budget ([cloud-accounts.md §4](cloud-accounts.md), [cloud-runners.md §4](cloud-runners.md)):

| Guard | How it works |
|-------|--------------|
| **Lair's meter** | Tracks spend from the provider's cost APIs and Lair's own usage records |
| **Provider budget** | An AWS Budget with automatic actions: stop instances, deny new starts |
| **Alerts** | Email and Lair notification at 50%, 80%, 100% of the limit |
| **Hard stop** | At the limit, Lair refuses to apply changes that increase cost; non-production environments can be paused automatically |

Budget configuration per environment:
```yaml
environments:
  staging:
    budget:
      limit: 200          # USD/month
      alert_thresholds: [50, 80, 100]
      hard_stop: true     # pause environment at limit
  production:
    budget:
      limit: 1000
      alert_thresholds: [50, 80, 100]
      hard_stop: false    # notify but don't pause production
```

### 5.1 Drift detection

Lair runs `tofu plan` on a schedule (daily by default) against each environment. A non-empty plan (drift) raises a
Decision Inbox item:

```
Drift detected: production

3 resources changed outside Lair:
- aws_ecs_service.backend: desired_count 2 → 4 (manual scaling?)
- aws_security_group_rule.allow_debug: added (unauthorized?)
- aws_rds_instance.main: storage 100 → 200 (auto-scaling?)

[Adopt changes] [Revert to code] [Ignore this time]
```

"Adopt changes" updates the code to match reality; "Revert to code" runs apply to restore the defined state.

## 6. Observe mode

New infrastructure modules start in observe mode:
- `tofu plan` runs and shows what would change.
- No apply happens automatically.
- The owner reviews plans in the Lair dashboard and decides when to enable act mode.

This matches the pattern in [autonomy.md §1](autonomy.md) and [platform.md §13](platform.md).

## 7. Acceptance tests

### 7.1 Pipeline tests

- A plan that adds a resource shows the correct cost estimate (mocked Infracost).
- A plan that exceeds the auto-approve threshold creates a Decision Inbox item.
- An approved decision triggers apply; a rejected decision does not.
- A failed apply raises a new decision with the error and retry action.

### 7.2 Release tests

- A merge to staging triggers build, push, migrate, rollout.
- A health check failure during rollout triggers automatic rollback.
- A rollback reverts to the previous image and notifies the owner.

### 7.3 Budget tests

- At 80% of the limit, an alert fires; at 100%, further cost-increasing applies are refused.
- A provider budget with a hard stop pauses the environment when triggered.

### 7.4 Drift tests

- A manual change in the console is detected on the next plan run.
- "Adopt changes" updates the code; "Revert to code" restores the defined state.

### 7.5 Secret tests

- Deploy credentials are scoped and expire after 1 hour.
- An agent run cannot read cloud credentials or call AWS APIs directly (sandbox isolation).

## 8. Implementation PRs

| PR | Scope | Lines (est.) |
|----|-------|--------------|
| 1 | **OpenTofu runner:** run `tofu init`, `plan`, `apply` from the control plane; state in S3; lock in DynamoDB | ~350 |
| 2 | **Cost estimation:** Infracost integration; cost diff on plans; auto-approve thresholds | ~250 |
| 3 | **Review gate:** Decision Inbox items for infrastructure changes; approve/reject flow | ~200 |
| 4 | **Release pipeline:** build, push, migrate, rollout steps; health checks; automatic rollback | ~400 |
| 5 | **Budget and drift:** per-environment budgets; scheduled drift detection; adopt/revert flow | ~300 |
| 6 | **Secrets broker integration:** deploy role assumption; application secrets injection | ~200 |
| 7 | **Dashboard views:** Environments view with status, cost, drift; release history; rollback button | ~350 |

Total: ~2,050 lines across 7 PRs.

## 9. ROADMAP update

C7 (Kubernetes and PaaS deploy targets) moves up because a first project needs AWS deployment before its launch. The new order:

| Before | After |
|--------|-------|
| C6 lair-node | C6 lair-node |
| C7 Kubernetes and PaaS | **C7 AWS deploy (this doc)** |
| — | C7a Kubernetes and other PaaS |
| C8 Knowledge and learning loop | C8 Knowledge and learning loop |

Reason: the project's Phase 10 (production infrastructure) is blocked until Lair can provision and manage AWS
environments. Gate machines ([cloud-runners.md](cloud-runners.md)) already work; this adds the application layer.

## References

- [cloud-accounts.md](cloud-accounts.md) — account connection, runtime role, provider budgets
- [cloud-runners.md](cloud-runners.md) — on-demand machines, the money guard, signed results
- [phase5-deploy.md](phase5-deploy.md) — deployment targets, strategies, rollback
- [platform.md](platform.md) — the overall platform spec, migrations, observe mode
- [autonomy.md](autonomy.md) — Decision Inbox, observe/act modes
- [sandbox.md](sandbox.md) — agent isolation (B4)
