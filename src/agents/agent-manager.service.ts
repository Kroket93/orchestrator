import { Injectable, OnModuleInit, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import Docker from 'dockerode';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { DatabaseService } from '../database/database.service.js';
import { LoggerService } from '../logger/logger.service.js';
import {
  AgentConfig,
  AgentInstance,
  AgentType,
  AgentDbStatus,
  getAgentTimeout,
  isHostAgent,
} from '../types/index.js';

const docker = new Docker();

/** Agent status constants */
const AGENT_STATUS = {
  STARTING: 'starting' as AgentDbStatus,
  RUNNING: 'running' as AgentDbStatus,
  COMPLETED: 'completed' as AgentDbStatus,
  FAILED: 'failed' as AgentDbStatus,
  TIMEOUT: 'timeout' as AgentDbStatus,
  KILLED: 'killed' as AgentDbStatus,
} as const;

/** Agent configuration */
const AGENT_CONFIG = {
  image: 'vibe-agent:latest',
  memory: 2 * 1024 * 1024 * 1024, // 2GB
  cpus: 1,
  workspaceBase: '/home/claude/agent-workspaces',
  claudeConfigDir: '/home/claude/.claude',
  projectsDir: '/home/claude/projects',
};

/** Tracked agent info */
interface TrackedAgent {
  containerId: string;
  timeoutId: NodeJS.Timeout;
  logStream?: NodeJS.ReadableStream;
  taskId: string;
  agentType: AgentType;
  hostProcess?: ChildProcess;
}

@Injectable()
export class AgentManagerService implements OnModuleInit, OnModuleDestroy {
  private activeAgents = new Map<string, TrackedAgent>();
  private logBuffer = new Map<string, Array<{ timestamp: string; stream: 'stdout' | 'stderr' | 'combined'; content: string }>>();
  private logFlushInterval: NodeJS.Timeout | null = null;
  private readonly LOG_FLUSH_INTERVAL_MS = 1000;
  private readonly LOG_BUFFER_SIZE = 50;

  constructor(
    @Inject(forwardRef(() => DatabaseService))
    private readonly databaseService: DatabaseService,
    private readonly logger: LoggerService,
  ) {}

  onModuleInit(): void {
    this.logger.info('agent-manager', 'Agent manager initialized');

    // Start log flush interval
    this.logFlushInterval = setInterval(() => {
      this.flushAllLogBuffers();
    }, this.LOG_FLUSH_INTERVAL_MS);

    // Recover orphaned agents
    this.recoverOrphanedAgents().catch(err => {
      this.logger.error('agent-manager', `Failed to recover orphaned agents: ${err}`);
    });
  }

  onModuleDestroy(): void {
    if (this.logFlushInterval) {
      clearInterval(this.logFlushInterval);
    }
    this.flushAllLogBuffers();
  }

  async checkAgentImage(): Promise<boolean> {
    try {
      await docker.getImage(AGENT_CONFIG.image).inspect();
      return true;
    } catch {
      return false;
    }
  }

  async spawnAgent(config: AgentConfig): Promise<AgentInstance> {
    const agentType = config.agentType || 'starter';
    const agentId = `${agentType}-${uuidv4().slice(0, 8)}`;
    const db = this.databaseService.getDatabase();

    this.logger.info('agent-manager', `Spawning ${agentType} agent ${agentId} for task ${config.taskId}`);

    // Host agents run directly on the host
    if (isHostAgent(agentType)) {
      return this.spawnHostAgent(config, agentId, agentType);
    }

    // Check if image exists for Docker agents
    const imageExists = await this.checkAgentImage();
    if (!imageExists) {
      throw new Error(`Agent image ${AGENT_CONFIG.image} not found. Run 'docker build' first.`);
    }

    // Create agent record
    db.prepare(`
      INSERT INTO agents (id, task_id, status, agent_type)
      VALUES (?, ?, '${AGENT_STATUS.STARTING}', ?)
    `).run(agentId, config.taskId, agentType);

    // Update task status
    db.prepare(`
      UPDATE tasks SET status = 'assigned', assigned_agent_id = ?
      WHERE id = ?
    `).run(agentId, config.taskId);

    try {
      // Create workspace directory
      const workspacePath = `${AGENT_CONFIG.workspaceBase}/${agentId}`;
      fs.mkdirSync(workspacePath, { recursive: true });

      // Generate prompt (simplified for now)
      const prompt = this.generatePrompt(config, agentId);
      fs.writeFileSync(`${workspacePath}/task-prompt.md`, prompt);

      // Create container
      const container = await docker.createContainer({
        Image: AGENT_CONFIG.image,
        name: agentId,
        User: '1000:1000',
        Tty: true,
        WorkingDir: '/home/agent/workspace/repo',
        Env: [
          `GITHUB_TOKEN=${process.env.GITHUB_TOKEN || ''}`,
          `TASK_ID=${config.taskId}`,
          `AGENT_ID=${agentId}`,
          `ORCHESTRATOR_API=http://localhost:${process.env.PORT || 3020}/api`,
          'HOME=/home/agent',
          'CLAUDE_CONFIG_DIR=/home/agent/.claude',
        ],
        HostConfig: {
          Binds: [
            `${workspacePath}:/home/agent/workspace:rw`,
            `${AGENT_CONFIG.claudeConfigDir}:/home/agent/.claude:rw`,
          ],
          Memory: AGENT_CONFIG.memory,
          NanoCpus: AGENT_CONFIG.cpus * 1e9,
          AutoRemove: false,
          NetworkMode: 'host',
          IpcMode: 'host',
        },
        Labels: {
          'orchestrator': 'true',
          'agent-id': agentId,
          'task-id': config.taskId,
        },
      });

      const containerId = container.id;

      // Update agent record
      db.prepare(`
        UPDATE agents SET container_id = ?, status = '${AGENT_STATUS.RUNNING}'
        WHERE id = ?
      `).run(containerId, agentId);

      // Start container
      await container.start();

      this.logger.info('agent-manager', `Agent ${agentId} started in container ${containerId.slice(0, 12)}`);

      // Set up timeout
      const timeout = getAgentTimeout(agentType);
      const timeoutId = setTimeout(async () => {
        this.logger.warn('agent-manager', `Agent ${agentId} timed out after ${timeout / 1000}s`);
        await this.killAgent(agentId, 'timeout');
      }, timeout);

      // Track agent
      this.activeAgents.set(agentId, {
        containerId,
        timeoutId,
        taskId: config.taskId,
        agentType,
      });

      // Start log streaming
      this.startLogStreaming(agentId, containerId);

      // Monitor container
      this.monitorContainer(agentId, containerId, workspacePath);

      return {
        id: agentId,
        taskId: config.taskId,
        containerId,
        status: AGENT_STATUS.RUNNING,
        startedAt: new Date().toISOString(),
        agentType,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error('agent-manager', `Failed to spawn agent ${agentId}: ${errorMsg}`);

      db.prepare(`
        UPDATE agents SET status = '${AGENT_STATUS.FAILED}', error = ?, completed_at = datetime('now')
        WHERE id = ?
      `).run(errorMsg, agentId);

      db.prepare(`
        UPDATE tasks SET status = 'queued', assigned_agent_id = NULL
        WHERE id = ?
      `).run(config.taskId);

      throw error;
    }
  }

  private async spawnHostAgent(
    config: AgentConfig,
    agentId: string,
    agentType: AgentType,
  ): Promise<AgentInstance> {
    const db = this.databaseService.getDatabase();

    db.prepare(`
      INSERT INTO agents (id, task_id, status, agent_type)
      VALUES (?, ?, '${AGENT_STATUS.STARTING}', ?)
    `).run(agentId, config.taskId, agentType);

    db.prepare(`
      UPDATE tasks SET status = 'assigned', assigned_agent_id = ?
      WHERE id = ?
    `).run(agentId, config.taskId);

    try {
      const workspacePath = `${AGENT_CONFIG.workspaceBase}/${agentId}`;
      fs.mkdirSync(workspacePath, { recursive: true });

      const prompt = this.generatePrompt(config, agentId);
      fs.writeFileSync(`${workspacePath}/task-prompt.md`, prompt);

      // Spawn Claude Code process
      const claudeProcess = spawn('claude', [
        '--dangerously-skip-permissions',
        '--output-format', 'stream-json',
        '--verbose',
        '-p', prompt,
      ], {
        cwd: `${AGENT_CONFIG.projectsDir}/${config.repo}`,
        env: {
          ...process.env,
          GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
          TASK_ID: config.taskId,
          AGENT_ID: agentId,
          ORCHESTRATOR_API: `http://localhost:${process.env.PORT || 3020}/api`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.logger.info('agent-manager', `Host agent ${agentId} started with PID ${claudeProcess.pid}`);

      db.prepare(`
        UPDATE agents SET status = '${AGENT_STATUS.RUNNING}'
        WHERE id = ?
      `).run(agentId);

      const timeout = getAgentTimeout(agentType);
      const timeoutId = setTimeout(async () => {
        this.logger.warn('agent-manager', `Host agent ${agentId} timed out after ${timeout / 1000}s`);
        await this.killAgent(agentId, 'timeout');
      }, timeout);

      this.activeAgents.set(agentId, {
        containerId: `host-pid-${claudeProcess.pid}`,
        timeoutId,
        taskId: config.taskId,
        agentType,
        hostProcess: claudeProcess,
      });

      this.logBuffer.set(agentId, []);

      claudeProcess.stdout?.on('data', (chunk: Buffer) => {
        this.bufferLogEntry(agentId, 1, chunk.toString('utf8'));
      });

      claudeProcess.stderr?.on('data', (chunk: Buffer) => {
        this.bufferLogEntry(agentId, 2, chunk.toString('utf8'));
      });

      claudeProcess.on('exit', (code, signal) => {
        this.handleHostAgentExit(agentId, code, signal, workspacePath);
      });

      claudeProcess.on('error', (error) => {
        this.logger.error('agent-manager', `Host agent ${agentId} error: ${error.message}`);
        this.handleHostAgentExit(agentId, 1, null, workspacePath);
      });

      return {
        id: agentId,
        taskId: config.taskId,
        containerId: `host-pid-${claudeProcess.pid}`,
        status: AGENT_STATUS.RUNNING,
        startedAt: new Date().toISOString(),
        agentType,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error('agent-manager', `Failed to spawn host agent ${agentId}: ${errorMsg}`);

      db.prepare(`
        UPDATE agents SET status = '${AGENT_STATUS.FAILED}', error = ?, completed_at = datetime('now')
        WHERE id = ?
      `).run(errorMsg, agentId);

      db.prepare(`
        UPDATE tasks SET status = 'queued', assigned_agent_id = NULL
        WHERE id = ?
      `).run(config.taskId);

      throw error;
    }
  }

  private generatePrompt(config: AgentConfig, agentId: string): string {
    // Simplified prompt generation
    // TODO: Extract full prompt services
    return `# Task: ${config.title}

Agent ID: ${agentId}
Task ID: ${config.taskId}
Repository: ${config.repo}

## Description

${config.description || 'No description provided.'}

## Instructions

Complete the task described above. When finished, report your results.
`;
  }

  private handleHostAgentExit(
    agentId: string,
    code: number | null,
    _signal: string | null,
    workspacePath: string,
  ): void {
    const db = this.databaseService.getDatabase();
    const exitCode = code ?? 1;

    this.logger.info('agent-manager', `Host agent ${agentId} exited with code ${exitCode}`);

    this.flushLogBuffer(agentId);
    this.logBuffer.delete(agentId);

    const logString = this.databaseService.getAgentLogsAsString(agentId);
    const status = exitCode === 0 ? AGENT_STATUS.COMPLETED : AGENT_STATUS.FAILED;

    db.prepare(`
      UPDATE agents SET status = ?, exit_code = ?, logs = ?, completed_at = datetime('now')
      WHERE id = ?
    `).run(status, exitCode, logString, agentId);

    if (exitCode !== 0) {
      db.prepare(`
        UPDATE tasks SET status = 'failed'
        WHERE id = (SELECT task_id FROM agents WHERE id = ?)
      `).run(agentId);
    }

    const tracked = this.activeAgents.get(agentId);
    if (tracked) {
      clearTimeout(tracked.timeoutId);
      this.activeAgents.delete(agentId);
    }

    if (exitCode === 0) {
      try {
        fs.rmSync(workspacePath, { recursive: true, force: true });
        this.logger.info('agent-manager', `Cleaned up workspace for host agent ${agentId}`);
      } catch {
        this.logger.warn('agent-manager', `Failed to clean up workspace for host agent ${agentId}`);
      }
    }
  }

  async killAgent(agentId: string, reason: 'killed' | 'timeout' = 'killed'): Promise<void> {
    const db = this.databaseService.getDatabase();
    const tracked = this.activeAgents.get(agentId);

    if (!tracked) {
      this.logger.warn('agent-manager', `Agent ${agentId} not found in active agents`);
      return;
    }

    try {
      this.stopLogStreaming(agentId);

      if (tracked.hostProcess) {
        tracked.hostProcess.kill('SIGTERM');
        this.logger.info('agent-manager', `Host agent ${agentId} killed (${reason})`);
      } else {
        const container = docker.getContainer(tracked.containerId);
        await container.kill();
        this.logger.info('agent-manager', `Agent ${agentId} killed (${reason})`);
      }

      db.prepare(`
        UPDATE agents SET status = ?, completed_at = datetime('now')
        WHERE id = ?
      `).run(reason, agentId);

      db.prepare(`
        UPDATE tasks SET status = 'failed'
        WHERE id = (SELECT task_id FROM agents WHERE id = ?)
      `).run(agentId);

      clearTimeout(tracked.timeoutId);
      this.activeAgents.delete(agentId);
    } catch (error) {
      this.logger.error('agent-manager', `Error killing agent ${agentId}: ${error}`);
    }
  }

  async getAgentLogs(agentId: string): Promise<string> {
    const logCount = this.databaseService.getAgentLogCount(agentId);

    if (logCount > 0) {
      return this.databaseService.getAgentLogsAsString(agentId);
    }

    const db = this.databaseService.getDatabase();
    const result = db.prepare('SELECT logs FROM agents WHERE id = ?').get(agentId) as
      | { logs: string | null }
      | undefined;
    return result?.logs || '';
  }

  getActiveAgents(): string[] {
    return Array.from(this.activeAgents.keys());
  }

  async getAllAgents(): Promise<AgentInstance[]> {
    const db = this.databaseService.getDatabase();
    const agents = db.prepare(`
      SELECT id, task_id, container_id, status, agent_type, started_at, completed_at, exit_code, error
      FROM agents
      ORDER BY started_at DESC
      LIMIT 100
    `).all() as Array<{
      id: string;
      task_id: string;
      container_id: string | null;
      status: AgentDbStatus;
      agent_type: AgentType;
      started_at: string;
      completed_at: string | null;
      exit_code: number | null;
      error: string | null;
    }>;

    return agents.map(a => ({
      id: a.id,
      taskId: a.task_id,
      containerId: a.container_id,
      status: a.status,
      agentType: a.agent_type,
      startedAt: a.started_at,
      completedAt: a.completed_at || undefined,
      exitCode: a.exit_code || undefined,
      error: a.error || undefined,
    }));
  }

  async getAgent(agentId: string): Promise<AgentInstance | null> {
    const db = this.databaseService.getDatabase();
    const agent = db.prepare(`
      SELECT id, task_id, container_id, status, agent_type, started_at, completed_at, exit_code, error
      FROM agents WHERE id = ?
    `).get(agentId) as {
      id: string;
      task_id: string;
      container_id: string | null;
      status: AgentDbStatus;
      agent_type: AgentType;
      started_at: string;
      completed_at: string | null;
      exit_code: number | null;
      error: string | null;
    } | undefined;

    if (!agent) return null;

    return {
      id: agent.id,
      taskId: agent.task_id,
      containerId: agent.container_id,
      status: agent.status,
      agentType: agent.agent_type,
      startedAt: agent.started_at,
      completedAt: agent.completed_at || undefined,
      exitCode: agent.exit_code || undefined,
      error: agent.error || undefined,
    };
  }

  async getAnalytics(): Promise<{
    total: number;
    running: number;
    completed: number;
    failed: number;
  }> {
    const db = this.databaseService.getDatabase();

    const total = (db.prepare('SELECT COUNT(*) as count FROM agents').get() as { count: number }).count;
    const running = (db.prepare("SELECT COUNT(*) as count FROM agents WHERE status = 'running'").get() as { count: number }).count;
    const completed = (db.prepare("SELECT COUNT(*) as count FROM agents WHERE status = 'completed'").get() as { count: number }).count;
    const failed = (db.prepare("SELECT COUNT(*) as count FROM agents WHERE status IN ('failed', 'timeout', 'killed')").get() as { count: number }).count;

    return { total, running, completed, failed };
  }

  async retryAgent(agentId: string): Promise<AgentInstance | null> {
    const db = this.databaseService.getDatabase();

    const agent = db.prepare('SELECT task_id FROM agents WHERE id = ?').get(agentId) as { task_id: string } | undefined;

    if (!agent) {
      this.logger.warn('agent-manager', `Agent ${agentId} not found for retry`);
      return null;
    }

    const task = db.prepare(`
      SELECT id, repo, title, description, investigation_only
      FROM tasks WHERE id = ?
    `).get(agent.task_id) as {
      id: string;
      repo: string;
      title: string;
      description: string;
      investigation_only: number;
    } | undefined;

    if (!task) {
      this.logger.warn('agent-manager', `Task not found for agent ${agentId}`);
      return null;
    }

    db.prepare(`
      UPDATE tasks SET status = 'queued', assigned_agent_id = NULL
      WHERE id = ?
    `).run(task.id);

    return this.spawnAgent({
      taskId: task.id,
      repo: task.repo,
      title: task.title,
      description: task.description,
      investigationOnly: task.investigation_only === 1,
    });
  }

  private async recoverOrphanedAgents(): Promise<void> {
    const db = this.databaseService.getDatabase();

    const runningAgents = db.prepare(`
      SELECT id, container_id, task_id, agent_type
      FROM agents WHERE status = 'running'
    `).all() as Array<{ id: string; container_id: string | null; task_id: string; agent_type: string }>;

    if (runningAgents.length === 0) return;

    this.logger.info('agent-manager', `Recovering ${runningAgents.length} orphaned agent(s)`);

    for (const agent of runningAgents) {
      try {
        if (agent.container_id && !agent.container_id.startsWith('host-')) {
          const container = docker.getContainer(agent.container_id);
          const info = await container.inspect();

          if (!info.State.Running) {
            const exitCode = info.State.ExitCode;
            const status = exitCode === 0 ? AGENT_STATUS.COMPLETED : AGENT_STATUS.FAILED;

            db.prepare(`
              UPDATE agents SET status = ?, exit_code = ?, completed_at = datetime('now')
              WHERE id = ?
            `).run(status, exitCode, agent.id);

            try {
              await container.remove();
            } catch {
              // Container might already be removed
            }
          }
        } else {
          // Host process - mark as failed
          db.prepare(`
            UPDATE agents SET status = 'failed', error = 'Server restarted while agent was running', completed_at = datetime('now')
            WHERE id = ?
          `).run(agent.id);
        }
      } catch (error) {
        this.logger.error('agent-manager', `Failed to recover agent ${agent.id}: ${error}`);
        db.prepare(`
          UPDATE agents SET status = 'failed', error = 'Recovery failed', completed_at = datetime('now')
          WHERE id = ?
        `).run(agent.id);
      }
    }
  }

  // Log streaming methods
  private async startLogStreaming(agentId: string, containerId: string): Promise<void> {
    const tracked = this.activeAgents.get(agentId);
    if (!tracked) return;

    try {
      const container = docker.getContainer(containerId);
      const stream = await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
        timestamps: true,
      });

      tracked.logStream = stream;
      this.logBuffer.set(agentId, []);

      stream.on('data', (chunk: Buffer) => {
        this.bufferLogEntry(agentId, 1, chunk.toString('utf8'));
      });

      stream.on('error', (err: Error) => {
        this.logger.error('agent-manager', `Log stream error for ${agentId}: ${err.message}`);
      });

      stream.on('end', () => {
        this.flushLogBuffer(agentId);
      });
    } catch (error) {
      this.logger.error('agent-manager', `Failed to start log streaming for ${agentId}: ${error}`);
    }
  }

  private bufferLogEntry(agentId: string, streamType: number, content: string): void {
    const buffer = this.logBuffer.get(agentId);
    if (!buffer) return;

    const stream: 'stdout' | 'stderr' | 'combined' = streamType === 2 ? 'stderr' : 'stdout';
    const timestamp = new Date().toISOString();

    const lines = content.split('\n').filter(line => line.trim());
    for (const line of lines) {
      buffer.push({ timestamp, stream, content: line });
    }

    if (buffer.length >= this.LOG_BUFFER_SIZE) {
      this.flushLogBuffer(agentId);
    }
  }

  private flushLogBuffer(agentId: string): void {
    const buffer = this.logBuffer.get(agentId);
    if (!buffer || buffer.length === 0) return;

    try {
      const entries = buffer.map(entry => ({
        agentId,
        timestamp: entry.timestamp,
        stream: entry.stream,
        content: entry.content,
      }));

      this.databaseService.appendAgentLogsBatch(entries);
      buffer.length = 0;
    } catch (error) {
      this.logger.error('agent-manager', `Failed to flush log buffer for ${agentId}: ${error}`);
    }
  }

  private flushAllLogBuffers(): void {
    for (const agentId of this.logBuffer.keys()) {
      this.flushLogBuffer(agentId);
    }
  }

  private stopLogStreaming(agentId: string): void {
    const tracked = this.activeAgents.get(agentId);

    if (tracked?.logStream) {
      try {
        (tracked.logStream as unknown as { destroy?: () => void }).destroy?.();
      } catch {
        // Ignore errors
      }
    }

    this.flushLogBuffer(agentId);
    this.logBuffer.delete(agentId);
  }

  private async monitorContainer(
    agentId: string,
    containerId: string,
    workspacePath: string,
  ): Promise<void> {
    const db = this.databaseService.getDatabase();

    try {
      const container = docker.getContainer(containerId);
      const result = await container.wait();
      const exitCode = result.StatusCode;

      this.logger.info('agent-manager', `Agent ${agentId} finished with exit code ${exitCode}`);

      this.stopLogStreaming(agentId);

      const logString = this.databaseService.getAgentLogsAsString(agentId);
      const status = exitCode === 0 ? AGENT_STATUS.COMPLETED : AGENT_STATUS.FAILED;

      db.prepare(`
        UPDATE agents SET status = ?, exit_code = ?, logs = ?, completed_at = datetime('now')
        WHERE id = ?
      `).run(status, exitCode, logString, agentId);

      if (exitCode !== 0) {
        db.prepare(`
          UPDATE tasks SET status = 'failed'
          WHERE id = (SELECT task_id FROM agents WHERE id = ?)
        `).run(agentId);
      }

      const tracked = this.activeAgents.get(agentId);
      if (tracked) {
        clearTimeout(tracked.timeoutId);
        this.activeAgents.delete(agentId);
      }

      if (exitCode === 0) {
        try {
          await container.remove();
          fs.rmSync(workspacePath, { recursive: true, force: true });
          this.logger.info('agent-manager', `Cleaned up workspace for ${agentId}`);
        } catch {
          // Ignore cleanup errors
        }
      }
    } catch (error) {
      this.logger.error('agent-manager', `Error monitoring agent ${agentId}: ${error}`);
    }
  }
}
