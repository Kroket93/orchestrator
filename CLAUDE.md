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
├── Queue Service - Task queue management
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
| **Agent Manager** | `src/agents/agent-manager.service.ts` | ⚠️ Partial | Core functionality works, simplified prompts |
| **Agents Controller** | `src/agents/agents.controller.ts` | ✅ Done | All CRUD endpoints |
| **Event Service** | `src/events/event.service.ts` | ✅ Done | File-based event system |
| **Events Controller** | `src/events/events.controller.ts` | ✅ Done | Event CRUD endpoints |
| **Queue Service** | `src/queue/queue.service.ts` | ✅ Done | Queue management, settings |
| **Queue Controller** | `src/queue/queue.controller.ts` | ✅ Done | Queue endpoints |
| **Types** | `src/types/index.ts` | ✅ Done | All shared types and constants |

### What's Working

1. **Agent Spawning** - Can spawn Docker containers and host processes
2. **Agent Lifecycle** - Start, monitor, kill, timeout handling
3. **Log Streaming** - Buffered log collection from containers/processes
4. **Event System** - Create, list, mark processed (file-based)
5. **Queue Management** - Add/remove tasks, settings (pause, max concurrent)
6. **Database** - All tables created, migrations run
7. **REST APIs** - All endpoints functional

### What's Missing / Simplified

| Component | Status | What's Missing |
|-----------|--------|----------------|
| **Prompt Services** | ❌ Not extracted | Full prompt generation for each agent type (starter, coding, reviewer, deployer, verifier, auditor). Currently using simplified generic prompt. |
| **Event Processor** | ❌ Not implemented | The service that polls pending events and routes them to spawn appropriate agent types. This is the multi-agent workflow brain. |
| **Queue Processor** | ❌ Not implemented | The scheduled service that polls the queue and spawns agents for queued tasks. |
| **GitHub Service** | ❌ Not extracted | Clone URL generation, default branch detection, PR operations |
| **Tree Context** | ❌ Not extracted | Task hierarchy context (ancestors, siblings) for agent prompts |
| **Execution Plans** | ❌ Not extracted | Plan parsing and passing to coding agents |
| **Real-time Log Streaming** | ⚠️ Basic | SSE endpoint exists but doesn't stream live updates |
| **Vibe-Suite Integration** | ❌ Not started | HTTP client in vibe-suite to call orchestrator APIs |

---

## Remaining Work

### Phase 1: Extract Prompt Services (High Priority)

Extract the 6 prompt services from vibe-suite:

```
src/prompts/
├── starter-prompt.service.ts    # Task analysis, creates execution plan
├── coding-prompt.service.ts     # Code implementation, PR creation
├── reviewer-prompt.service.ts   # PR review, merge/request changes
├── deployer-prompt.service.ts   # Deployment execution
├── verifier-prompt.service.ts   # Post-deploy verification
└── auditor-prompt.service.ts    # Proactive issue discovery
```

**Source files in vibe-suite:**
- `/home/claude/projects/vibe-suite/backend/src/nest/agents/prompts/`

### Phase 2: Extract Event Processor (High Priority)

Extract the event processor that handles multi-agent workflow:

```
src/events/
└── event-processor.service.ts   # Routes events to agent spawning
```

**Handles event types:**
- `task.assigned` → spawn starter agent
- `task.plan.created` → spawn coding agent
- `pr.created` → spawn reviewer agent
- `pr.merged` → spawn deployer agent
- `deploy.completed` → spawn verifier agent
- `verify.passed` → mark task complete
- `verify.failed` → handle failure
- `pr.changes.requested` → spawn coding agent with feedback

**Source file:**
- `/home/claude/projects/vibe-suite/backend/src/nest/events/event-processor.service.ts`

### Phase 3: Extract Queue Processor (Medium Priority)

Extract the queue processor that auto-processes queued tasks:

```
src/queue/
└── queue-processor.service.ts   # Polls queue, spawns agents
```

**Source file:**
- `/home/claude/projects/vibe-suite/backend/src/nest/queue/queue-processor.service.ts`

### Phase 4: Extract GitHub Service (Medium Priority)

Extract GitHub operations:

```
src/github/
└── github.service.ts   # Token management, clone URLs, API calls
```

**Source file:**
- `/home/claude/projects/vibe-suite/backend/src/nest/github/github.service.ts`

### Phase 5: Vibe-Suite Integration (Lower Priority)

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
│   │   ├── events.controller.ts      # REST endpoints
│   │   └── events.module.ts
│   ├── logger/
│   │   ├── logger.service.ts         # Logging
│   │   └── logger.module.ts
│   ├── queue/
│   │   ├── queue.service.ts          # Queue operations
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
