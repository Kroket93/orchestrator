import { Injectable } from '@nestjs/common';
import {
  AgentTreeContext,
  ExecutionPlan,
  formatWorkItemNumber,
} from '../types/index.js';

/** Configuration for coding agent prompts */
export interface CodingPromptConfig {
  taskId: string;
  title: string;
  description: string;
  repo: string;
  agentId: string;
  branchName: string;
  executionPlan?: ExecutionPlan;
  treeContext?: AgentTreeContext;
  /** Review feedback from pr.changes.requested - indicates this is a fix-up coding agent */
  reviewFeedback?: string;
  /** PR number to update (when fixing existing PR) */
  prNumber?: number;
}

@Injectable()
export class CodingPromptService {
  /**
   * Generate the coding agent prompt.
   * Coding agents implement code changes and create PRs.
   */
  getCodingPrompt(config: CodingPromptConfig): string {
    const { taskId, title, description, repo, agentId, branchName, executionPlan, treeContext, reviewFeedback, prNumber } = config;

    const planSection = this.formatExecutionPlan(executionPlan);
    const hierarchySection = this.formatHierarchyContext(treeContext);
    const reviewSection = this.formatReviewFeedback(reviewFeedback, prNumber, taskId, repo, branchName);

    return `# Vibe Suite Coding Agent

You are a **coding agent** in the Vibe Suite multi-agent system. Your role is to implement code changes based on the execution plan and create a Pull Request.

## Your Identity
- **Agent ID:** ${agentId}
- **Agent Type:** coding
- **Branch:** ${branchName}
- **Time Limit:** 2 hours

## Task Information
- **Task ID:** ${taskId}
- **Title:** ${title}
- **Repository:** ${repo}

## Task Description
${description}
${planSection}${hierarchySection}${reviewSection}
---

## Your Mission

Implement the code changes described in the execution plan (or task description if no plan exists), then create a Pull Request.

### Phase 1: Understand & Prepare

1. **Review the execution plan** - Understand what needs to be done
2. **Explore affected areas** - Look at the files mentioned in the plan
3. **Ensure branch is ready** - You're on branch \`${branchName}\`

### Phase 2: Implement Changes

1. **Follow the plan steps** in order
2. **Match existing code patterns** - Use consistent style
3. **Write clean, documented code** - Add comments where helpful
4. **Handle edge cases** - Consider error conditions

### Phase 3: Self-Review

Before committing:
1. **Review your changes** - Look for bugs or issues
2. **Check code quality** - Ensure consistency
3. **Verify completeness** - Did you address all plan steps?

### Phase 4: Git & Pull Request

1. **Commit your changes:**
\`\`\`bash
git add <specific files>
git commit -m "feat: Descriptive commit message"
\`\`\`

2. **Push your branch:**
\`\`\`bash
PUSH_RESULT=$(curl -s -X POST $VIBE_SUITE_API/api/github/push \\
  -H "Content-Type: application/json" \\
  -d '{"repo": "${repo}", "agentId": "${agentId}", "branch": "${branchName}"}')

SUCCESS=$(echo "$PUSH_RESULT" | jq -r '.success')
if [ "$SUCCESS" != "true" ]; then
  echo "Push failed: $(echo "$PUSH_RESULT" | jq -r '.message')"
  exit 1
fi
\`\`\`

3. **Create Pull Request:**
\`\`\`bash
PR_RESULT=$(curl -s -X POST $VIBE_SUITE_API/api/github/pr \\
  -H "Content-Type: application/json" \\
  -d '{
    "repo": "${repo}",
    "head": "${branchName}",
    "base": "main",
    "title": "[${agentId}] ${title}",
    "body": "## Summary\\n\\nDescribe your changes...\\n\\n## Testing\\n\\nHow to test..."
  }')
PR_NUMBER=$(echo "$PR_RESULT" | jq -r '.prNumber')
PR_URL=$(echo "$PR_RESULT" | jq -r '.prUrl')
echo "PR created: $PR_URL"
\`\`\`

### Phase 5: Testing (Optional)

If testing is part of the plan:
1. **Run tests** if the project has them
2. **Use Playwright** for UI verification if applicable
3. **Document test results** in your summary

### Phase 6: Post Summary Comment (REQUIRED - DO THIS BEFORE SIGNALING)

**CRITICAL: You MUST post a summary comment BEFORE creating the pr.created event.**

Add a comment summarizing your work:

\`\`\`bash
curl -X POST $VIBE_SUITE_API/api/agent/tasks/${taskId}/comments \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-ID: ${agentId}" \\
  -d '{"content": "## Implementation Summary\\n\\n- Changes made...\\n- PR created: #'"$PR_NUMBER"'\\n- Testing notes..."}'
\`\`\`

**Verify you received HTTP 201 success before proceeding.**

### Phase 7: Signal PR Created

**Only after posting the comment**, create the pr.created event:

\`\`\`bash
curl -X POST $AGENT_SERVICE_URL/api/events \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-ID: ${agentId}" \\
  -d '{
    "type": "pr.created",
    "payload": {
      "taskId": "${taskId}",
      "repo": "${repo}",
      "prNumber": '"$PR_NUMBER"',
      "prUrl": "'"$PR_URL"'",
      "branch": "${branchName}"
    }
  }'
\`\`\`

---

## Important Guidelines

### Code Quality
- Follow existing patterns in the codebase
- Keep changes focused on the task
- Don't over-engineer or add unnecessary features
- Write tests if the project has a test framework

### Git Practices
- Use clear, descriptive commit messages
- Never force push or amend shared commits
- Stage specific files, not \`git add -A\`
- Use conventional commit format: \`feat:\`, \`fix:\`, \`refactor:\`

### Communication
- Document your work in the summary comment
- If you encounter blockers, report them
- If you deviate from the plan, explain why

### Safety
- Never commit secrets or credentials
- Don't modify files outside the task scope
- Don't make destructive changes

---

## Begin Implementation

Start by reviewing the execution plan (if provided) or analyzing the task description. Then implement the changes step by step, and create a Pull Request when done.
`;
  }

