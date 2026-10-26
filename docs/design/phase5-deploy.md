# Lair Phase 5: Application Deployment, GitHub Integration, and Project Scaffolding

Status: planned, not built.

**Vision:** Lair becomes a complete AI-powered development platform where users can:
1. Create new projects from templates
2. Connect GitHub repos
3. Orchestrate agents to build the application
4. Deploy to any machine in the fleet
5. Scale up with more agents as needed

This spec is for the **open-source community** — anyone can use Lair to build applications from zero to production
using AI agents.

## 1. Application Deployment

### Deployment targets in config
```yaml
machines:
  build-server:
    type: ssh
    host: 198.51.100.10
    user: deploy
    key: ~/.ssh/example_key
    runners: [remote]
    # Deployment config
    deploy:
      enabled: true
      deploy_dir: /home/deploy/apps/{project}
      services:
        - name: backend
          type: systemd
          unit: {project}-backend
          health_check: curl -sf http://localhost:8080/health
        - name: dashboard
          type: systemd
          unit: {project}-dashboard
          health_check: curl -sf http://localhost:3000
        - name: worker
          type: systemd
          unit: {project}-worker
          health_check: pgrep -f "python.*worker"
      
  cloud-vm:
    type: ssh
    host: 203.0.113.50
    user: deploy
    key: ~/.ssh/example_key
    deploy:
      enabled: true
      deploy_dir: /var/www/{project}
      container_runtime: docker  # or podman
      compose_file: docker-compose.prod.yml
```

### Deployment strategies
```yaml
deployment:
  strategy: rolling  # rolling | blue-green | canary
  
  # Rolling deployment
  rolling:
    batch_size: 1
    health_check_timeout: 60
    rollback_on_failure: true
    
  # Blue-green deployment  
  blue_green:
    active_slot: blue
    health_check_timeout: 120
    switch_traffic_after: health_check
    
  # Canary deployment
  canary:
    initial_percentage: 10
    increment: 20
    health_check_interval: 60
```

### Deployment UI

**Deployments view** (new top-level view):
- List of deployable applications (from project config)
- Current deployment status per machine: version, health, uptime
- "Deploy" button → opens deployment dialog
- Deployment history with rollback option
- Live deployment logs

**Deployment dialog:**
- Target machine selector (filtered to machines with `deploy.enabled: true`)
- Version/branch/tag selector (from git)
- Pre-deployment checks (build passed, tests green)
- Deployment strategy selector
- "Deploy" / "Cancel" buttons
- Progress indicator with live logs

### Deployment flow

1. **Pre-checks:**
   - Verify target machine is online
   - Verify latest gate passed for the branch
   - Verify no other deployment in progress to same target

2. **Sync code:**
   - rsync or git pull to deploy_dir
   - Run any build commands (`npm run build`, `./gradlew build`)

3. **Apply migrations** (if configured):
   ```yaml
   deploy:
     migrations:
       enabled: true
       command: ./gradlew flywayMigrate
       backup_first: true
   ```

4. **Restart services:**
   - For systemd: `systemctl restart {unit}`
   - For docker: `docker-compose up -d --build`
   - For kubernetes: `kubectl rollout restart deployment/{name}`

5. **Health check:**
   - Run configured health checks
   - Wait for services to be healthy
   - Rollback if health check fails

6. **Post-deployment:**
   - Update deployment history
   - Send notification (if configured)
   - Tag the deployed commit

### Deployment API routes
```
GET  /api/deployments                    - List deployment targets and status
GET  /api/deployments/:machine           - Deployment status for machine
POST /api/deployments/:machine/deploy    - Start deployment
POST /api/deployments/:machine/rollback  - Rollback to previous version
GET  /api/deployments/:machine/logs      - Stream deployment logs
GET  /api/deployments/:machine/history   - Deployment history
```

## 2. GitHub Integration

