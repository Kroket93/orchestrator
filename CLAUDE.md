# Orchestrator

Agent orchestration service for managing Claude Code agents.

## Overview

This service is responsible for:
- Spawning and managing agent containers/processes
- Processing the task queue
- Handling agent events and workflow transitions
- Providing APIs for agent monitoring and control

## Architecture

The orchestrator runs independently of vibe-suite and communicates via HTTP APIs.

```
Orchestrator (Port 3020)
├── Agent Manager - Docker/host process management
├── Event Service - Event-driven workflow
├── Event Processor - Routes events to spawn agents
├── Queue Service - Task queue management
├── Queue Processor - Auto-processes queued tasks
├── GitHub Service - GitHub API operations
├── Prompt Services - Agent prompt generation
└── Database - SQLite for agent state
```

---

## Implementation Status

### Completed

| Component | File | Status | Notes |
|-----------|------|--------|-------|
| **Main Entry** | `src/main.ts` | ✅ Done | NestJS bootstrap with CORS, validation |
| **App Module** | `src/app.module.ts` | ✅ Done | Root module with all imports |
| **Database Service** | `src/database/database.service.ts` | ✅ Done | SQLite with WAL, all tables, agent log methods |
| **Logger Service** | `src/logger/logger.service.ts` | ✅ Done | Console + DB logging |
| **Agent Manager** | `src/agents/agent-manager.service.ts` | ✅ Done | Docker/host process management with full prompt generation |
| **Agents Controller** | `src/agents/agents.controller.ts` | ✅ Done | All CRUD endpoints |
| **Event Service** | `src/events/event.service.ts` | ✅ Done | File-based event system |
| **Event Processor** | `src/events/event-processor.service.ts` | ✅ Done | Routes events to spawn appropriate agent types |
| **Events Controller** | `src/events/events.controller.ts` | ✅ Done | Event CRUD endpoints |
| **Queue Service** | `src/queue/queue.service.ts` | ✅ Done | Queue management, settings |
| **Queue Processor** | `src/queue/queue-processor.service.ts` | ✅ Done | Polls queue and spawns agents |
| **Queue Controller** | `src/queue/queue.controller.ts` | ✅ Done | Queue endpoints |
| **GitHub Service** | `src/github/github.service.ts` | ✅ Done | Token management, clone URLs, PR operations |
| **GitHub Controller** | `src/github/github.controller.ts` | ✅ Done | GitHub API endpoints |
| **Prompt Services** | `src/prompts/*.ts` | ✅ Done | All 6 agent type prompts |
| **Types** | `src/types/index.ts` | ✅ Done | All shared types, events, and constants |

### What's Working

1. **Agent Spawning** - Can spawn Docker containers and host processes
2. **Agent Lifecycle** - Start, monitor, kill, timeout handling
3. **Log Streaming** - Buffered log collection from containers/processes
4. **Event System** - Create, list, mark processed (file-based)
5. **Event Processing** - Automatic routing of events to spawn agents:
   - `task.assigned` → starter agent
   - `task.plan.created` → coding agent
   - `pr.created` / `pr.updated` → reviewer agent
   - `pr.merged` / `deploy.requested` → deployer agent
   - `deploy.completed` → verifier agent
   - `audit.requested` → auditor agent
   - `pr.changes.requested` → fix-up coding agent
   - `verify.passed/failed` / `audit.completed` → task completion
6. **Queue Management** - Add/remove tasks, settings (pause, max concurrent)
7. **Queue Processing** - Auto-spawns agents for queued tasks
8. **Database** - All tables created, migrations run
9. **REST APIs** - All endpoints functional
10. **GitHub Integration** - Push, PR creation/merge, repo management
11. **Full Prompt Generation** - Complete prompts for all 6 agent types

### What's Remaining

| Component | Status | What's Missing |
|-----------|--------|----------------|
| **Real-time Log Streaming** | ⚠️ Basic | SSE endpoint exists but doesn't stream live updates |
| **Vibe-Suite Integration** | ❌ Not started | HTTP client in vibe-suite to call orchestrator APIs |

