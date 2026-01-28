import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

/** Agent metadata structure for tracking API calls */
export interface AgentMetadata {
  api_calls?: Array<{ type: string; timestamp: string; details?: Record<string, unknown> }>;
  has_posted_comment?: boolean;
  comment_prompted?: boolean;
  turns_count?: number;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private db!: Database.Database;

  onModuleInit(): void {
    this.initDatabase();
  }

  onModuleDestroy(): void {
    this.closeDatabase();
  }

  private initDatabase(): void {
    const dbPath = process.env.DATABASE_PATH || '/home/claude/data/orchestrator.db';

    // Ensure data directory exists
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.createTables();
    console.log('[DatabaseService] Database initialized');
  }

  getDatabase(): Database.Database {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    return this.db;
  }

  private createTables(): void {
    // Agents table - worker agent executions
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        container_id TEXT,
        status TEXT NOT NULL DEFAULT 'starting' CHECK (status IN ('starting', 'running', 'completed', 'failed', 'timeout', 'killed')),
        agent_type TEXT DEFAULT 'worker',
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        exit_code INTEGER,
        error TEXT,
        logs TEXT,
        metadata TEXT
      )
    `);

    // Agent logs table - structured log storage for agent output
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        timestamp TEXT NOT NULL,
        stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr', 'combined')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Deployment locks table - per-repo deployment coordination
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deployment_locks (
        repo TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Deployment queue table - agents waiting for deployment slot
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deployment_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        queued_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Logs table - application logging for debugging
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Tasks table - simplified task tracking for orchestrator
    // Note: In production, this would be fetched from vibe-suite via HTTP
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'queued', 'assigned', 'in_progress', 'completed', 'failed')),
        repo TEXT,
        repos TEXT,
        investigation_only INTEGER DEFAULT 0,
        execution_plan TEXT,
        assigned_agent_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Queue table - task queue state
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        queued_at TEXT NOT NULL DEFAULT (datetime('now')),
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
        completed_at TEXT,
        UNIQUE(task_id)
      )
    `);

    // Queue settings table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS queue_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Initialize queue settings if not exists
    const initSetting = this.db.prepare('INSERT OR IGNORE INTO queue_settings (key, value) VALUES (?, ?)');
    initSetting.run('paused', 'false');
    initSetting.run('stop_on_failure', 'true');
    initSetting.run('max_concurrent', '1');

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agents_task_id ON agents(task_id);
      CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
      CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
      CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category);
      CREATE INDEX IF NOT EXISTS idx_agent_logs_agent_id ON agent_logs(agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_logs_timestamp ON agent_logs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    `);
  }

  private closeDatabase(): void {
    if (this.db) {
      this.db.close();
      console.log('[DatabaseService] Database closed');
    }
  }

  // ==================== Agent Logs Methods ====================

  appendAgentLog(agentId: string, timestamp: string, stream: 'stdout' | 'stderr' | 'combined', content: string): void {
    this.db.prepare(`
      INSERT INTO agent_logs (agent_id, timestamp, stream, content)
      VALUES (?, ?, ?, ?)
    `).run(agentId, timestamp, stream, content);
  }

  appendAgentLogsBatch(entries: Array<{ agentId: string; timestamp: string; stream: 'stdout' | 'stderr' | 'combined'; content: string }>): void {
    const stmt = this.db.prepare(`
      INSERT INTO agent_logs (agent_id, timestamp, stream, content)
      VALUES (?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((logs: typeof entries) => {
      for (const log of logs) {
        stmt.run(log.agentId, log.timestamp, log.stream, log.content);
      }
    });

    insertMany(entries);
  }

  getAgentLogs(agentId: string, options?: { limit?: number; offset?: number; stream?: 'stdout' | 'stderr' | 'combined' }): Array<{ id: number; timestamp: string; stream: string; content: string }> {
    let query = 'SELECT id, timestamp, stream, content FROM agent_logs WHERE agent_id = ?';
    const params: (string | number)[] = [agentId];

    if (options?.stream) {
      query += ' AND stream = ?';
      params.push(options.stream);
    }

    query += ' ORDER BY id ASC';

    if (options?.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
      if (options?.offset) {
        query += ' OFFSET ?';
        params.push(options.offset);
      }
    }

    return this.db.prepare(query).all(...params) as Array<{ id: number; timestamp: string; stream: string; content: string }>;
  }

  getAgentLogCount(agentId: string): number {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM agent_logs WHERE agent_id = ?').get(agentId) as { count: number };
    return result.count;
  }

  getAgentLogsAsString(agentId: string): string {
    const logs = this.getAgentLogs(agentId);
    return logs.map(log => `${log.timestamp} ${log.content}`).join('\n');
  }

  deleteAgentLogs(agentId: string): void {
    this.db.prepare('DELETE FROM agent_logs WHERE agent_id = ?').run(agentId);
  }

  // ==================== Agent Metadata Methods ====================

  getAgentMetadata(agentId: string): AgentMetadata {
    const result = this.db.prepare('SELECT metadata FROM agents WHERE id = ?').get(agentId) as { metadata: string | null } | undefined;
    if (!result?.metadata) {
      return {};
    }
    try {
      return JSON.parse(result.metadata) as AgentMetadata;
    } catch {
      return {};
    }
  }

  updateAgentMetadata(agentId: string, metadata: AgentMetadata): void {
    this.db.prepare('UPDATE agents SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), agentId);
  }

  trackAgentApiCall(agentId: string, callType: string, details?: Record<string, unknown>): void {
    const metadata = this.getAgentMetadata(agentId);

    if (!metadata.api_calls) {
      metadata.api_calls = [];
    }

    metadata.api_calls.push({
      type: callType,
      timestamp: new Date().toISOString(),
      details,
    });

    if (callType === 'add_comment') {
      metadata.has_posted_comment = true;
    }

    this.updateAgentMetadata(agentId, metadata);
  }

  hasAgentPostedComment(agentId: string): boolean {
    const metadata = this.getAgentMetadata(agentId);
    return metadata.has_posted_comment === true;
  }
}