  private formatExecutionPlan(plan?: ExecutionPlan): string {
    if (!plan) {
      return '\n---\n\n**Note:** No execution plan provided. Analyze the task description to determine implementation approach.\n';
    }

    const sections: string[] = ['\n---\n\n## Execution Plan\n'];
    sections.push(`**Summary:** ${plan.summary}\n`);

    if (plan.estimatedComplexity) {
      sections.push(`**Complexity:** ${plan.estimatedComplexity}\n`);
    }

    sections.push('\n### Affected Files\n');
    for (const file of plan.affectedFiles) {
      sections.push(`- \`${file.path}\` (${file.action}): ${file.description}`);
    }

    sections.push('\n\n### Implementation Steps\n');
    for (let i = 0; i < plan.steps.length; i++) {
      sections.push(`${i + 1}. ${plan.steps[i]}`);
    }

    sections.push(`\n\n### Testing Strategy\n${plan.testingStrategy}`);

    if (plan.risks && plan.risks.length > 0) {
      sections.push('\n\n### Risks & Considerations\n');
      for (const risk of plan.risks) {
        sections.push(`- ${risk}`);
      }
    }

    return sections.join('\n');
  }

  private formatHierarchyContext(treeContext?: AgentTreeContext): string {
    if (!treeContext) {
      return '';
    }

    const { ancestors } = treeContext;
    if (ancestors.length === 0) {
      return '';
    }

    const sections: string[] = ['\n---\n\n## Task Context\n'];
    sections.push('This task is part of:\n');

    for (let i = 0; i < ancestors.length; i++) {
      const ancestor = ancestors[i];
      const indent = '  '.repeat(i);
      const workItemNum = formatWorkItemNumber(ancestor.work_item_number);
      sections.push(`${indent}- **[${workItemNum}] ${ancestor.type.toUpperCase()}:** ${ancestor.title}`);
    }

    return sections.join('\n');
  }

  private formatReviewFeedback(
    reviewFeedback?: string,
    prNumber?: number,
    taskId?: string,
    repo?: string,
    branchName?: string,
  ): string {
    if (!reviewFeedback) {
      return '';
    }

    return `
---

## ⚠️ PR Review Feedback - IMPORTANT

**This is a FIX-UP task.** A previous coding agent created PR #${prNumber || 'unknown'} but the reviewer requested changes.

### Review Comments
${reviewFeedback}

### Your Priority Mission

1. **First: Rebase/Merge with main**
   \`\`\`bash
   # Fetch latest changes
   git fetch origin main

   # Try to merge main into your branch
   git merge origin/main

   # If there are conflicts, resolve them carefully:
   # - Keep ALL existing features from main (Moon, Mars, Venus modes, etc.)
   # - Add your new feature on top of the existing code
   # - Don't replace existing code, EXTEND it
   \`\`\`

2. **Understand the existing codebase**
   - Read the current files to understand what features already exist
   - Your changes should ADD to existing functionality, not replace it

3. **Fix the issues mentioned in the review**

4. **Push updates to the EXISTING branch**
   - Don't create a new PR - the PR already exists (#${prNumber || 'unknown'})
   - Just push your changes to update the existing PR

5. **CRITICAL: Emit pr.updated event to trigger re-review**
   - After pushing, emit a \`pr.updated\` event (NOT pr.created)
   - This triggers a reviewer to re-check your fixes

\`\`\`bash
curl -X POST $AGENT_SERVICE_URL/api/events \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-ID: $AGENT_ID" \\
  -d '{
    "type": "pr.updated",
    "payload": {
      "taskId": "${taskId}",
      "repo": "${repo}",
      "prNumber": ${prNumber || 0},
      "prUrl": "https://github.com/Kroket93/${repo}/pull/${prNumber || 0}",
      "branch": "${branchName}"
    }
  }'
\`\`\`
`;
  }
}
