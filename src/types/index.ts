// Agent Types
export type AgentType = 'starter' | 'coding' | 'reviewer' | 'deployer' | 'verifier' | 'auditor';
export type AgentMode = 'docker' | 'host';
export type AgentDbStatus = 'starting' | 'running' | 'completed' | 'failed' | 'timeout' | 'killed';
export type TaskStatus = 'pending' | 'queued' | 'assigned' | 'in_progress' | 'completed' | 'failed';

// Agent Configuration
export interface AgentTypeConfig {
  timeout: number;
  mode: AgentMode;
  description: string;
}

export const AGENT_TYPE_CONFIGS: Record<AgentType, AgentTypeConfig> = {
  starter: {
    timeout: 10 * 60 * 1000, // 10 minutes
    mode: 'docker',
    description: 'Analyzes task, identifies affected repos, creates execution plan',
  },
  coding: {
    timeout: 2 * 60 * 60 * 1000, // 2 hours
    mode: 'docker',
    description: 'Implements code changes, creates feature branch, opens PR',
  },
  reviewer: {
    timeout: 30 * 60 * 1000, // 30 minutes
    mode: 'docker',
    description: 'Reviews PRs, evaluates code quality/security/tests, merges or requests changes',
  },
  deployer: {
    timeout: 30 * 60 * 1000, // 30 minutes
    mode: 'host',
    description: 'Deploys merged code, restarts PM2 apps, verifies deployment',
  },
  verifier: {
    timeout: 30 * 60 * 1000, // 30 minutes
    mode: 'docker',
    description: 'Tests deployed functionality using Playwright to verify changes work',
  },
  auditor: {
    timeout: 45 * 60 * 1000, // 45 minutes
    mode: 'docker',
    description: 'Explores deployed apps to proactively find issues',
  },
};

const DEFAULT_AGENT_TIMEOUT = 2 * 60 * 60 * 1000; // 2 hours

export function getAgentTimeout(agentType: AgentType): number {
  return AGENT_TYPE_CONFIGS[agentType]?.timeout ?? DEFAULT_AGENT_TIMEOUT;
}

export function getAgentMode(agentType: AgentType): AgentMode {
  return AGENT_TYPE_CONFIGS[agentType]?.mode ?? 'docker';
}

export function isHostAgent(agentType: AgentType): boolean {
  return getAgentMode(agentType) === 'host';
}

// Agent Instance
export interface AgentInstance {
  id: string;
  taskId: string;
  containerId: string | null;
  status: AgentDbStatus;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  error?: string;
  agentType: AgentType;
}

// Agent Configuration for spawning
export interface AgentConfig {
  taskId: string;
  repo: string;
  repos?: string[];
  title: string;
  description: string;
  investigationOnly?: boolean;
  agentType?: AgentType;
  // Additional fields for specific agent types
  prNumber?: number;
  prUrl?: string;
  branch?: string;
  deploymentUrl?: string;
  focusAreas?: string[];
  reviewFeedback?: string;
  existingBranch?: string;
}

// Event Types
export type EventType =
  | 'task.assigned'
  | 'task.plan.created'
  | 'pr.created'
  | 'pr.changes.requested'
  | 'pr.merged'
  | 'deploy.completed'
  | 'verify.passed'
  | 'verify.failed'
  | 'audit.requested'
  | 'audit.completed';

export interface AgentEvent {
  id: string;
  type: EventType;
  timestamp: string;
  source: string;
  payload: Record<string, unknown>;
}

// Queue Settings
export const QUEUE_SETTING_KEYS = {
  PAUSED: 'paused',
  STOP_ON_FAILURE: 'stop_on_failure',
  MAX_CONCURRENT: 'max_concurrent',
} as const;

// Execution Plan (from starter agent)
export interface ExecutionPlan {
  steps: ExecutionStep[];
  context?: string;
}

export interface ExecutionStep {
  description: string;
  files?: string[];
  type?: 'create' | 'modify' | 'delete' | 'test' | 'config';
}

// Tree Context (task hierarchy)
export interface AgentTreeContext {
  ancestors: TaskSummary[];
  siblings: TaskSummary[];
}

export interface TaskSummary {
  id: string;
  title: string;
  type: string;
  status: string;
  description?: string;
}