### GitHub connection config
```yaml
github:
  # Auth via GitHub CLI (recommended) or token
  auth: gh-cli  # or token
  token_env: GITHUB_TOKEN  # if auth: token
  
  # Default org/user for new repos
  default_owner: example-org
  
  # Repo templates for new projects
  templates:
    - name: fullstack-ts
      repo: example-org/lair-template-fullstack
      description: TypeScript monorepo with React + Fastify
    - name: python-api
      repo: example-org/lair-template-python-api
      description: Python FastAPI backend
    - name: simple
      repo: example-org/lair-template-simple
      description: Minimal project structure
```

### GitHub operations

**Repository management:**
- Create new repo (from template or blank)
- Clone existing repo
- Fork repo
- Archive/delete repo (with confirmation)

**Branch operations:**
- List branches
- Create branch
- Delete branch (with PR check)
- Set default branch

**Pull request operations:**
- List open PRs
- Create PR
- Merge PR (with gate check)
- Close PR

**Issue operations:**
- List issues
- Create issue
- Close issue
- Convert issue to task (creates agent assignment)

### GitHub UI

**Repos view** (new top-level view):
- List of connected repos
- "Connect repo" button → repo picker or URL input
- "Create repo" button → new repo dialog
- Per-repo: branches, open PRs, recent commits

**New repo dialog:**
- Name, description, visibility (public/private)
- Template selector (from configured templates)
- Initialize with README, .gitignore, license
- "Create & Connect" button

**Repo detail panel:**
- Branches list with PR status
- Open PRs with gate status
- "Create PR" button
- "Kickstart" button → creates agents to build the project

### GitHub API routes
```
GET  /api/github/repos                  - List connected repos
POST /api/github/repos                  - Create new repo
POST /api/github/repos/connect          - Connect existing repo
DELETE /api/github/repos/:repo          - Disconnect repo

GET  /api/github/repos/:repo/branches   - List branches
POST /api/github/repos/:repo/branches   - Create branch

GET  /api/github/repos/:repo/prs        - List PRs
POST /api/github/repos/:repo/prs        - Create PR
POST /api/github/repos/:repo/prs/:num/merge - Merge PR

GET  /api/github/repos/:repo/issues     - List issues
POST /api/github/repos/:repo/issues     - Create issue
POST /api/github/repos/:repo/issues/:num/to-task - Convert to agent task
```

## 3. Project Scaffolding & Kickstart

### Project templates

Templates are GitHub repos with a `lair.yaml` manifest:
```yaml
# lair.yaml in template repo
name: Fullstack TypeScript
description: React + Fastify + PostgreSQL monorepo

variables:
  - name: project_name
    prompt: Project name
    default: my-app
  - name: database
    prompt: Database
    options: [postgresql, mysql, sqlite]
    default: postgresql

structure:
  - apps/backend       # Fastify API
  - apps/dashboard     # React frontend
  - packages/shared    # Shared types
  - docs/              # Documentation

post_create:
  - npm install
  - cp .env.example .env

# Agent instructions for building this project
agent_guidance: |
  This is a TypeScript monorepo. Key patterns:
  - Backend routes in apps/backend/src/routes/
  - React components in apps/dashboard/src/components/
  - Shared types in packages/shared/src/
  - Use the existing patterns for new features.
```

### Kickstart flow

"Kickstart" creates a new project and assigns agents to build it:

1. **User provides:**
   - Project idea/description (natural language)
   - Template (or auto-detect from description)
   - Number of agents to assign
   - Target completion (MVP, full feature set, etc.)

2. **Lair generates:**
   - Implementation plan (phases, tasks, dependencies)
   - Task assignments for agents
   - Gate configuration
   - Deployment target (if specified)

3. **Agents execute:**
   - Each agent claims tasks from the plan
   - Agents coordinate via the bus
   - Gates validate each PR
   - Orchestrator merges when ready

4. **User monitors:**
   - Live progress in Lair dashboard
   - Can adjust priorities, reassign tasks
   - Can pause/resume the build
   - Gets notified on milestones

### Kickstart UI

