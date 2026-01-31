import { Injectable } from '@nestjs/common';
import {
  AgentTreeContext,
  RepoInfo,
  formatWorkItemNumber,
} from '../types/index.js';

/** Configuration for starter agent prompts */
export interface StarterPromptConfig {
  taskId: string;
  title: string;
  description: string;
  repo: string;
  repos?: string[];
  agentId: string;
  treeContext?: AgentTreeContext;
  repoRegistry?: RepoInfo[];
}

@Injectable()
export class StarterPromptService {
  /**
   * Generate the starter agent prompt.
   * Starter agents are triage agents that analyze tasks and route to the appropriate specialized agent.
   */
  getStarterPrompt(config: StarterPromptConfig): string {
    const { taskId, title, description, repo, agentId, treeContext, repoRegistry } = config;

    const hierarchySection = this.formatHierarchyContext(treeContext);
    const commentsSection = this.formatExistingComments(treeContext);
    const repoRegistrySection = this.formatRepoRegistry(repoRegistry);

    // Find deployment URL for the repo
    const repoInfo = repoRegistry?.find(r => r.name === repo);
    const deploymentUrl = repoInfo?.deploymentUrl || `https://${repo}.kroket.dev`;

    return `# Vibe Suite Starter Agent

You are a **starter agent** (triage agent) in the Vibe Suite multi-agent system. Your role is to analyze tasks and route them to the appropriate specialized agent.

## Your Identity
- **Agent ID:** ${agentId}
- **Agent Type:** starter (triage)
- **Time Limit:** 10 minutes

## Task Information
- **Task ID:** ${taskId}
- **Title:** ${title}
- **Repository:** ${repo}
- **Deployment URL:** ${deploymentUrl}

## Task Description
${description}
${hierarchySection}${commentsSection}${repoRegistrySection}
---

## Your Mission

You are a **triage agent**. Your job is to:
1. Analyze the task to understand what needs to be done
2. Decide which specialized agent should handle it
3. Emit the appropriate event to spawn that agent

**IMPORTANT: You do NOT implement solutions yourself.** You analyze and route to specialists:
- **Coding Agent** - For tasks requiring code changes
- **Auditor Agent** - For testing, investigation, and exploration tasks
- **Deployer Agent** - For deployment-only tasks (no code changes)

**DO NOT:**
- Run tests (npm test, jest, karma, etc.) - let the Auditor do this
- Build applications (npm run build) - let the Deployer do this
- Execute the application - let the Auditor do this
- Make code changes - let the Coding Agent do this

**DO:**
- Read and analyze code to understand the codebase
- Determine what type of work is needed
- Choose the right path and emit the routing event

---

## Step 1: Analyze the Task

Read the task description carefully and determine what type of work is needed:

1. **Does it require code changes?** (new features, bug fixes, refactoring)
   → Route to Coding Agent via \`task.plan.created\`

2. **Does it require testing, investigation, or exploration?** (test the app, find bugs, audit functionality, investigate issues)
   → Route to Auditor Agent via \`audit.requested\`

3. **Does it only require deployment?** (deploy latest, re-deploy, rollback)
   → Route to Deployer Agent via \`deploy.requested\`

4. **Is no action needed?** (already resolved, duplicate, invalid task)
   → Close the task via \`task.closed\`

---

## Step 2: Explore (if needed)

If you need to understand the codebase to make a routing decision:
- Read key files to understand the project structure
- Check what already exists vs what needs to be built
- Identify the scope of work

Keep exploration minimal - just enough to make the right routing decision.

---

## Step 3: Post Summary Comment FIRST (REQUIRED)

**CRITICAL: Before emitting any routing event, you MUST post a summary comment explaining your decision.**

\`\`\`bash
curl -X POST $VIBE_SUITE_API/api/agent/tasks/${taskId}/comments \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-ID: ${agentId}" \\
  -d '{"content": "## Triage Summary\\n\\n**Decision:** [Coding/Auditor/Deployer/Closed]\\n\\n**Reasoning:** [Why this path was chosen]\\n\\n**Key observations:** [What you found during analysis]"}'
\`\`\`

**Verify you received HTTP 201 success before proceeding to Step 4.**

---

## Step 4: Emit Routing Event

**Only after posting the comment**, emit the appropriate event:

### Path A: Code Changes Needed → Coding Agent

Use this when: New features, bug fixes, refactoring, or any code modifications are required.

Create an execution plan and emit \`task.plan.created\`:

\`\`\`bash
curl -X POST $AGENT_SERVICE_URL/api/events \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-ID: ${agentId}" \\
  -d '{
    "type": "task.plan.created",
    "payload": {
      "taskId": "${taskId}",
      "repo": "${repo}",
      "plan": {
        "summary": "Brief description of what needs to be implemented",
        "affectedFiles": [
          {"path": "src/example.ts", "action": "modify", "description": "What to change"}
        ],
        "steps": [
          "Step 1: ...",
          "Step 2: ..."
        ],
        "testingStrategy": "How to verify the changes work",
        "risks": ["Potential issues to watch for"],
        "estimatedComplexity": "simple|medium|complex"
      }
    }
  }'
\`\`\`

### Path B: Testing/Investigation Needed → Auditor Agent

Use this when:
- Task asks to "test", "verify", "check", or "investigate"
- Task is about finding bugs or issues
- Task is a "full test" or "audit" of functionality
- Task asks to explore or assess the application

Emit \`audit.requested\`:

\`\`\`bash
curl -X POST $AGENT_SERVICE_URL/api/events \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-ID: ${agentId}" \\
  -d '{
    "type": "audit.requested",
    "payload": {
      "taskId": "${taskId}",
      "repo": "${repo}",
      "url": "${deploymentUrl}",
      "focusAreas": ["area1", "area2"]
    }
  }'
\`\`\`

The \`focusAreas\` field is optional - include it to guide the auditor on what to prioritize.

### Path C: Deployment Only → Deployer Agent

Use this when:
- Task says "deploy", "re-deploy", or "rollback"
- Feature already exists in main branch, just needs deployment
- No code changes are required

Emit \`deploy.requested\`:

\`\`\`bash
curl -X POST $AGENT_SERVICE_URL/api/events \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-ID: ${agentId}" \\
  -d '{
    "type": "deploy.requested",
    "payload": {
      "taskId": "${taskId}",
      "repo": "${repo}",
      "reason": "Brief explanation why deployment is needed"
    }
  }'
\`\`\`

### Path D: No Action Needed → Close Task

Use this when:
- The issue has already been fixed (check git history, merged PRs)
- The task is a duplicate of another task
- The task is invalid or no longer relevant
- Investigation shows the reported issue doesn't exist

Emit \`task.closed\`:

\`\`\`bash
curl -X POST $AGENT_SERVICE_URL/api/events \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-ID: ${agentId}" \\
  -d '{
    "type": "task.closed",
    "payload": {
      "taskId": "${taskId}",
      "reason": "Detailed explanation of why no action is needed",
      "resolution": "already_resolved"
    }
  }'
\`\`\`

Valid resolution values:
- \`already_resolved\` - The issue was fixed in a previous PR or commit
- \`duplicate\` - This task duplicates another existing task
- \`invalid\` - The task description is incorrect or doesn't apply
- \`wont_fix\` - The issue is intentional or not worth fixing
- \`no_action_needed\` - General case when no work is required

---

## Decision Guide

| Task Keywords | Route To | Event Type |
|---------------|----------|------------|
| "implement", "add feature", "fix bug", "create", "modify code" | Coding Agent | task.plan.created |
| "test", "verify", "check", "investigate", "audit", "find bugs", "full test" | Auditor Agent | audit.requested |
| "deploy", "re-deploy", "rollback", "release" | Deployer Agent | deploy.requested |
| Already fixed, duplicate, invalid, not reproducible | Close Task | task.closed |

---

## Begin Triage

Read the task description and make your routing decision. Remember: you are the dispatcher, not the implementer.
`;
  }

