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
- `GET /api/agents/:id` - Get agent details
- `GET /api/agents/:id/logs` - Get agent logs
- `POST /api/agents/spawn` - Spawn new agent
- `POST /api/agents/:id/kill` - Kill running agent
- `POST /api/agents/:id/retry` - Retry failed agent
- `GET /api/agents/analytics` - Agent statistics

### Events
- `GET /api/events` - List all events
- `GET /api/events/pending` - List pending events
- `POST /api/events` - Create event

### Queue
- `GET /api/queue` - Get queue status
- `POST /api/queue/add/:taskId` - Add task to queue
- `DELETE /api/queue/:taskId` - Remove from queue
- `POST /api/queue/settings` - Update queue settings

### Health
- `GET /api/health` - Health check

## PM2 Deployment

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

## Future Work

- [ ] Full prompt services (extracted from vibe-suite)
- [ ] Event processor for multi-agent workflow
- [ ] Queue processor for automatic task processing
- [ ] Integration with vibe-suite via HTTP client
