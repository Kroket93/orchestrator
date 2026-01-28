import { Injectable, OnModuleInit, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import { EventService } from './event.service.js';
import {
  AgentConfig,
  AgentTreeContext,
  EventType,
  ExecutionPlan,
  ParsedTask,
} from '../types/index.js';

/** Internal stored event structure */
interface StoredEvent {
  id: string;
  type: EventType;
  timestamp: string;
  source: string;
  payload: Record<string, unknown>;
}
import { LoggerService } from '../logger/logger.service.js';
import { AgentManagerService } from '../agents/agent-manager.service.js';
import { DatabaseService } from '../database/database.service.js';
import { QueueService } from '../queue/queue.service.js';

/** Polling interval for checking new events */
const POLL_INTERVAL_MS = 5000;

/** Track processed event IDs to avoid duplicates */
const processedEventIds = new Set<string>();

@Injectable()
export class EventProcessorService implements OnModuleInit, OnModuleDestroy {
  private pollInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
    @Inject(forwardRef(() => AgentManagerService))
    private readonly agentManager: AgentManagerService,
    @Inject(forwardRef(() => DatabaseService))
    private readonly databaseService: DatabaseService,
    @Inject(forwardRef(() => QueueService))
    private readonly queueService: QueueService,
  ) {}

  onModuleInit(): void {
    this.startPolling();
    this.logger.info('event-processor', 'Event processor started');
  }

  onModuleDestroy(): void {
    this.stopPolling();
  }

  /**
   * Get tree context for an agent. Returns undefined if task not found.
   */
  private getContextForAgent(taskId: string): AgentTreeContext | undefined {
    try {
      const db = this.databaseService.getDatabase();

      // Get current task
      const task = db.prepare(`
        SELECT id, title, description, type, status, repo, repos, execution_plan
        FROM tasks WHERE id = ?
      `).get(taskId) as {
        id: string;
        title: string;
        description: string | null;
        type: string;
        status: string;
        repo: string | null;
        repos: string | null;
        execution_plan: string | null;
      } | undefined;

      if (!task) {
        return undefined;
      }

      const current: ParsedTask = {
        id: task.id,
        title: task.title,
        description: task.description || undefined,
        type: task.type as ParsedTask['type'],
        status: task.status as ParsedTask['status'],
        repo: task.repo || undefined,
        repos: task.repos ? JSON.parse(task.repos) : undefined,
        executionPlan: task.execution_plan ? JSON.parse(task.execution_plan) : undefined,
      };

      // For now, return minimal context (ancestors and siblings can be expanded later)
      return {
        ancestors: [],
        current,
        siblings: [],
      };
    } catch (error) {
      this.logger.warn('event-processor', `Could not load context for task ${taskId}: ${error}`);
      return undefined;
    }
  }

  /**
   * Start polling for new events
   */
  private startPolling(): void {
    this.pollInterval = setInterval(() => {
      this.processEvents().catch(err => {
        this.logger.error('event-processor', `Error processing events: ${err}`);
      });
    }, POLL_INTERVAL_MS);

    // Also process immediately on startup
    this.processEvents().catch(err => {
      this.logger.error('event-processor', `Error processing events on startup: ${err}`);
    });
  }

  /**
   * Stop polling
   */
  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Process pending events
   */
  private async processEvents(): Promise<void> {
    if (this.isProcessing) {
      return; // Prevent concurrent processing
    }

    this.isProcessing = true;

    try {
      const events = this.eventService.getPendingEvents();

      for (const event of events) {
        // Skip already processed events (in case of race conditions)
        if (processedEventIds.has(event.id)) {
          continue;
        }

        try {
          await this.routeEvent(event);
          processedEventIds.add(event.id);
          this.eventService.markProcessed(event.id);
        } catch (error) {
          this.logger.error('event-processor', `Failed to process event ${event.id}: ${error}`);
          // Don't mark as processed - will retry on next poll
        }
      }

      // Clean up old processed event IDs to prevent memory growth
      if (processedEventIds.size > 1000) {
        const idsArray = Array.from(processedEventIds);
        idsArray.slice(0, 500).forEach(id => processedEventIds.delete(id));
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Route an event to the appropriate handler
   */
  private async routeEvent(event: StoredEvent): Promise<void> {
    this.logger.info('event-processor', `Processing event: ${event.type} (${event.id.slice(0, 8)})`);

    switch (event.type) {
      case 'task.assigned':
        await this.handleTaskAssigned(event.payload);
        break;

      case 'task.plan.created':
        await this.handlePlanCreated(event.payload);
        break;

      case 'task.closed':
        await this.handleTaskClosed(event.payload);
        break;

      case 'deploy.requested':
        await this.handleDeployRequested(event.payload);
        break;

      case 'pr.created':
        await this.handlePrCreated(event.payload);
        break;

      case 'pr.updated':
        await this.handlePrUpdated(event.payload);
        break;

      case 'pr.changes.requested':
        await this.handlePrChangesRequested(event.payload);
        break;

      case 'pr.merged':
        await this.handlePrMerged(event.payload);
        break;

      case 'deploy.completed':
        await this.handleDeployCompleted(event.payload);
        break;

      case 'deploy.failed':
        await this.handleDeployFailed(event.payload);
        break;

      case 'verify.passed':
        await this.handleVerifyPassed(event.payload);
        break;

      case 'verify.failed':
        await this.handleVerifyFailed(event.payload);
        break;

      case 'audit.requested':
        await this.handleAuditRequested(event.payload);
        break;

      case 'audit.finding':
        await this.handleAuditFinding(event.payload);
        break;

      case 'audit.completed':
        await this.handleAuditCompleted(event.payload);
        break;

      case 'agent.escalation':
        this.logger.warn('event-processor', `Agent escalation: ${(event.payload as { reason: string }).reason}`);
        break;

      default:
        this.logger.warn('event-processor', `Unknown event type: ${event.type}`);
    }
  }

  /**
   * Handle task.assigned event - spawn starter agent
   */
  private async handleTaskAssigned(payload: Record<string, unknown>): Promise<void> {
    const { taskId, title, description, repo, repos, investigationOnly } = payload as {
      taskId: string;
      title: string;
      description: string;
      repo: string;
      repos?: string[];
      investigationOnly?: boolean;
    };

    this.logger.info('event-processor', `Spawning starter agent for task ${taskId}`);

    const treeContext = this.getContextForAgent(taskId);

    try {
      const config: AgentConfig = {
        taskId,
        title,
        description,
        repo: repo || (repos && repos[0]) || '',
        repos,
        investigationOnly,
        agentType: 'starter',
        treeContext,
      };

      await this.agentManager.spawnAgent(config);
    } catch (error) {
      this.logger.error('event-processor', `Failed to spawn starter agent: ${error}`);
      throw error;
    }
  }

  /**
   * Handle task.plan.created event - spawn coding agent
   */
  private async handlePlanCreated(payload: Record<string, unknown>): Promise<void> {
    const { taskId, repo, plan } = payload as {
      taskId: string;
      repo: string;
      plan: ExecutionPlan;
    };
    const db = this.databaseService.getDatabase();

    // Store the execution plan in the database
    db.prepare('UPDATE tasks SET execution_plan = ? WHERE id = ?')
      .run(JSON.stringify(plan), taskId);
    this.logger.info('event-processor', `Stored execution plan for task ${taskId}`);

    // Get tree context (which now includes the execution plan)
    const treeContext = this.getContextForAgent(taskId);

    if (!treeContext) {
      this.logger.error('event-processor', `Task ${taskId} not found for plan`);
      return;
    }

    this.logger.info('event-processor', `Spawning coding agent for task ${taskId}`);

    try {
      const config: AgentConfig = {
        taskId,
        title: treeContext.current.title,
        description: treeContext.current.description || '',
        repo,
        agentType: 'coding',
        treeContext,
        executionPlan: plan,
      };

      await this.agentManager.spawnAgent(config);
    } catch (error) {
      this.logger.error('event-processor', `Failed to spawn coding agent: ${error}`);
      throw error;
    }
  }

  /**
   * Handle task.closed event - mark task as complete without further action
   */
  private async handleTaskClosed(payload: Record<string, unknown>): Promise<void> {
    const { taskId, reason, resolution } = payload as {
      taskId: string;
      reason: string;
      resolution: string;
    };

    this.logger.info('event-processor', `Closing task ${taskId}: ${resolution} - ${reason}`);

    const db = this.databaseService.getDatabase();

    // Mark task as completed
    db.prepare(`
      UPDATE tasks SET status = 'completed', updated_at = datetime('now')
      WHERE id = ?
    `).run(taskId);

    // Update queue item status to completed
    this.queueService.updateQueueItemStatus(taskId, 'completed');

    this.logger.info('event-processor', `Task ${taskId} closed successfully`);
  }

  /**
   * Handle deploy.requested event - spawn deployer agent directly
   */
  private async handleDeployRequested(payload: Record<string, unknown>): Promise<void> {
    const { taskId, repo, reason } = payload as {
      taskId: string;
      repo: string;
      reason: string;
    };

    const treeContext = this.getContextForAgent(taskId);

    if (!treeContext) {
      this.logger.error('event-processor', `Task ${taskId} not found for deploy request`);
      return;
    }

    this.logger.info('event-processor', `Spawning deployer agent for task ${taskId} (direct deploy: ${reason})`);

    try {
      const config: AgentConfig = {
        taskId,
        title: treeContext.current.title,
        description: `Direct deployment: ${reason}`,
        repo,
        agentType: 'deployer',
        treeContext,
      };

      await this.agentManager.spawnAgent(config);
    } catch (error) {
      this.logger.error('event-processor', `Failed to spawn deployer agent for direct deploy: ${error}`);
      throw error;
    }
  }

  /**
   * Handle pr.created event - spawn reviewer agent
   */
  private async handlePrCreated(payload: Record<string, unknown>): Promise<void> {
    const { taskId, repo, prNumber, prUrl, branch } = payload as {
      taskId: string;
      repo: string;
      prNumber: number;
      prUrl: string;
      branch: string;
    };

    const treeContext = this.getContextForAgent(taskId);

    if (!treeContext) {
      this.logger.error('event-processor', `Task ${taskId} not found for PR review`);
      return;
    }

    this.logger.info('event-processor', `Spawning reviewer agent for PR #${prNumber} (task ${taskId})`);

    try {
      const config: AgentConfig = {
        taskId,
        title: treeContext.current.title,
        description: `Review PR #${prNumber}: ${prUrl}`,
        repo,
        agentType: 'reviewer',
        prNumber,
        prUrl,
        branch,
        treeContext,
      };

      await this.agentManager.spawnAgent(config);
    } catch (error) {
      this.logger.error('event-processor', `Failed to spawn reviewer agent: ${error}`);
      throw error;
    }
  }

  /**
   * Handle pr.updated event - spawn reviewer agent to re-review after fix-up
   */
  private async handlePrUpdated(payload: Record<string, unknown>): Promise<void> {
    const { taskId, repo, prNumber, prUrl, branch } = payload as {
      taskId: string;
      repo: string;
      prNumber: number;
      prUrl: string;
      branch: string;
    };

    const treeContext = this.getContextForAgent(taskId);

    if (!treeContext) {
      this.logger.error('event-processor', `Task ${taskId} not found for PR re-review`);
      return;
    }

    this.logger.info('event-processor', `Spawning reviewer agent for updated PR #${prNumber} (task ${taskId})`);

    try {
      const config: AgentConfig = {
        taskId,
        title: treeContext.current.title,
        description: `Re-review updated PR #${prNumber}: ${prUrl}`,
        repo,
        agentType: 'reviewer',
        prNumber,
        prUrl,
        branch,
        treeContext,
      };

      await this.agentManager.spawnAgent(config);
    } catch (error) {
      this.logger.error('event-processor', `Failed to spawn reviewer agent for re-review: ${error}`);
      throw error;
    }
  }

  /**
   * Handle pr.changes.requested event - spawn a fix-up coding agent to address feedback
   */
  private async handlePrChangesRequested(payload: Record<string, unknown>): Promise<void> {
    const { taskId, repo, prNumber, branch, reviewComments } = payload as {
      taskId: string;
      repo: string;
      prNumber: number;
      branch: string;
      reviewComments: string;
    };
    const db = this.databaseService.getDatabase();

    this.logger.warn('event-processor', `PR #${prNumber} needs changes: ${reviewComments}`);

    const treeContext = this.getContextForAgent(taskId);

    if (!treeContext) {
      this.logger.error('event-processor', `Task ${taskId} not found for PR changes`);
      return;
    }

    // Update task status to show it's being worked on
    db.prepare(`
      UPDATE tasks SET status = 'in_progress'
      WHERE id = ?
    `).run(taskId);

    this.logger.info('event-processor', `Spawning fix-up coding agent for PR #${prNumber} (task ${taskId})`);

    try {
      const config: AgentConfig = {
        taskId,
        title: treeContext.current.title,
        description: treeContext.current.description || '',
        repo,
        agentType: 'coding',
        treeContext,
        executionPlan: treeContext.current.executionPlan || undefined,
        reviewFeedback: reviewComments,
        prNumber,
        existingBranch: branch,
      };

      await this.agentManager.spawnAgent(config);
    } catch (error) {
      this.logger.error('event-processor', `Failed to spawn fix-up coding agent: ${error}`);
      throw error;
    }
  }

  /**
   * Handle pr.merged event - spawn deployer agent
   */
  private async handlePrMerged(payload: Record<string, unknown>): Promise<void> {
    const { taskId, repo, prNumber, mergeCommit } = payload as {
      taskId: string;
      repo: string;
      prNumber: number;
      mergeCommit: string;
    };

    const treeContext = this.getContextForAgent(taskId);

    if (!treeContext) {
      this.logger.error('event-processor', `Task ${taskId} not found for deploy`);
      return;
    }

    this.logger.info('event-processor', `Spawning deployer agent for task ${taskId}`);

    try {
      const config: AgentConfig = {
        taskId,
        title: treeContext.current.title,
        description: `Deploy PR #${prNumber} (${mergeCommit})`,
        repo,
        agentType: 'deployer',
        treeContext,
      };

      await this.agentManager.spawnAgent(config);
    } catch (error) {
      this.logger.error('event-processor', `Failed to spawn deployer agent: ${error}`);
      throw error;
    }
  }

  /**
   * Handle deploy.completed event - spawn verifier agent
   */
  private async handleDeployCompleted(payload: Record<string, unknown>): Promise<void> {
    const { taskId, repo, url } = payload as {
      taskId: string;
      repo: string;
      url: string;
    };

    this.logger.info('event-processor', `Deployment completed for task ${taskId}: ${url}`);

    const treeContext = this.getContextForAgent(taskId);

    if (!treeContext) {
      this.logger.error('event-processor', `Task ${taskId} not found for verification`);
      return;
    }

    this.logger.info('event-processor', `Spawning verifier agent for task ${taskId}`);

    try {
      const config: AgentConfig = {
        taskId,
        title: treeContext.current.title,
        description: treeContext.current.description || '',
        repo,
        agentType: 'verifier',
        deploymentUrl: url,
        treeContext,
      };

      await this.agentManager.spawnAgent(config);
    } catch (error) {
      this.logger.error('event-processor', `Failed to spawn verifier agent: ${error}`);
      throw error;
    }
  }

  /**
   * Handle deploy.failed event - mark task as failed
   */
  private async handleDeployFailed(payload: Record<string, unknown>): Promise<void> {
    const { taskId, error } = payload as {
      taskId: string;
      error: string;
    };
    const db = this.databaseService.getDatabase();

    this.logger.error('event-processor', `Deployment failed for task ${taskId}: ${error}`);

    db.prepare(`
      UPDATE tasks SET status = 'failed'
      WHERE id = ?
    `).run(taskId);
  }

  /**
   * Handle verify.passed event - mark task as complete
   */
  private async handleVerifyPassed(payload: Record<string, unknown>): Promise<void> {
    const { taskId, summary } = payload as {
      taskId: string;
      summary: string;
    };
    const db = this.databaseService.getDatabase();

    this.logger.info('event-processor', `Verification passed for task ${taskId}: ${summary}`);

    db.prepare(`
      UPDATE tasks SET status = 'completed', updated_at = datetime('now')
      WHERE id = ?
    `).run(taskId);

    // Update queue item status to completed
    this.queueService.updateQueueItemStatus(taskId, 'completed');
  }

  /**
   * Handle verify.failed event - create bug work item
   */
  private async handleVerifyFailed(payload: Record<string, unknown>): Promise<void> {
    const { taskId, repo, bug } = payload as {
      taskId: string;
      repo: string;
      bug: {
        description: string;
        steps: string;
        expected: string;
        actual: string;
      };
    };
    const db = this.databaseService.getDatabase();

    this.logger.error('event-processor', `Verification failed for task ${taskId}: ${bug.description}`);

    // Get task details
    const task = db.prepare('SELECT title, id FROM tasks WHERE id = ?').get(taskId) as
      | { title: string; id: string }
      | undefined;

    if (!task) {
      this.logger.error('event-processor', `Task ${taskId} not found`);
      return;
    }

    // Create a bug work item for the failed verification
    const bugId = `bug-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const bugTitle = `[Bug] ${bug.description}`;
    const bugDescription = `## Bug Found During Verification

**Original Task:** ${task.title} (${taskId})

### Description
${bug.description}

### Steps to Reproduce
${bug.steps}

### Expected Behavior
${bug.expected}

### Actual Behavior
${bug.actual}`;

    db.prepare(`
      INSERT INTO tasks (id, title, description, type, status, repo, created_at)
      VALUES (?, ?, ?, 'bug', 'pending', ?, datetime('now'))
    `).run(bugId, bugTitle, bugDescription, repo);

    // Mark original task as failed
    db.prepare(`
      UPDATE tasks SET status = 'failed'
      WHERE id = ?
    `).run(taskId);

    this.logger.info('event-processor', `Created bug work item ${bugId} for failed verification`);
  }

  /**
   * Handle audit.requested event - spawn auditor agent
   */
  private async handleAuditRequested(payload: Record<string, unknown>): Promise<void> {
    const { taskId, repo, url } = payload as {
      taskId: string;
      repo: string;
      url: string;
    };

    this.logger.info('event-processor', `Audit requested for task ${taskId}: ${url}`);

    const treeContext = this.getContextForAgent(taskId);

    if (!treeContext) {
      this.logger.error('event-processor', `Task ${taskId} not found for audit`);
      return;
    }

    this.logger.info('event-processor', `Spawning auditor agent for task ${taskId}`);

    try {
      const config: AgentConfig = {
        taskId,
        title: treeContext.current.title,
        description: treeContext.current.description || '',
        repo,
        agentType: 'auditor',
        deploymentUrl: url,
        treeContext,
      };

      await this.agentManager.spawnAgent(config);
    } catch (error) {
      this.logger.error('event-processor', `Failed to spawn auditor agent: ${error}`);
      throw error;
    }
  }

  /**
   * Handle audit.finding event - create a child task for the finding
   */
  private async handleAuditFinding(payload: Record<string, unknown>): Promise<void> {
    const { taskId, repo, parentId: explicitParentId, finding } = payload as {
      taskId: string;
      repo: string;
      parentId?: string;
      finding: {
        severity: string;
        category: string;
        title: string;
        description: string;
        steps?: string;
        screenshot?: string;
      };
    };
    const db = this.databaseService.getDatabase();

    this.logger.info('event-processor', `Audit finding for task ${taskId}: ${finding.title}`);

    // Determine parent for the finding
    const parentId = explicitParentId || taskId;

    // Create a bug work item for the audit finding
    const bugId = `audit-finding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const bugTitle = `[Audit ${finding.severity.toUpperCase()}] ${finding.title}`;
    const bugDescription = `## Audit Finding

**Category:** ${finding.category}
**Severity:** ${finding.severity}
**Found during:** Audit of task ${taskId}

### Description
${finding.description}

${finding.steps ? `### Steps to Reproduce\n${finding.steps}` : ''}
${finding.screenshot ? `### Screenshot\n![Screenshot](${finding.screenshot})` : ''}`;

    db.prepare(`
      INSERT INTO tasks (id, title, description, type, status, repo, created_at)
      VALUES (?, ?, ?, 'bug', 'pending', ?, datetime('now'))
    `).run(bugId, bugTitle, bugDescription, repo);

    this.logger.info('event-processor', `Created audit finding work item ${bugId} under parent ${parentId}`);
  }

  /**
   * Handle audit.completed event - log summary
   */
  private async handleAuditCompleted(payload: Record<string, unknown>): Promise<void> {
    const { taskId, summary, findingsCount, duration } = payload as {
      taskId: string;
      summary: string;
      findingsCount: number;
      duration: number;
    };
    const db = this.databaseService.getDatabase();

    this.logger.info(
      'event-processor',
      `Audit completed for task ${taskId}: ${findingsCount} findings in ${duration}ms - ${summary}`,
    );

    // Mark the audit task as completed
    db.prepare(`
      UPDATE tasks SET status = 'completed', updated_at = datetime('now')
      WHERE id = ?
    `).run(taskId);

    // Update queue item status to completed
    this.queueService.updateQueueItemStatus(taskId, 'completed');
  }

  /**
   * Manually trigger event processing (for testing)
   */
  async triggerProcessing(): Promise<void> {
    await this.processEvents();
  }
}
