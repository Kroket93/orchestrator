import { Injectable, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DatabaseService } from '../database/database.service.js';
import { LoggerService } from '../logger/logger.service.js';
import { EventService } from '../events/event.service.js';
import { AgentManagerService } from '../agents/agent-manager.service.js';
import { QueueService } from './queue.service.js';
import { QUEUE_SETTING_KEYS, TaskStatus, AgentConfig, AgentTreeContext, ParsedTask } from '../types/index.js';

const POLL_INTERVAL = 5000; // Check queue every 5 seconds

/** Status constants to avoid magic strings in SQL queries */
const STATUS = {
  FAILED: 'failed' as TaskStatus,
  QUEUED: 'queued' as TaskStatus,
} as const;

interface QueuedTask {
  task_id: string;
  position: number;
  title: string;
  description: string;
  type: string;
  repo: string | null;
  repos: string | null;
  investigation_only: number;
}

interface QueueSettings {
  paused: boolean;
  stopOnFailure: boolean;
  maxConcurrent: number;
}

/** Configuration for multi-agent mode */
const USE_MULTI_AGENT_EVENTS = process.env.USE_MULTI_AGENT_EVENTS === 'true';

@Injectable()
export class QueueProcessorService implements OnModuleInit {
  private enabled = true;

  constructor(
    @Inject(forwardRef(() => DatabaseService))
    private readonly databaseService: DatabaseService,
    private readonly logger: LoggerService,
    @Inject(forwardRef(() => EventService))
    private readonly eventService: EventService,
    @Inject(forwardRef(() => AgentManagerService))
    private readonly agentManager: AgentManagerService,
    @Inject(forwardRef(() => QueueService))
    private readonly queueService: QueueService,
  ) {}

  onModuleInit(): void {
    if (process.env.ENABLE_QUEUE_PROCESSOR === 'false') {
      this.enabled = false;
      this.logger.info('queue-processor', 'Queue processor disabled by environment variable');
    } else {
      this.logger.info('queue-processor', 'Queue processor started');
    }
  }

  @Interval(POLL_INTERVAL)
  async processQueue(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const db = this.databaseService.getDatabase();

    try {
      // Check if queue is paused
      const settings = this.getQueueSettings();
      if (settings.paused) {
        return;
      }

      // Check for any failed tasks if stopOnFailure is enabled
      if (settings.stopOnFailure) {
        const failedTask = db
          .prepare(
            `
          SELECT t.id FROM tasks t
          JOIN queue q ON t.id = q.task_id
          WHERE t.status = '${STATUS.FAILED}'
          LIMIT 1
        `,
          )
          .get();

        if (failedTask) {
          this.logger.debug('queue-processor', 'Queue paused due to failed task');
          return;
        }
      }

      // Check if we have capacity for more tasks (count processing queue items, not agents)
      const processingCount = db
        .prepare(`SELECT COUNT(*) as count FROM queue WHERE status = 'processing'`)
        .get() as { count: number };

      if (processingCount.count >= settings.maxConcurrent) {
        this.logger.debug(
          'queue-processor',
          `At capacity (${processingCount.count}/${settings.maxConcurrent} tasks)`,
        );
        return;
      }

      // Get next queued task (check both task status and queue item status to prevent race conditions)
      const nextTask = db
        .prepare(
          `
        SELECT q.task_id, q.position, t.title, t.description, t.type, t.repo, t.repos, t.investigation_only
        FROM queue q
        JOIN tasks t ON q.task_id = t.id
        WHERE t.status = '${STATUS.QUEUED}' AND q.status = 'queued'
        ORDER BY q.position ASC
        LIMIT 1
      `,
        )
        .get() as QueuedTask | undefined;

      if (!nextTask) {
        return;
      }

      // Determine repo for the task
      let repo = nextTask.repo;
      if (!repo && nextTask.repos) {
        const repos = JSON.parse(nextTask.repos) as string[];
        if (repos.length > 0) {
          repo = repos[0]; // Use first repo for single-agent tasks
        }
      }

      if (!repo) {
        this.logger.warn(
          'queue-processor',
          `Task ${nextTask.task_id} has no associated repository`,
        );
        // Mark task as failed
        db.prepare(`UPDATE tasks SET status = '${STATUS.FAILED}' WHERE id = ?`).run(nextTask.task_id);
        db.prepare(`DELETE FROM queue WHERE task_id = ?`).run(nextTask.task_id);
        return;
      }

      this.logger.info(
        'queue-processor',
        `Processing task ${nextTask.task_id}: ${nextTask.title}`,
      );

      // Mark as processing (we've claimed it)
      this.queueService.updateQueueItemStatus(nextTask.task_id, 'processing');

      // Get tree context if available
      const treeContext = this.getContextForAgent(nextTask.task_id);

      // Either create event (multi-agent mode) or spawn directly (legacy mode)
      if (USE_MULTI_AGENT_EVENTS) {
        // Multi-agent mode: create task.assigned event
        // Event processor will spawn the appropriate agent type
        this.logger.info('queue-processor', `Creating task.assigned event for task ${nextTask.task_id}`);
        this.eventService.createEvent(
          'task.assigned',
          {
            taskId: nextTask.task_id,
            title: nextTask.title,
            description: nextTask.description || '',
            repo,
            repos: nextTask.repos ? JSON.parse(nextTask.repos) : undefined,
            investigationOnly: nextTask.investigation_only === 1,
          },
          'system',
        );
      } else {
        // Legacy mode: spawn agent directly
        const config: AgentConfig = {
          taskId: nextTask.task_id,
          repo,
          title: nextTask.title,
          description: nextTask.description || '',
          investigationOnly: nextTask.investigation_only === 1,
          treeContext,
        };
        await this.agentManager.spawnAgent(config);
      }
    } catch (error) {
      this.logger.error('queue-processor', `Error processing queue: ${error}`);
    }
  }

  private getQueueSettings(): QueueSettings {
    const db = this.databaseService.getDatabase();

    const paused = db
      .prepare(`SELECT value FROM queue_settings WHERE key = '${QUEUE_SETTING_KEYS.PAUSED}'`)
      .get() as { value: string } | undefined;
    const stopOnFailure = db
      .prepare(`SELECT value FROM queue_settings WHERE key = '${QUEUE_SETTING_KEYS.STOP_ON_FAILURE}'`)
      .get() as { value: string } | undefined;
    const maxConcurrent = db
      .prepare(`SELECT value FROM queue_settings WHERE key = '${QUEUE_SETTING_KEYS.MAX_CONCURRENT}'`)
      .get() as { value: string } | undefined;

    return {
      paused: paused?.value === 'true',
      stopOnFailure: stopOnFailure?.value === 'true',
      maxConcurrent: maxConcurrent ? parseInt(maxConcurrent.value, 10) : 1,
    };
  }

  /**
   * Get tree context for an agent task
   */
  private getContextForAgent(taskId: string): AgentTreeContext | undefined {
    try {
      const db = this.databaseService.getDatabase();

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

      return {
        ancestors: [],
        current,
        siblings: [],
      };
    } catch (error) {
      this.logger.warn('queue-processor', `Could not load context for task ${taskId}: ${error}`);
      return undefined;
    }
  }

  // Manual trigger to process queue immediately
  async triggerProcess(): Promise<void> {
    await this.processQueue();
  }
}
