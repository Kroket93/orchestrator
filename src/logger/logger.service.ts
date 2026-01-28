import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  level: LogLevel;
  category: string;
  message: string;
  metadata: string | null;
  created_at: string;
}

@Injectable()
export class LoggerService {
  constructor(
    @Inject(forwardRef(() => DatabaseService))
    private readonly databaseService: DatabaseService,
  ) {}

  log(
    level: LogLevel,
    category: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    // Console output
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}] [${category}]`;

    switch (level) {
      case 'debug':
        console.debug(prefix, message);
        break;
      case 'info':
        console.info(prefix, message);
        break;
      case 'warn':
        console.warn(prefix, message);
        break;
      case 'error':
        console.error(prefix, message);
        break;
    }

    // Database write
    try {
      const db = this.databaseService.getDatabase();
      const stmt = db.prepare(`
        INSERT INTO logs (level, category, message, metadata)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run(level, category, message, metadata ? JSON.stringify(metadata) : null);
    } catch (error) {
      console.error('Failed to write log to database:', error);
    }
  }

  debug(category: string, message: string, metadata?: Record<string, unknown>): void {
    this.log('debug', category, message, metadata);
  }

  info(category: string, message: string, metadata?: Record<string, unknown>): void {
    this.log('info', category, message, metadata);
  }

  warn(category: string, message: string, metadata?: Record<string, unknown>): void {
    this.log('warn', category, message, metadata);
  }

  error(category: string, message: string, metadata?: Record<string, unknown>): void {
    this.log('error', category, message, metadata);
  }

  getLogs(options: { level?: LogLevel; category?: string; limit?: number; offset?: number }): LogEntry[] {
    const db = this.databaseService.getDatabase();

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.level) {
      conditions.push('level = ?');
      params.push(options.level);
    }

    if (options.category) {
      conditions.push('category = ?');
      params.push(options.category);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const stmt = db.prepare(`
      SELECT * FROM logs
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `);

    params.push(limit, offset);
    return stmt.all(...params) as LogEntry[];
  }
}
