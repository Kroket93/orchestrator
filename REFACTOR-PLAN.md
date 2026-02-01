# Orchestrator Refactoring Plan: Dumb Infrastructure

## Overview

Refactor the orchestrator from a workflow-aware service to a pure infrastructure layer that only handles agent lifecycle management. All business logic, workflow orchestration, and domain events move to vibe-suite.

**Goal:** Clean separation of concerns - orchestrator becomes a reusable agent runner that any project could use.

---

## Current vs Target Architecture

### Current (Problematic)

```
┌─────────────────────────────────────────────────────────────────┐
│                         VIBE-SUITE                              │
│  - Task management                                              │
│  - Spawns agents via orchestrator                               │
│  - Limited workflow awareness                                   │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        ORCHESTRATOR                             │
│  - Agent lifecycle (spawn, monitor, kill)                       │
│  - Task table (DUPLICATE DATA)                                  │
│  - Queue management                                             │
│  - Event system (task.plan.created, pr.created, etc.)           │
│  - Workflow decisions (event → spawn next agent)                │
│  - Prompt generation                                            │
└─────────────────────────────────────────────────────────────────┘

Problem: Orchestrator needs task data that lives in vibe-suite
         → "Task not found" errors
         → Data sync issues
```

### Target (Clean)

```
┌─────────────────────────────────────────────────────────────────┐
│                         VIBE-SUITE                              │
│  - Task management (single source of truth)                     │
│  - Workflow orchestration (event → spawn decision)              │
│  - Domain events (task.plan.created, pr.created, etc.)          │
│  - Agent completion handling                                    │
│  - Queue management                                             │
│  - Prompt generation                                            │
│  - Reconciliation on startup                                    │
└─────────────────────────────┬───────────────────────────────────┘
                              │ Simple API calls
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   ORCHESTRATOR (Infrastructure)                 │
│  - Spawn agent with provided config                             │
│  - Monitor agent lifecycle                                      │
│  - Collect and store logs                                       │
│  - Report agent status                                          │
│  - Kill agents                                                  │
│  - Historical agent records                                     │
│                                                                 │
│  NO: tasks, queues, events, workflow logic, domain knowledge    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Orchestrator Changes

### Keep (Core Infrastructure)

| Component | File | Purpose |
|-----------|------|---------|
| Agent Manager | `src/agents/agent-manager.service.ts` | Spawn/monitor/kill agents |
| Agents Controller | `src/agents/agents.controller.ts` | REST API for agents |
| Database Service | `src/database/database.service.ts` | SQLite for agent records |
| Logger Service | `src/logger/logger.service.ts` | Logging |
| GitHub Service | `src/github/github.service.ts` | Clone URLs, token management |

### Remove (Business Logic)

| Component | File | Reason |
|-----------|------|--------|
| Event Service | `src/events/event.service.ts` | Domain events → vibe-suite |
| Event Processor | `src/events/event-processor.service.ts` | Workflow logic → vibe-suite |
| Events Controller | `src/events/events.controller.ts` | No longer needed |
| Queue Service | `src/queue/queue.service.ts` | Queue logic → vibe-suite |
| Queue Processor | `src/queue/queue-processor.service.ts` | Workflow logic → vibe-suite |
| Queue Controller | `src/queue/queue.controller.ts` | No longer needed |
| Prompt Services | `src/prompts/*.ts` | Move to vibe-suite |

### Database Schema Changes

**Keep:**
```sql
-- Agent records (historical data)
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  task_id TEXT,              -- Reference only, not foreign key
  container_id TEXT,
  agent_type TEXT,
  status TEXT,
  started_at TEXT,
  completed_at TEXT,
  exit_code INTEGER,
  error TEXT,
  metadata TEXT
);

-- Agent logs
CREATE TABLE agent_logs (
  id INTEGER PRIMARY KEY,
  agent_id TEXT,
  timestamp TEXT,
  stream TEXT,
  content TEXT
);
```

**Remove:**
```sql
-- These tables move to vibe-suite or are removed
DROP TABLE tasks;
DROP TABLE queue;
DROP TABLE queue_settings;
```

### Simplified API

```
# Agent Lifecycle
POST   /api/agents/spawn              - Spawn agent with full config
GET    /api/agents                    - List all agents
GET    /api/agents/active             - List running agent IDs
GET    /api/agents/:id                - Get agent details
GET    /api/agents/:id/logs           - Get agent logs
POST   /api/agents/:id/kill           - Kill running agent

# Utilities
GET    /api/health                    - Health check
GET    /api/github/clone-url/:repo    - Get authenticated clone URL

# Removed
DELETE /api/events/*                  - All event endpoints
DELETE /api/queue/*                   - All queue endpoints
```

### Spawn Request Changes

The spawn endpoint becomes the single entry point. Caller provides ALL context:

```typescript
// POST /api/agents/spawn
interface SpawnRequest {
  // Required
  taskId: string;
  agentType: 'starter' | 'coding' | 'reviewer' | 'deployer' | 'verifier' | 'auditor';
  repo: string;

  // Agent context (caller provides everything)
  title: string;
  description: string;
  prompt: string;              // Full prompt, pre-generated by caller

  // Optional
  workBranch?: string;
  prNumber?: number;
  prUrl?: string;
  timeout?: number;

  // Callback (optional)
  callbackUrl?: string;        // POST here when agent completes
}
```

**Option A: Caller generates prompt**
- Vibe-suite generates the full prompt and passes it
- Orchestrator just runs claude with the prompt
- Most flexible, orchestrator is truly dumb

**Option B: Orchestrator keeps prompt generation as utility**
- Prompt services remain but are stateless
- Called with all context passed in, no DB lookups
- `POST /api/prompts/generate` → returns prompt string

I recommend **Option A** for cleanest separation, but Option B is acceptable if prompt logic is complex.

---

## Vibe-Suite Changes

### New/Modified Components

| Component | Status | Purpose |
|-----------|--------|---------|
| Workflow Service | **NEW** | Decides what agent to spawn next |
| Agent Completion Handler | **NEW** | Processes agent completion events |
| Reconciliation Service | **NEW** | Recovers from downtime |
| Prompt Services | **MOVE** | Generate prompts for each agent type |
| Queue Processor | **MODIFY** | Already exists, enhance for workflow |
| Event Processor | **MODIFY** | Handle domain events locally |

### Workflow Service

Handles the "what's next" logic:

```typescript
@Injectable()
export class WorkflowService {

  async handleAgentCompletion(taskId: string, agent: Agent): Promise<void> {
    const task = await this.taskService.getTask(taskId);

    switch (agent.agentType) {
      case 'starter':
        // Parse agent output for plan
        const plan = await this.parseStarterOutput(agent);
        if (plan.recommendation === 'coding') {
          await this.spawnCodingAgent(task, plan);
        } else if (plan.recommendation === 'close') {
          await this.closeTask(task, plan.reason);
        }
        break;

      case 'coding':
        // Check if PR was created
        const prInfo = await this.parseCodingOutput(agent);
        if (prInfo.prCreated) {
          await this.spawnReviewerAgent(task, prInfo);
        }
        break;

      case 'reviewer':
        const reviewResult = await this.parseReviewerOutput(agent);
        if (reviewResult.approved) {
          await this.spawnDeployerAgent(task);
        } else {
          await this.spawnCodingAgent(task, reviewResult.changes);
        }
        break;

      // ... etc
    }
  }
}
```

### Reconciliation Service

Runs on startup and periodically:

```typescript
@Injectable()
export class ReconciliationService {
  private readonly POLL_INTERVAL = 30000; // 30 seconds

  async onModuleInit() {
    await this.reconcile();
    setInterval(() => this.reconcile(), this.POLL_INTERVAL);
  }

  async reconcile(): Promise<void> {
    // Find tasks with assigned agents
    const activeTasks = await this.db.query(`
      SELECT * FROM tasks
      WHERE status IN ('assigned', 'in_progress')
      AND assigned_agent_id IS NOT NULL
    `);

    for (const task of activeTasks) {
      try {
        const agent = await this.orchestrator.getAgent(task.assigned_agent_id);

        if (agent.status === 'completed' || agent.status === 'failed') {
          this.logger.info(`Reconciling completed agent ${agent.id} for task ${task.id}`);
          await this.workflowService.handleAgentCompletion(task.id, agent);
        }
      } catch (error) {
        this.logger.warn(`Failed to reconcile task ${task.id}: ${error}`);
      }
    }
  }
}
```

### Prompt Generation

Move from orchestrator to vibe-suite:

```
vibe-suite/backend/src/nest/prompts/
├── starter-prompt.service.ts
├── coding-prompt.service.ts
├── reviewer-prompt.service.ts
├── deployer-prompt.service.ts
├── verifier-prompt.service.ts
├── auditor-prompt.service.ts
├── prompts.module.ts
└── index.ts
```

---

## Implementation Phases

### Phase 1: Add Vibe-Suite Workflow Infrastructure

**Without changing orchestrator yet** - build the new vibe-suite components:

1. Create WorkflowService
2. Create ReconciliationService
3. Move prompt services from orchestrator to vibe-suite
4. Modify AgentManagerService to generate prompts locally
5. Test: spawning agents with locally-generated prompts

### Phase 2: Agent Completion Handling

1. Add polling/reconciliation for agent status
2. Implement WorkflowService.handleAgentCompletion()
3. Test: full workflow starter → coding → reviewer with vibe-suite driving

### Phase 3: Simplify Orchestrator

1. Remove event system (service, processor, controller)
2. Remove queue system (service, processor, controller)
3. Remove prompt services
4. Drop unused database tables
5. Update CLAUDE.md

### Phase 4: Cleanup & Testing

1. Remove unused code from both projects
2. End-to-end testing of full workflow
3. Test resilience: stop vibe-suite mid-workflow, restart, verify recovery
4. Update documentation

---

## Migration Checklist

### Phase 1 Tasks
- [ ] Create `vibe-suite/backend/src/nest/workflow/workflow.service.ts`
- [ ] Create `vibe-suite/backend/src/nest/workflow/workflow.module.ts`
- [ ] Create `vibe-suite/backend/src/nest/workflow/reconciliation.service.ts`
- [ ] Copy prompt services from orchestrator to vibe-suite
- [ ] Update AgentManagerService to use local prompt generation
- [ ] Test agent spawning with local prompts

### Phase 2 Tasks
- [ ] Implement agent status polling in ReconciliationService
- [ ] Implement handleAgentCompletion() for each agent type
- [ ] Parse agent outputs (plan from starter, PR info from coding, etc.)
- [ ] Test full workflow: create task → starter → coding → reviewer
- [ ] Test workflow branching (reviewer requests changes → coding)

### Phase 3 Tasks
- [ ] Remove orchestrator EventService
- [ ] Remove orchestrator EventProcessorService
- [ ] Remove orchestrator EventsController
- [ ] Remove orchestrator QueueService
- [ ] Remove orchestrator QueueProcessorService
- [ ] Remove orchestrator QueueController
- [ ] Remove orchestrator prompt services
- [ ] Drop tasks, queue, queue_settings tables
- [ ] Update orchestrator API documentation

### Phase 4 Tasks
- [ ] End-to-end workflow test
- [ ] Resilience test (vibe-suite restart)
- [ ] Update orchestrator CLAUDE.md
- [ ] Update vibe-suite CLAUDE.md
- [ ] Commit and deploy

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Breaking existing functionality | Phase 1-2 are additive, orchestrator unchanged |
| Agent output parsing fragile | Define clear output formats, add validation |
| Polling overhead | 30s interval is low overhead, tune as needed |
| Lost completions during deploy | Reconciliation catches up on restart |

---

## Success Criteria

1. **Orchestrator is domain-agnostic** - No knowledge of tasks, workflows, or vibe-suite concepts
2. **Single source of truth** - All task/workflow state in vibe-suite
3. **Resilient to restarts** - Workflow continues after vibe-suite restart
4. **Full workflow works** - Task → starter → coding → reviewer → deployer → verifier
5. **Clean codebase** - No dead code, clear separation of concerns

---

## Timeline Estimate

| Phase | Scope | Effort |
|-------|-------|--------|
| Phase 1 | Workflow infrastructure | Medium |
| Phase 2 | Completion handling | Medium |
| Phase 3 | Orchestrator cleanup | Small |
| Phase 4 | Testing & docs | Small |

---

## Decisions Made

1. **Prompt generation** → Entirely in vibe-suite. Orchestrator receives complete prompt, just runs it.

2. **Agent output parsing** → Structured format with JSON markers. Agents output parseable JSON blocks for plans, PR info, etc.

3. **Completion notification** → Webhook callback. Orchestrator POSTs to vibe-suite when agent completes.

4. **Queue** → Unified in vibe-suite. Single queue, single source of truth. Orchestrator has no queue knowledge.

---

## Detailed Design: Webhook Callback

Orchestrator calls back to vibe-suite when agent completes:

```typescript
// Orchestrator: when agent exits
async onAgentComplete(agent: Agent): Promise<void> {
  // Update local DB
  await this.updateAgentStatus(agent.id, 'completed', exitCode);

  // If callback URL provided, notify caller
  if (agent.callbackUrl) {
    try {
      await fetch(agent.callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: agent.id,
          taskId: agent.taskId,
          status: agent.status,
          exitCode: agent.exitCode,
          completedAt: agent.completedAt,
        })
      });
    } catch (error) {
      // Log but don't fail - reconciliation will catch it
      this.logger.warn(`Callback failed for ${agent.id}: ${error}`);
    }
  }
}
```

```typescript
// Vibe-suite: callback endpoint
@Post('api/agents/callback')
async handleAgentCallback(@Body() payload: AgentCallbackPayload) {
  const { agentId, taskId, status, exitCode } = payload;

  // Fetch full agent details including logs
  const agent = await this.orchestrator.getAgent(agentId);

  // Process completion
  await this.workflowService.handleAgentCompletion(taskId, agent);

  return { received: true };
}
```

**Reconciliation still needed** as backup when callback fails.

---

## Detailed Design: Structured Agent Output

Agents output JSON blocks that can be parsed:

```
### Regular log output here...

<<<AGENT_OUTPUT>>>
{
  "type": "plan",
  "recommendation": "coding",
  "plan": {
    "summary": "Add Pluto mode to weather app",
    "steps": [...],
    "affectedFiles": [...]
  }
}
<<<END_OUTPUT>>>

### More log output...
```

Parsing in vibe-suite:

```typescript
function parseAgentOutput(logs: string): AgentOutput | null {
  const match = logs.match(/<<<AGENT_OUTPUT>>>([\s\S]*?)<<<END_OUTPUT>>>/);
  if (!match) return null;

  try {
    return JSON.parse(match[1].trim());
  } catch {
    return null;
  }
}
```

**Output types by agent:**

| Agent | Output Type | Contents |
|-------|-------------|----------|
| Starter | `plan` | recommendation, plan object, or close reason |
| Coding | `pr` | branch, prNumber, prUrl, commitCount |
| Reviewer | `review` | approved, comments, requestedChanges |
| Deployer | `deploy` | url, status, logs |
| Verifier | `verify` | passed, testResults, issues |
| Auditor | `audit` | findings, recommendations |

---

## Detailed Design: Unified Queue

Queue lives entirely in vibe-suite:

```sql
-- vibe-suite database
CREATE TABLE queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL UNIQUE,
  position INTEGER NOT NULL,
  status TEXT DEFAULT 'queued',  -- queued, processing, completed, failed
  queued_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE queue_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Default settings
INSERT INTO queue_settings VALUES ('paused', 'false');
INSERT INTO queue_settings VALUES ('max_concurrent', '1');
INSERT INTO queue_settings VALUES ('stop_on_failure', 'true');
```

Queue processor in vibe-suite:

```typescript
@Injectable()
export class QueueProcessorService {
  private polling = false;

  async processQueue(): Promise<void> {
    if (this.polling) return;
    this.polling = true;

    try {
      const settings = await this.getSettings();
      if (settings.paused) return;

      // Check concurrent limit against orchestrator
      const active = await this.orchestrator.getActiveAgents();
      if (active.length >= settings.maxConcurrent) return;

      // Get next task
      const next = await this.getNextQueued();
      if (!next) return;

      // Mark as processing
      await this.updateStatus(next.task_id, 'processing');

      // Get task details
      const task = await this.taskService.getTask(next.task_id);

      // Generate prompt
      const prompt = await this.promptService.generateStarterPrompt(task);

      // Spawn agent
      await this.orchestrator.spawnAgent({
        taskId: task.id,
        agentType: 'starter',
        repo: task.repo,
        title: task.title,
        description: task.description,
        prompt,
        callbackUrl: `${this.config.baseUrl}/api/agents/callback`,
      });

    } finally {
      this.polling = false;
    }
  }
}
```
