import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { LoggerService } from '../logger/logger.service.js';
import { QUEUE_SETTING_KEYS } from '../types/index.js';

export interface QueueItem {
  id: number;
  task_id: string;
  position: number;
  queued_at: string;
  status: string;
  completed_at: string | null;
  title?: string;
  description?: string;
  repo?: string;
}

export interface QueueSettings {
  paused: boolean;
  stopOnFailure: boolean;
  maxConcurrent: number;
}

@Injectable()
export class QueueService {
  constructor(
    @Inject(forwardRef(() => DatabaseService))
    private readonly databaseService: DatabaseService,
    private readonly logger: LoggerService,
  ) {}

  getQueueItems(): QueueItem[] {
    const db = this.databaseService.getDatabase();
    return db.prepare(`
      SELECT q.*, t.title, t.description, t.repo
      FROM queue q
      JOIN tasks t ON q.task_id = t.id
      WHERE q.status IN ('queued', 'processing')
      ORDER BY q.position ASC
    `).all() as QueueItem[];
  }

  getCompletedItems(limit = 10): QueueItem[] {
    const db = this.databaseService.getDatabase();
    return db.prepare(`
      SELECT q.*, t.title, t.description, t.repo
      FROM queue q
      JOIN tasks t ON q.task_id = t.id
      WHERE q.status IN ('completed', 'failed')
      ORDER BY q.completed_at DESC
      LIMIT ?
    `).all(limit) as QueueItem[];
  }

  getQueueSettings(): QueueSettings {
    const db = this.databaseService.getDatabase();

    const paused = db.prepare(`SELECT value FROM queue_settings WHERE key = ?`).get(QUEUE_SETTING_KEYS.PAUSED) as { value: string } | undefined;
    const stopOnFailure = db.prepare(`SELECT value FROM queue_settings WHERE key = ?`).get(QUEUE_SETTING_KEYS.STOP_ON_FAILURE) as { value: string } | undefined;
    const maxConcurrent = db.prepare(`SELECT value FROM queue_settings WHERE key = ?`).get(QUEUE_SETTING_KEYS.MAX_CONCURRENT) as { value: string } | undefined;

    return {
      paused: paused?.value === 'true',
      stopOnFailure: stopOnFailure?.value === 'true',
      maxConcurrent: maxConcurrent ? parseInt(maxConcurrent.value, 10) : 1,
    };
  }

  updateQueueSetting(key: string, value: string): void {
    const db = this.databaseService.getDatabase();
    db.prepare('INSERT OR REPLACE INTO queue_settings (key, value) VALUES (?, ?)').run(key, value);
    this.logger.info('queue', `Updated setting ${key} to ${value}`);
  }

  addToQueue(taskId: string): { success: boolean; position?: number } {
    const db = this.databaseService.getDatabase();

    // Check if already in queue
    const existing = db.prepare('SELECT id FROM queue WHERE task_id = ?').get(taskId);
    if (existing) {
      return { success: false };
    }

    // Get max position
    const maxPos = db.prepare('SELECT MAX(position) as max FROM queue').get() as { max: number | null };
    const position = (maxPos.max ?? 0) + 1;

    db.prepare('INSERT INTO queue (task_id, position) VALUES (?, ?)').run(taskId, position);
    db.prepare("UPDATE tasks SET status = 'queued' WHERE id = ?").run(taskId);

    this.logger.info('queue', `Added task ${taskId} to queue at position ${position}`);
    return { success: true, position };
  }

  removeFromQueue(taskId: string): { success: boolean } {
    const db = this.databaseService.getDatabase();

    const result = db.prepare('DELETE FROM queue WHERE task_id = ?').run(taskId);
    if (result.changes > 0) {
      db.prepare("UPDATE tasks SET status = 'pending' WHERE id = ?").run(taskId);
      this.logger.info('queue', `Removed task ${taskId} from queue`);
      return { success: true };
    }
    return { success: false };
  }

  updateQueueItemStatus(taskId: string, status: string): { success: boolean } {
    const db = this.databaseService.getDatabase();

    const completedAt = ['completed', 'failed'].includes(status) ? "datetime('now')" : 'NULL';
    const result = db.prepare(`
      UPDATE queue SET status = ?, completed_at = ${completedAt}
      WHERE task_id = ?
    `).run(status, taskId);

    if (result.changes > 0) {
      this.logger.info('queue', `Updated queue item ${taskId} status to ${status}`);
      return { success: true };
    }

    this.logger.warn('queue', `Task ${taskId} not found in queue for status update`);
    return { success: false };
  }

  clearCompleted(): number {
    const db = this.databaseService.getDatabase();
    const result = db.prepare("DELETE FROM queue WHERE status IN ('completed', 'failed')").run();
    this.logger.info('queue', `Cleared ${result.changes} completed items from queue`);
    return result.changes;
  }
}