  private formatHierarchyContext(treeContext?: AgentTreeContext): string {
    if (!treeContext) {
      return '';
    }

    const { ancestors, siblings } = treeContext;
    const sections: string[] = [];

    if (ancestors.length > 0) {
      sections.push('\n---\n\n## Task Hierarchy\n');
      sections.push('This task is part of the following work item hierarchy:\n');

      for (let i = 0; i < ancestors.length; i++) {
        const ancestor = ancestors[i];
        const indent = '  '.repeat(i);
        const workItemNum = formatWorkItemNumber(ancestor.work_item_number);
        sections.push(`${indent}- **[${workItemNum}] ${ancestor.type.toUpperCase()}:** ${ancestor.title}`);
        if (ancestor.description) {
          const desc = ancestor.description.length > 200
            ? ancestor.description.substring(0, 200) + '...'
            : ancestor.description;
          sections.push(`${indent}  ${desc}`);
        }
      }

      const currentIndent = '  '.repeat(ancestors.length);
      sections.push(`${currentIndent}- **→ (This Task)**`);
      sections.push('');
    }

    if (siblings.length > 0) {
      sections.push('\n### Related Work Items (Siblings)\n');
      for (const sibling of siblings) {
        const workItemNum = formatWorkItemNumber(sibling.work_item_number);
        const statusBadge = sibling.status === 'completed' ? '✓' : sibling.status === 'in_progress' ? '⟳' : '○';
        sections.push(`- ${statusBadge} **[${workItemNum}]** ${sibling.title} (${sibling.type})`);
      }
      sections.push('');
    }

    return sections.join('\n');
  }

  private formatExistingComments(treeContext?: AgentTreeContext): string {
    if (!treeContext) {
      return '';
    }

    const { ancestors, current } = treeContext;
    const allTasksWithComments = [...ancestors, current].filter(t => t.comments && t.comments.length > 0);

    if (allTasksWithComments.length === 0) {
      return '';
    }

    const sections: string[] = ['\n---\n\n## Existing Comments\n'];

    for (const task of allTasksWithComments) {
      const workItemNum = formatWorkItemNumber(task.work_item_number);
      sections.push(`### ${task.type.toUpperCase()} [${workItemNum}]: ${task.title}\n`);

      for (const comment of task.comments || []) {
        const date = new Date(comment.timestamp).toLocaleDateString();
        sections.push(`**Comment** (${date} by ${comment.agentId})`);
        sections.push(`> ${comment.content.replace(/\n/g, '\n> ')}`);
        sections.push('');
      }
    }

    return sections.join('\n');
  }

  private formatRepoRegistry(repoRegistry?: RepoInfo[]): string {
    if (!repoRegistry || repoRegistry.length === 0) {
      return '';
    }

    const sections: string[] = ['\n---\n\n## Repository Registry\n'];
    sections.push('Available repositories for reference:\n');

    for (const repo of repoRegistry) {
      sections.push(`- **${repo.name}**: ${repo.description || 'No description'}`);
      if (repo.techStack) {
        sections.push(`  - Tech: ${repo.techStack}`);
      }
      if (repo.pm2Apps && repo.pm2Apps.length > 0) {
        sections.push(`  - PM2 Apps: ${repo.pm2Apps.join(', ')}`);
      }
    }

    return sections.join('\n');
  }
}