---

## Remaining Work

### Phase 5: Vibe-Suite Integration (Next Step)

Create HTTP client in vibe-suite to call orchestrator:

```
vibe-suite/backend/src/nest/clients/
└── orchestrator.client.ts
```

**Changes needed in vibe-suite:**
1. Add OrchestratorClient service
2. Update AgentsController to proxy to orchestrator
3. Update QueueProcessor to call orchestrator.spawnAgent()
4. Remove duplicated agent code from vibe-suite

---

## File Structure

```
orchestrator/
├── src/
│   ├── agents/
│   │   ├── agent-manager.service.ts  # Core agent management
│   │   ├── agents.controller.ts      # REST endpoints
│   │   └── agents.module.ts
│   ├── database/
│   │   ├── database.service.ts       # SQLite operations
│   │   └── database.module.ts
│   ├── events/
│   │   ├── event.service.ts          # Event file management
│   │   ├── event-processor.service.ts # Event routing to agents
│   │   ├── events.controller.ts      # REST endpoints
│   │   └── events.module.ts
│   ├── github/
│   │   ├── github.service.ts         # GitHub API operations
│   │   ├── github.controller.ts      # REST endpoints
│   │   └── github.module.ts
│   ├── logger/
│   │   ├── logger.service.ts         # Logging
│   │   └── logger.module.ts
│   ├── prompts/
│   │   ├── starter-prompt.service.ts  # Task analysis prompts
│   │   ├── coding-prompt.service.ts   # Code implementation prompts
│   │   ├── reviewer-prompt.service.ts # PR review prompts
│   │   ├── deployer-prompt.service.ts # Deployment prompts
│   │   ├── verifier-prompt.service.ts # Post-deploy verification prompts
│   │   ├── auditor-prompt.service.ts  # Issue discovery prompts
│   │   ├── index.ts                   # Barrel exports
│   │   └── prompts.module.ts
│   ├── queue/
│   │   ├── queue.service.ts          # Queue operations
│   │   ├── queue-processor.service.ts # Auto-processing
│   │   ├── queue.controller.ts       # REST endpoints
│   │   └── queue.module.ts
│   ├── types/
│   │   └── index.ts                  # Shared types
│   ├── app.module.ts                 # Root module
│   └── main.ts                       # Entry point
├── dist/                             # Compiled output
├── CLAUDE.md                         # This file
├── ecosystem.config.cjs              # PM2 config
├── package.json
└── tsconfig.json
```

---

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run in development mode
npm run dev

# Run production
npm start
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3020 | HTTP server port |
| DATABASE_PATH | /home/claude/data/orchestrator.db | SQLite database path |
| EVENT_DIR | /home/claude/data/orchestrator-events | Event file storage |
| GITHUB_TOKEN | - | GitHub token for agent operations |
| GITHUB_OWNER | Kroket93 | GitHub organization/user |
| PROJECTS_DIR | /home/claude/projects | Local projects directory |
| WORKSPACES_DIR | /home/claude/agent-workspaces | Agent workspace directory |
| ENABLE_QUEUE_PROCESSOR | true | Enable/disable auto queue processing |
| USE_MULTI_AGENT_EVENTS | false | Use event-driven multi-agent workflow |

## API Endpoints

### Agents
- `GET /api/agents` - List all agents
- `GET /api/agents/active` - List active agent IDs
- `GET /api/agents/analytics` - Agent statistics
- `GET /api/agents/:id` - Get agent details
- `GET /api/agents/:id/logs` - Get agent logs (supports SSE)
- `POST /api/agents/spawn` - Spawn new agent
- `POST /api/agents/:id/kill` - Kill running agent
- `POST /api/agents/:id/retry` - Retry failed agent

### Events
- `GET /api/events` - List all events
- `GET /api/events/pending` - List pending events
- `GET /api/events/processed` - List processed events
- `GET /api/events/:id` - Get specific event
- `POST /api/events` - Create event
- `POST /api/events/:id/processed` - Mark event as processed

