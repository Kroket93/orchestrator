// Agent Types
export type AgentType = 'starter' | 'coding' | 'reviewer' | 'deployer' | 'verifier' | 'auditor' | 'healthcheck';
export type AgentMode = 'docker' | 'host';
export type AgentDbStatus = 'starting' | 'running' | 'completed' | 'failed' | 'timeout' | 'killed';
export type TaskStatus = 'pending' | 'queued' | 'assigned' | 'in_progress' | 'completed' | 'failed';
export type TaskType = 'epic' | 'feature' | 'story' | 'task' | 'bug';

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
  healthcheck: {
    timeout: 60 * 60 * 1000, // 60 minutes
    mode: 'host',
    description: 'Nightly health check - inspects services, databases, and applications for issues',
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

// Tree Context (task hierarchy for agent prompts)
export interface AgentTreeContext {
  ancestors: ParsedTask[];
  current: ParsedTask;
  siblings: ParsedTask[];
}

// Parsed Task structure (used in tree context)
export interface ParsedTask {
  id: string;
  work_item_number?: number;
  title: string;
  description?: string;
  type: TaskType;
  status: TaskStatus;
  repo?: string;
  repos?: string[];
  executionPlan?: ExecutionPlan;
  comments?: TaskComment[];
}

// Task Comment
export interface TaskComment {
  id: string;
  content: string;
  agentId: string;
  timestamp: string;
}

// Execution Plan (from starter agent)
export interface ExecutionPlan {
  summary: string;
  affectedFiles: Array<{
    path: string;
    action: 'create' | 'modify' | 'delete';
    description: string;
  }>;
  steps: string[];
  testingStrategy: string;
  risks?: string[];
  estimatedComplexity?: 'simple' | 'medium' | 'complex';
}

// Repository information for agent prompts
export interface RepoInfo {
  name: string;
  path: string;
  description?: string;
  techStack?: string;
  pm2Apps?: string[];
  deploymentUrl?: string;
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
  treeContext?: AgentTreeContext;
  executionPlan?: ExecutionPlan;
  repoRegistry?: RepoInfo[];
  // Additional fields for specific agent types
  prNumber?: number;
  prUrl?: string;
  branch?: string;
  deploymentUrl?: string;
  focusAreas?: string[];
  reviewFeedback?: string;
  existingBranch?: string;
  // Workflow-driven spawning
  /** Full prompt to pass to the agent (caller generates, orchestrator executes) */
  prompt?: string;
  /** Callback URL to notify when agent completes */
  callbackUrl?: string;
}

// ==================== Event Types ====================

export type EventType =
  | 'task.assigned'
  | 'task.plan.created'
  | 'task.closed'
  | 'deploy.requested'
  | 'pr.created'
  | 'pr.updated'
  | 'pr.changes.requested'
  | 'pr.merged'
  | 'deploy.completed'
  | 'deploy.failed'
  | 'verify.passed'
  | 'verify.failed'
  | 'audit.requested'
  | 'audit.finding'
  | 'audit.completed'
  | 'agent.escalation';

/** Base event structure */
export interface BaseEvent {
  id: string;
  type: EventType;
  timestamp: string;
  source: string;
  payload: Record<string, unknown>;
}

/** Event for task assignment */
export interface TaskAssignedEvent extends BaseEvent {
  type: 'task.assigned';
  payload: {
    taskId: string;
    title: string;
    description: string;
    repo: string;
    repos?: string[];
    investigationOnly?: boolean;
  };
}

/** Event for plan creation */
export interface TaskPlanCreatedEvent extends BaseEvent {
  type: 'task.plan.created';
  payload: {
    taskId: string;
    repo: string;
    plan: ExecutionPlan;
  };
}

/** Event for closing a task without further action */
export interface TaskClosedEvent extends BaseEvent {
  type: 'task.closed';
  payload: {
    taskId: string;
    reason: string;
    resolution: 'already_resolved' | 'duplicate' | 'invalid' | 'wont_fix' | 'no_action_needed';
  };
}

/** Event for deployment request */
export interface DeployRequestedEvent extends BaseEvent {
  type: 'deploy.requested';
  payload: {
    taskId: string;
    repo: string;
    reason: string;
    commit?: string;
  };
}

/** Event for PR creation */
export interface PrCreatedEvent extends BaseEvent {
  type: 'pr.created';
  payload: {
    taskId: string;
    repo: string;
    prNumber: number;
    prUrl: string;
    branch: string;
  };
}

/** Event for PR updated (after fix-up) */
export interface PrUpdatedEvent extends BaseEvent {
  type: 'pr.updated';
  payload: {
    taskId: string;
    repo: string;
    prNumber: number;
    prUrl: string;
    branch: string;
  };
}

/** Event for PR changes requested */
export interface PrChangesRequestedEvent extends BaseEvent {
  type: 'pr.changes.requested';
  payload: {
    taskId: string;
    repo: string;
    prNumber: number;
    branch: string;
    reviewComments: string;
  };
}

/** Event for PR merge */
export interface PrMergedEvent extends BaseEvent {
  type: 'pr.merged';
  payload: {
    taskId: string;
    repo: string;
    prNumber: number;
    mergeCommit: string;
    branch?: string;
    commitSha?: string;
  };
}

/** Event for successful deployment */
export interface DeployCompletedEvent extends BaseEvent {
  type: 'deploy.completed';
  payload: {
    taskId: string;
    repo: string;
    url: string;
    status: 'success';
  };
}

/** Event for failed deployment */
export interface DeployFailedEvent extends BaseEvent {
  type: 'deploy.failed';
  payload: {
    taskId: string;
    repo: string;
    error: string;
    logs?: string;
  };
}

/** Event for verification passed */
export interface VerifyPassedEvent extends BaseEvent {
  type: 'verify.passed';
  payload: {
    taskId: string;
    repo: string;
    summary: string;
  };
}

/** Event for verification failed */
export interface VerifyFailedEvent extends BaseEvent {
  type: 'verify.failed';
  payload: {
    taskId: string;
    repo: string;
    bug: {
      description: string;
      steps: string;
      expected: string;
      actual: string;
    };
  };
}

/** Event for audit requested */
export interface AuditRequestedEvent extends BaseEvent {
  type: 'audit.requested';
  payload: {
    taskId: string;
    repo: string;
    url: string;
    focusAreas?: string[];
  };
}

/** Event for audit finding */
export interface AuditFindingEvent extends BaseEvent {
  type: 'audit.finding';
  payload: {
    taskId: string;
    repo: string;
    parentId?: string;
    finding: {
      severity: 'low' | 'medium' | 'high' | 'critical';
      category: 'bug' | 'ux' | 'performance' | 'security' | 'accessibility';
      title: string;
      description: string;
      steps?: string;
      screenshot?: string;
    };
  };
}

/** Event for audit completed */
export interface AuditCompletedEvent extends BaseEvent {
  type: 'audit.completed';
  payload: {
    taskId: string;
    repo: string;
    summary: string;
    findingsCount: number;
    duration: number;
  };
}

/** Event for agent escalation */
export interface AgentEscalationEvent extends BaseEvent {
  type: 'agent.escalation';
  payload: {
    taskId: string;
    agentId: string;
    reason: string;
    context?: Record<string, unknown>;
  };
}

/** Union type for all events */
export type AgentEvent =
  | TaskAssignedEvent
  | TaskPlanCreatedEvent
  | TaskClosedEvent
  | DeployRequestedEvent
  | PrCreatedEvent
  | PrUpdatedEvent
  | PrChangesRequestedEvent
  | PrMergedEvent
  | DeployCompletedEvent
  | DeployFailedEvent
  | VerifyPassedEvent
  | VerifyFailedEvent
  | AuditRequestedEvent
  | AuditFindingEvent
  | AuditCompletedEvent
  | AgentEscalationEvent;

// Queue Settings
export const QUEUE_SETTING_KEYS = {
  PAUSED: 'paused',
  STOP_ON_FAILURE: 'stop_on_failure',
  MAX_CONCURRENT: 'max_concurrent',
} as const;

// ==================== Utility Functions ====================

/**
 * Format work item number with WI- prefix and zero-padding
 */
export function formatWorkItemNumber(num?: number): string {
  if (num === undefined || num === null) {
    return 'WI-???';
  }
  return `WI-${num.toString().padStart(3, '0')}`;
}