**Kickstart dialog:**
```
┌─────────────────────────────────────────────────────────┐
│ 🚀 Kickstart New Project                                │
├─────────────────────────────────────────────────────────┤
│ What do you want to build?                              │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ A SaaS application for managing customer feedback   │ │
│ │ with a React dashboard, REST API, and PostgreSQL    │ │
│ │ database. Users can submit feedback, vote on        │ │
│ │ features, and admins can manage the roadmap.        │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ Template: [Fullstack TypeScript ▾]                      │
│ Agents:   [4 ▾] (more agents = faster build)            │
│ Target:   [○ MVP  ● Full  ○ Custom...]                  │
│ Deploy to: [Build Server ▾] (optional)                  │
│                                                         │
│ Estimated: ~2 hours with 4 agents                       │
│                                                         │
│         [Cancel]  [Generate Plan]  [Start Building]     │
└─────────────────────────────────────────────────────────┘
```

**Plan review screen:**
- Shows generated phases and tasks
- Dependency graph visualization
- Estimated time per phase
- "Edit Plan" / "Approve & Start" buttons

### Kickstart API routes
```
POST /api/kickstart/plan              - Generate plan from description
GET  /api/kickstart/templates         - List available templates
POST /api/kickstart/start             - Start building from plan
GET  /api/kickstart/:id/status        - Build progress
POST /api/kickstart/:id/pause         - Pause build
POST /api/kickstart/:id/resume        - Resume build
POST /api/kickstart/:id/adjust        - Adjust plan mid-build
```

## 4. Agent Scaling

### Auto-scaling config
```yaml
scaling:
  min_agents: 2
  max_agents: 16
  scale_up_threshold: 10      # tasks in queue
  scale_down_threshold: 2     # idle agents
  scale_up_increment: 2
  scale_down_delay: 300       # seconds before scaling down
  
  # Cost awareness
  cost_per_agent_hour: 0.50   # for budgeting
  max_daily_cost: 50.00
```

### Multi-machine agent distribution
```yaml
machines:
  local:
    type: local
    max_agents: 8
  build-server:
    type: ssh
    host: 198.51.100.10
    max_agents: 4
  cloud:
    type: ssh
    host: 203.0.113.100
    max_agents: 20
    auto_provision: true      # Can spin up more VMs
```

### Scaling UI

**Scaling panel** (in Overview or separate view):
- Current agent count vs. max
- Task queue depth
- "Scale up" / "Scale down" buttons
- Auto-scaling toggle and config
- Cost tracker (today's spend, projected)

## 5. Implementation Phases

### Phase 5a: Deployment basics
- Deployment config schema
- Deploy command execution (rsync + systemctl)
- Deployment status tracking
- Basic deployment UI
- Tests: config parsing, command building

### Phase 5b: GitHub integration
- GitHub CLI wrapper service
- Repo CRUD operations
- PR and branch operations
- GitHub UI views
- Tests: mock gh CLI responses

### Phase 5c: Project scaffolding
- Template manifest parser
- Variable substitution
- Post-create hooks
- Template UI
- Tests: template instantiation

### Phase 5d: Kickstart engine
- Plan generation (uses AI to break down description)
- Task assignment logic
- Progress tracking
- Kickstart UI
- Tests: plan parsing, assignment logic

### Phase 5e: Auto-scaling
- Scaling config and thresholds
- Scale up/down logic
- Cost tracking
- Scaling UI
- Tests: threshold logic, cost calculation

## 6. Security Considerations

- **Deployment:** Only machines with `deploy.enabled: true` can receive deployments
- **GitHub:** Token never stored in config files, use gh CLI auth or env var
- **Kickstart:** AI-generated plans are reviewed before execution
- **Scaling:** Cost limits prevent runaway spending
- **Audit:** All deployment and GitHub operations logged

## 7. Open Source Considerations

Per the contribution rules in [CONTRIBUTING.md](../../CONTRIBUTING.md):
- No hardcoded paths or credentials
- All features work with example config
- Templates are public repos (or users provide their own)
- GitHub integration works with any GitHub account
- Deployment works with any SSH-accessible machine