### Queue
- `GET /api/queue` - Get queue status (items, completed, settings)
- `GET /api/queue/settings` - Get queue settings only
- `POST /api/queue/settings` - Update queue setting
- `POST /api/queue/add/:taskId` - Add task to queue
- `DELETE /api/queue/:taskId` - Remove from queue
- `POST /api/queue/clear` - Clear completed items

### GitHub
- `GET /api/github/status` - Check GitHub token configuration
- `GET /api/github/repo/:repo` - Get repository info
- `GET /api/github/repo/:repo/default-branch` - Get default branch
- `GET /api/github/clone-url/:repo` - Get clone URL (authenticated if token available)
- `POST /api/github/push` - Push branch to GitHub
- `POST /api/github/pr` - Create pull request
- `GET /api/github/pr/:repo/:prNumber` - Get PR info
- `POST /api/github/pr/:repo/:prNumber/merge` - Merge PR
- `GET /api/github/prs/:repo` - List PRs
- `POST /api/github/ensure-remote/:repo` - Ensure GitHub remote exists

### Health
- `GET /api/health` - Health check

## PM2 Deployment

```bash
# Start
pm2 start ecosystem.config.cjs

# Restart
pm2 restart orchestrator

# Logs
pm2 logs orchestrator --lines 50

# Save process list
pm2 save
```

---

## Event-Driven Workflow

The orchestrator supports an event-driven multi-agent workflow. When `USE_MULTI_AGENT_EVENTS=true`:

```
1. Task queued → Queue processor creates task.assigned event
2. task.assigned → Event processor spawns starter agent
3. Starter creates task.plan.created → Spawns coding agent
4. Coding creates pr.created → Spawns reviewer agent
5. Reviewer approves → pr.merged → Spawns deployer agent
6. Deployer completes → deploy.completed → Spawns verifier agent
7. Verifier passes → verify.passed → Task marked complete

Alternative flows:
- Reviewer requests changes → pr.changes.requested → Spawns fix-up coding agent
- Verifier fails → verify.failed → Creates bug work item
- Starter requests audit → audit.requested → Spawns auditor agent
```

---

## Database Schema

### agents
| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | Agent ID (e.g., "starter-abc12345") |
| task_id | TEXT | Associated task ID |
| container_id | TEXT | Docker container ID or "host-pid-XXX" |
| status | TEXT | starting, running, completed, failed, timeout, killed |
| agent_type | TEXT | starter, coding, reviewer, deployer, verifier, auditor |
| started_at | TEXT | ISO timestamp |
| completed_at | TEXT | ISO timestamp |
| exit_code | INTEGER | Process exit code |
| error | TEXT | Error message if failed |
| logs | TEXT | Legacy log storage |
| metadata | TEXT | JSON metadata (API calls, etc.) |

### agent_logs
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| agent_id | TEXT FK | References agents(id) |
| timestamp | TEXT | ISO timestamp |
| stream | TEXT | stdout, stderr, combined |
| content | TEXT | Log line content |

### tasks (simplified, for standalone testing)
| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | Task ID |
| title | TEXT | Task title |
| description | TEXT | Task description |
| status | TEXT | pending, queued, assigned, in_progress, completed, failed |
| repo | TEXT | Primary repository |
| repos | TEXT | JSON array of repos |
| execution_plan | TEXT | JSON execution plan from starter |
| assigned_agent_id | TEXT | Currently assigned agent |

### queue
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| task_id | TEXT FK | References tasks(id) |
| position | INTEGER | Queue position |
| status | TEXT | queued, processing, completed, failed |
| queued_at | TEXT | ISO timestamp |
| completed_at | TEXT | ISO timestamp |

### queue_settings
| Column | Type | Description |
|--------|------|-------------|
| key | TEXT PK | Setting key |
| value | TEXT | Setting value |

Default settings: `paused=false`, `stop_on_failure=true`, `max_concurrent=1`
