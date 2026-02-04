import { Injectable } from '@nestjs/common';

/** Configuration for core healthcheck agent prompts */
export interface CoreHealthcheckPromptConfig {
  taskId: string;
  title: string;
  description: string;
  agentId: string;
}

/** Configuration for app healthcheck agent prompts */
export interface AppHealthcheckPromptConfig {
  taskId: string;
  title: string;
  description: string;
  agentId: string;
  appName: string;
  deploymentUrl?: string;
}

/** Parsed description with optional epic ID */
interface ParsedDescription {
  epicId?: string;
  description: string;
}

@Injectable()
export class HealthcheckPromptService {
  /**
   * Parse description to extract epic ID if present.
   * Format: "EPIC_ID: xxx\n\n<actual description>"
   */
  private parseDescription(description: string): ParsedDescription {
    const epicIdMatch = description.match(/^EPIC_ID:\s*([^\n]+)\n\n([\s\S]*)$/);
    if (epicIdMatch) {
      return {
        epicId: epicIdMatch[1].trim(),
        description: epicIdMatch[2].trim(),
      };
    }
    return { description };
  }

  /**
   * Generate the core infrastructure healthcheck prompt.
   * Inspects VPS, orchestrator, vibe-suite, databases, and agent metrics.
   */
  getCoreHealthcheckPrompt(config: CoreHealthcheckPromptConfig): string {
    const { taskId, title, agentId } = config;
    const { epicId, description } = this.parseDescription(config.description);
    const date = new Date().toISOString().split('T')[0];

    // Generate the reporting section based on whether epic ID is provided
    const reportingSection = epicId
      ? this.getCoreReportingSectionWithEpic(agentId, taskId, date, epicId)
      : this.getCoreReportingSectionCreateEpic(agentId, taskId, date);

    return `# Vibe Suite Core Infrastructure Health Check Agent

You are a **healthcheck agent** in the Vibe Suite multi-agent system. Your role is to perform a thorough nightly inspection of the VPS infrastructure, services, databases, and agent metrics to identify issues before they become problems.

## Your Identity
- **Agent ID:** ${agentId}
- **Agent Type:** healthcheck
- **Time Limit:** 60 minutes
- **Date:** ${date}

## Task Information
- **Task ID:** ${taskId}
- **Title:** ${title}
${epicId ? `- **Epic ID:** ${epicId} (use this for all findings)` : ''}

## Context
${description}

---

## Your Mission

Perform a comprehensive health check of the core infrastructure and report findings. You have full access to the VPS and should investigate anything that seems off.

**Important:** This is an investigative mission. The phases below are guidance, not strict rules. If you notice something unusual, follow that thread. Trust your instincts about "something doesn't look right."

---

## Phase 1: System Health (~5 min)

Check the overall health of the VPS:

\`\`\`bash
# Check PM2 status (all services running?)
pm2 status

# Check disk usage
df -h

# Check memory usage
free -h

# Check CPU load
uptime

# Check listening ports
netstat -tlnp 2>/dev/null || ss -tlnp

# Verify core services responding
curl -sf http://localhost:3020/api/health && echo "Orchestrator: OK" || echo "Orchestrator: FAILED"
curl -sf http://localhost:3030/api/health && echo "Vibe-Suite: OK" || echo "Vibe-Suite: FAILED"
\`\`\`

**Look for:**
- Services not in "online" status
- Disk usage > 80%
- Memory usage > 90%
- High load average (> 4.0 for this VPS)
- Services not responding on expected ports

---

## Phase 2: Agent Metrics (~15 min)

Analyze agent performance and identify patterns:

\`\`\`bash
# Get overall agent analytics
curl -s http://localhost:3020/api/agents/analytics

# Get recent agents (last 100)
curl -s http://localhost:3020/api/agents
\`\`\`

**Query the orchestrator database directly for deeper analysis:**

\`\`\`bash
# Success/failure rates (24h)
sqlite3 /home/claude/data/orchestrator.db "
SELECT
  status,
  COUNT(*) as count,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 1) as percentage
FROM agents
WHERE started_at > datetime('now', '-24 hours')
GROUP BY status
ORDER BY count DESC;
"

# Success/failure rates (7d)
sqlite3 /home/claude/data/orchestrator.db "
SELECT
  status,
  COUNT(*) as count,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 1) as percentage
FROM agents
WHERE started_at > datetime('now', '-7 days')
GROUP BY status
ORDER BY count DESC;
"

# Agents stuck in 'running' state (should complete within timeout)
sqlite3 /home/claude/data/orchestrator.db "
SELECT id, task_id, agent_type, started_at,
  ROUND((julianday('now') - julianday(started_at)) * 24 * 60, 1) as minutes_running
FROM agents
WHERE status = 'running'
AND started_at < datetime('now', '-2 hours')
ORDER BY started_at;
"

# Recent failures with errors
sqlite3 /home/claude/data/orchestrator.db "
SELECT id, agent_type, error, completed_at
FROM agents
WHERE status IN ('failed', 'timeout', 'killed')
AND completed_at > datetime('now', '-24 hours')
ORDER BY completed_at DESC
LIMIT 10;
"

# Timeout rates by agent type
sqlite3 /home/claude/data/orchestrator.db "
SELECT
  agent_type,
  SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END) as timeouts,
  COUNT(*) as total,
  ROUND(SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as timeout_pct
FROM agents
WHERE started_at > datetime('now', '-7 days')
GROUP BY agent_type
ORDER BY timeout_pct DESC;
"

# Average execution times by agent type (completed only)
sqlite3 /home/claude/data/orchestrator.db "
SELECT
  agent_type,
  ROUND(AVG((julianday(completed_at) - julianday(started_at)) * 24 * 60), 1) as avg_minutes,
  MIN(ROUND((julianday(completed_at) - julianday(started_at)) * 24 * 60, 1)) as min_minutes,
  MAX(ROUND((julianday(completed_at) - julianday(started_at)) * 24 * 60, 1)) as max_minutes
FROM agents
WHERE status = 'completed'
AND completed_at > datetime('now', '-7 days')
GROUP BY agent_type;
"
\`\`\`

**Look for:**
- Failure rate > 20%
- Timeout rate > 10% for any agent type
- Agents stuck in running state
- Unusual patterns in failures
- Increasing execution times

---

## Phase 3: Queue Health (~5 min)

Check the task queue status:

\`\`\`bash
# Queue status
curl -s http://localhost:3020/api/queue

# Queue settings
curl -s http://localhost:3020/api/queue/settings
\`\`\`

**Check for stuck items:**
\`\`\`bash
sqlite3 /home/claude/data/orchestrator.db "
SELECT id, task_id, status, queued_at,
  ROUND((julianday('now') - julianday(queued_at)) * 24, 1) as hours_in_queue
FROM queue
WHERE status IN ('queued', 'processing')
AND queued_at < datetime('now', '-4 hours')
ORDER BY queued_at;
"
\`\`\`

**Look for:**
- Items stuck in queue > 4 hours
- Queue paused unexpectedly
- Processing items that should have completed

---

## Phase 4: Database Health (~10 min)

Check database integrity and growth:

\`\`\`bash
# Database file sizes
ls -lh /home/claude/data/*.db

# Orchestrator DB integrity
sqlite3 /home/claude/data/orchestrator.db "PRAGMA integrity_check;"

# Vibe-Suite DB integrity
sqlite3 /home/claude/data/vibe-suite.db "PRAGMA integrity_check;"

# Table row counts - Orchestrator
sqlite3 /home/claude/data/orchestrator.db "
SELECT 'agents' as table_name, COUNT(*) as rows FROM agents
UNION ALL
SELECT 'agent_logs', COUNT(*) FROM agent_logs
UNION ALL
SELECT 'tasks', COUNT(*) FROM tasks
UNION ALL
SELECT 'queue', COUNT(*) FROM queue;
"

# Table row counts - Vibe-Suite
sqlite3 /home/claude/data/vibe-suite.db "
SELECT 'tasks' as table_name, COUNT(*) as rows FROM tasks
UNION ALL
SELECT 'comments', COUNT(*) FROM comments;
"

# Check for orphaned records (agents without tasks)
sqlite3 /home/claude/data/orchestrator.db "
SELECT COUNT(*) as orphaned_agents
FROM agents a
WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = a.task_id);
"

# Check agent_logs growth (can become very large)
sqlite3 /home/claude/data/orchestrator.db "
SELECT
  date(timestamp) as date,
  COUNT(*) as log_entries,
  SUM(LENGTH(content)) / 1024 / 1024.0 as mb_size
FROM agent_logs
WHERE timestamp > datetime('now', '-7 days')
GROUP BY date(timestamp)
ORDER BY date DESC;
"
\`\`\`

**Look for:**
- Integrity check failures
- Databases > 500MB (may need cleanup)
- Rapid growth in agent_logs
- Orphaned records

---

## Phase 5: Workspace & Storage (~5 min)

Check agent workspaces and storage:

\`\`\`bash
# Agent workspaces disk usage
du -sh /home/claude/agent-workspaces/
du -sh /home/claude/agent-workspaces-staging/ 2>/dev/null || echo "No staging workspaces"

# Count workspace directories
ls -la /home/claude/agent-workspaces/ | wc -l

# Check for old workspaces (> 7 days)
find /home/claude/agent-workspaces/ -maxdepth 1 -type d -mtime +7 | head -20

# Event directories
du -sh /home/claude/data/orchestrator-events/
ls /home/claude/data/orchestrator-events/ | wc -l

# Projects disk usage
du -sh /home/claude/projects/
\`\`\`

**Look for:**
- Workspace directory > 5GB
- Many old workspaces not cleaned up
- Event directory growing too large

---

## Phase 6: Code & Security (~15 min)

Check for security issues and outdated dependencies:

\`\`\`bash
# Check for exposed credentials in project directories
# (Look for common patterns, don't output actual secrets)
grep -r "password\\s*=" /home/claude/projects/*/. 2>/dev/null | grep -v node_modules | grep -v ".git" | head -10
grep -r "ANTHROPIC_API_KEY" /home/claude/projects/*/. 2>/dev/null | grep -v node_modules | grep -v ".git" | head -5

# Check file permissions on sensitive files
ls -la /home/claude/.claude/*.json 2>/dev/null
ls -la /home/claude/data/*.db

# Check for .env files (should exist but not have overly open permissions)
find /home/claude/projects -name ".env*" -type f 2>/dev/null

# Check npm audit in key projects (vulnerabilities)
cd /home/claude/projects/orchestrator && npm audit --audit-level=high 2>/dev/null | head -30
cd /home/claude/projects/vibe-suite/backend && npm audit --audit-level=high 2>/dev/null | head -30

# Check for outdated dependencies
cd /home/claude/projects/orchestrator && npm outdated 2>/dev/null | head -15
\`\`\`

**Look for:**
- Hardcoded credentials
- World-readable sensitive files
- High/critical npm vulnerabilities
- Severely outdated dependencies

---

${reportingSection}

---

## Investigation Freedom

This is an investigative mission. While the phases above provide structure, you should:

- **Follow interesting threads** - If something looks off, investigate deeper
- **Use your judgment** - Decide what's worth investigating
- **Look at actual data** - Query databases, read logs, check configurations
- **Read code when needed** - If behavior seems wrong, check the source
- **Trust your instincts** - "Something doesn't look right" is worth investigating

**Time management:** Don't spend more than 15 min on any single investigation. If something needs deep analysis, create a finding for follow-up.

---

## Begin Health Check

Start by checking system health (PM2 status, disk, memory). Then work through each phase systematically, noting anything unusual for your findings report.
`;
  }

  /**
   * Generate reporting section when epic ID is provided (no need to create epic)
   */
  private getCoreReportingSectionWithEpic(agentId: string, taskId: string, date: string, epicId: string): string {
    return `## Phase 7: Report Findings

### Step 1: Create the Core Infrastructure Feature

The nightly epic has already been created. Create a feature under it for your core infrastructure findings:

\`\`\`bash
curl -X POST $VIBE_SUITE_API/api/agent/tasks \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-ID: ${agentId}" \\
  -d '{
    "title": "Core Infrastructure Health",
    "description": "VPS, orchestrator, vibe-suite, databases, agent metrics",
    "type": "feature",
    "parentId": "${epicId}",
    "repo": "orchestrator"
  }'
\`\`\`

Save the returned feature ID for creating child items.

### Step 2: Report Individual Findings

For EACH issue found, create a task or bug under the feature:

\`\`\`bash
curl -X POST $VIBE_SUITE_API/api/agent/tasks \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-ID: ${agentId}" \\
  -d '{
    "title": "Brief issue title",
    "description": "## Problem\\n\\nDetailed description...\\n\\n## Evidence\\n\\n\\\`\\\`\\\`\\nrelevant output\\n\\\`\\\`\\\`\\n\\n## Recommended Action\\n\\n...",
    "type": "bug",
    "parentId": "FEATURE_ID_HERE",
    "repo": "orchestrator",
    "metadata": {
      "severity": "critical|high|medium|low",
      "category": "service|performance|security|data|infrastructure|code"
    }
  }'
\`\`\`

### Severity Guide

- **critical** - Service down, security breach, data loss risk
- **high** - Major functionality degraded, significant performance issue
- **medium** - Minor issues, unusual patterns, cleanup needed
- **low** - Optimization suggestions, minor improvements

### Categories

- **service** - PM2/service health issues
- **performance** - Slow queries, high resource usage
- **security** - Credentials, vulnerabilities, permissions
- **data** - Database anomalies, orphaned records
- **infrastructure** - Disk, memory, network issues
- **code** - Code quality, outdated dependencies

### Step 3: Post Summary Comment

Post a summary comment on the task that triggered this health check:

\`\`\`bash
curl -X POST $VIBE_SUITE_API/api/agent/tasks/${taskId}/comments \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-ID: ${agentId}" \\
  -d '{
    "content": "## Core Infrastructure Health Check Complete\\n\\n**Date:** ${date}\\n**Duration:** X minutes\\n\\n### Overall Status\\n\\n[HEALTHY/DEGRADED/CRITICAL]\\n\\n### Summary\\n\\n- Services: X/Y running\\n- Disk usage: X%\\n- Agent success rate (24h): X%\\n- Database integrity: [OK/ISSUES]\\n\\n### Findings\\n\\n- Critical: X\\n- High: X\\n- Medium: X\\n- Low: X\\n\\n### Key Issues\\n\\n1. ...\\n2. ...\\n\\n### Recommendations\\n\\n1. ..."
  }'
\`\`\``;
  }

  /**
   * Generate reporting section when no epic ID is provided (need to create epic)
   */
  private getCoreReportingSectionCreateEpic(agentId: string, taskId: string, date: string): string {
    return `## Phase 7: Report Findings

### Step 1: Create the Nightly Epic

First, create an epic for today's health check findings:

\`\`\`bash
curl -X POST $VIBE_SUITE_API/api/agent/tasks \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-ID: ${agentId}" \\
  -d '{
    "title": "Nightly Health Check - ${date}",
    "description": "Automated nightly health check findings for ${date}",
    "type": "epic",
    "repo": "orchestrator"
  }'
\`\`\`

Save the returned epic ID for creating child items.

### Step 2: Create the Core Infrastructure Feature

Create a feature under the epic for your core infrastructure findings:

\`\`\`bash
curl -X POST $VIBE_SUITE_API/api/agent/tasks \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-ID: ${agentId}" \\
  -d '{
    "title": "Core Infrastructure Health",
    "description": "VPS, orchestrator, vibe-suite, databases, agent metrics",
    "type": "feature",
    "parentId": "EPIC_ID_HERE",
    "repo": "orchestrator"
  }'
\`\`\`

### Step 3: Report Individual Findings

For EACH issue found, create a task or bug under the feature:

\`\`\`bash
curl -X POST $VIBE_SUITE_API/api/agent/tasks \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-ID: ${agentId}" \\
  -d '{
    "title": "Brief issue title",
    "description": "## Problem\\n\\nDetailed description...\\n\\n## Evidence\\n\\n\\\`\\\`\\\`\\nrelevant output\\n\\\`\\\`\\\`\\n\\n## Recommended Action\\n\\n...",
    "type": "bug",
    "parentId": "FEATURE_ID_HERE",
    "repo": "orchestrator",
    "metadata": {
      "severity": "critical|high|medium|low",
      "category": "service|performance|security|data|infrastructure|code"
    }
  }'
\`\`\`

### Severity Guide

- **critical** - Service down, security breach, data loss risk
- **high** - Major functionality degraded, significant performance issue
- **medium** - Minor issues, unusual patterns, cleanup needed
- **low** - Optimization suggestions, minor improvements

### Categories

- **service** - PM2/service health issues
- **performance** - Slow queries, high resource usage
- **security** - Credentials, vulnerabilities, permissions
- **data** - Database anomalies, orphaned records
- **infrastructure** - Disk, memory, network issues
- **code** - Code quality, outdated dependencies

### Step 4: Post Summary Comment

Post a summary comment on the task that triggered this health check:

\`\`\`bash
curl -X POST $VIBE_SUITE_API/api/agent/tasks/${taskId}/comments \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-ID: ${agentId}" \\
  -d '{
    "content": "## Core Infrastructure Health Check Complete\\n\\n**Date:** ${date}\\n**Duration:** X minutes\\n\\n### Overall Status\\n\\n[HEALTHY/DEGRADED/CRITICAL]\\n\\n### Summary\\n\\n- Services: X/Y running\\n- Disk usage: X%\\n- Agent success rate (24h): X%\\n- Database integrity: [OK/ISSUES]\\n\\n### Findings\\n\\n- Critical: X\\n- High: X\\n- Medium: X\\n- Low: X\\n\\n### Key Issues\\n\\n1. ...\\n2. ...\\n\\n### Recommendations\\n\\n1. ..."
  }'
\`\`\``;
  }

  /**
   * Generate the app-specific healthcheck prompt.
   * Tests a specific application's functionality and health.
   */
  getAppHealthcheckPrompt(config: AppHealthcheckPromptConfig): string {
    const { taskId, title, agentId, appName, deploymentUrl } = config;
    const { epicId, description } = this.parseDescription(config.description);
    const date = new Date().toISOString().split('T')[0];
    const url = deploymentUrl || `http://128.140.104.248/${appName}`;

    // Generate the reporting section based on whether epic ID is provided
    const reportingSection = epicId
      ? this.getAppReportingSectionWithEpic(agentId, taskId, date, epicId, appName)
      : this.getAppReportingSectionCreateEpic(agentId, taskId, date, appName);

    return `# Vibe Suite Application Health Check Agent

You are a **healthcheck agent** in the Vibe Suite multi-agent system. Your role is to perform a health check on the **${appName}** application, testing its functionality and looking for issues.

## Your Identity
- **Agent ID:** ${agentId}
- **Agent Type:** healthcheck
- **Time Limit:** 30 minutes
- **Date:** ${date}

## Task Information
- **Task ID:** ${taskId}
- **Title:** ${title}
${epicId ? `- **Epic ID:** ${epicId} (use this for all findings)` : ''}

## Application Information
- **Application:** ${appName}
- **URL:** ${url}
- **Project Path:** /home/claude/projects/${appName}

## Context
${description}

---

## Your Mission

Perform a health check on this specific application. Test its functionality, check for errors, and report any issues found.

---

## Phase 1: Service Health (~5 min)

Check the PM2 process and basic service health:

\`\`\`bash
# Check PM2 status for this app
pm2 show ${appName}

# Check memory usage and restarts
pm2 jlist | jq '.[] | select(.name == "${appName}") | {name, status: .pm2_env.status, memory: .monit.memory, restarts: .pm2_env.restart_time}'

# Check if port is responding (get port from PM2 or project config)
pm2 show ${appName} | grep -i port

# Check recent logs for errors
pm2 logs ${appName} --lines 50 --nostream 2>&1 | grep -i -E "(error|exception|failed|crash)" | tail -20
\`\`\`

**Look for:**
- Process not in "online" status
- High memory usage (> 500MB for most apps)
- Many restarts (> 5 in last 24h)
- Repeated errors in logs

---

## Phase 2: Application Testing with Playwright (~15 min)

Navigate to the application and test its functionality:

### Step 1: Initial Load

\`\`\`
Use browser_navigate to go to: ${url}
\`\`\`

### Step 2: Check for Console Errors

\`\`\`
Use browser_console_messages with level "error"
\`\`\`

### Step 3: Get Page Snapshot

\`\`\`
Use browser_snapshot to understand the page structure
\`\`\`

### Step 4: Test Main User Flows

Based on what you see in the snapshot:
1. Identify the main features/pages
2. Click through navigation items
3. Test any forms (try valid and invalid inputs)
4. Test interactive elements
5. Check that data loads correctly

### Step 5: Check Network Requests

\`\`\`
Use browser_network_requests to check for failed API calls
\`\`\`

### Things to Test

- **Page loads** - Does the main page render correctly?
- **Navigation** - Do all links work?
- **Data** - Does real data appear (not mock data)?
- **Forms** - Do forms validate and submit correctly?
- **Errors** - Are error states handled gracefully?
- **Responsive** - Use browser_resize to test mobile view

### Playwright MCP Tools Available

- \`browser_navigate\` - Navigate to a URL
- \`browser_snapshot\` - Get accessibility tree (best for understanding page)
- \`browser_click\` - Click an element by ref
- \`browser_type\` - Type text into an input
- \`browser_fill_form\` - Fill multiple form fields
- \`browser_take_screenshot\` - Capture visual state (for evidence)
- \`browser_console_messages\` - Check for JS errors
- \`browser_press_key\` - Press keyboard keys
- \`browser_select_option\` - Select dropdown options
- \`browser_wait_for\` - Wait for text or time
- \`browser_resize\` - Change viewport size
- \`browser_network_requests\` - Check network activity

---

## Phase 3: Data Inspection (~5 min)

If the app has a database or data files, inspect them:

\`\`\`bash
# Check if app has a database
ls -la /home/claude/data/${appName}* 2>/dev/null
ls -la /home/claude/projects/${appName}/data* 2>/dev/null
ls -la /home/claude/projects/${appName}/*.db 2>/dev/null

# Check project structure for data storage
ls -la /home/claude/projects/${appName}/

# Review recent logs for data-related issues
pm2 logs ${appName} --lines 100 --nostream 2>&1 | grep -i -E "(database|data|fetch|api)" | tail -20
\`\`\`

**Look for:**
- Database connection errors
- Failed API requests
- Data integrity issues
- Stale data (old timestamps)

---

${reportingSection}

---

## Investigation Freedom

If you notice something unusual during testing:
- Follow the thread and investigate
- Check the source code if behavior seems wrong
- Look at logs for clues
- Trust your instincts about "something doesn't look right"

---

## Begin Health Check

Start by checking the PM2 status for ${appName}. Then navigate to the application URL and begin testing.
`;
  }

  /**
   * Generate reporting section for app checks when epic ID is provided
   */
  private getAppReportingSectionWithEpic(agentId: string, taskId: string, date: string, epicId: string, appName: string): string {
    return `## Phase 4: Report Findings (~5 min)

### Step 1: Create Feature for This App

The nightly epic has already been created. Create a feature under it for your app findings:

\`\`\`bash
curl -X POST $VIBE_SUITE_API/api/agent/tasks \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-ID: ${agentId}" \\
  -d '{
    "title": "App: ${appName}",
    "description": "Health check for ${appName} application",
    "type": "feature",
    "parentId": "${epicId}",
    "repo": "${appName}"
  }'
\`\`\`

Save the returned feature ID for creating child items.

### Step 2: Report Individual Findings

For EACH issue found, create a task or bug:

\`\`\`bash
curl -X POST $VIBE_SUITE_API/api/agent/tasks \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-ID: ${agentId}" \\
  -d '{
    "title": "Brief issue title",
    "description": "## Problem\\n\\nDetailed description...\\n\\n## Steps to Reproduce\\n\\n1. ...\\n2. ...\\n\\n## Evidence\\n\\n[Screenshot or output]\\n\\n## Expected vs Actual\\n\\n...",
    "type": "bug",
    "parentId": "FEATURE_ID_HERE",
    "repo": "${appName}",
    "metadata": {
      "severity": "critical|high|medium|low",
      "category": "service|performance|security|data|ux"
    }
  }'
\`\`\`

### Severity Guide

- **critical** - App down, security issue, data loss
- **high** - Major feature broken, significant errors
- **medium** - Feature partially broken, minor bugs
- **low** - Cosmetic issues, minor improvements

### Categories

- **service** - PM2/process health
- **performance** - Slow loading, high resource usage
- **security** - Vulnerabilities, exposed data
- **data** - Data issues, API errors
- **ux** - User experience issues, confusing behavior

### Step 3: Post Summary Comment

Post a summary on the triggering task:

\`\`\`bash
curl -X POST $VIBE_SUITE_API/api/agent/tasks/${taskId}/comments \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-ID: ${agentId}" \\
  -d '{
    "content": "## App Health Check: ${appName}\\n\\n**Date:** ${date}\\n**Duration:** X minutes\\n\\n### Status\\n\\n[HEALTHY/DEGRADED/DOWN]\\n\\n### Service Health\\n\\n- PM2 Status: [online/stopped/errored]\\n- Memory: X MB\\n- Restarts: X\\n\\n### Functionality\\n\\n- Page loads: [OK/FAILED]\\n- Console errors: [None/X errors]\\n- API calls: [OK/FAILED]\\n\\n### Findings\\n\\n- Critical: X\\n- High: X\\n- Medium: X\\n- Low: X\\n\\n### Issues Found\\n\\n1. ...\\n2. ..."
  }'
\`\`\``;
  }

  /**
   * Generate reporting section for app checks when no epic ID (need to search/create)
   */
  private getAppReportingSectionCreateEpic(agentId: string, taskId: string, date: string, appName: string): string {
    return `## Phase 4: Report Findings (~5 min)

### Step 1: Find or Create the Nightly Epic

Search for today's nightly health check epic:

\`\`\`bash
curl -s "$VIBE_SUITE_API/api/agent/tasks/search?q=Nightly%20Health%20Check%20-%20${date}" \\
  -H "X-Agent-ID: ${agentId}"
\`\`\`

If it doesn't exist, create it:

\`\`\`bash
curl -X POST $VIBE_SUITE_API/api/agent/tasks \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-ID: ${agentId}" \\
  -d '{
    "title": "Nightly Health Check - ${date}",
    "description": "Automated nightly health check findings for ${date}",
    "type": "epic",
    "repo": "orchestrator"
  }'
\`\`\`

### Step 2: Create Feature for This App

Create a feature under the epic for your app findings:

\`\`\`bash
curl -X POST $VIBE_SUITE_API/api/agent/tasks \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-ID: ${agentId}" \\
  -d '{
    "title": "App: ${appName}",
    "description": "Health check for ${appName} application",
    "type": "feature",
    "parentId": "EPIC_ID_HERE",
    "repo": "${appName}"
  }'
\`\`\`

### Step 3: Report Individual Findings

For EACH issue found, create a task or bug:

\`\`\`bash
curl -X POST $VIBE_SUITE_API/api/agent/tasks \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-ID: ${agentId}" \\
  -d '{
    "title": "Brief issue title",
    "description": "## Problem\\n\\nDetailed description...\\n\\n## Steps to Reproduce\\n\\n1. ...\\n2. ...\\n\\n## Evidence\\n\\n[Screenshot or output]\\n\\n## Expected vs Actual\\n\\n...",
    "type": "bug",
    "parentId": "FEATURE_ID_HERE",
    "repo": "${appName}",
    "metadata": {
      "severity": "critical|high|medium|low",
      "category": "service|performance|security|data|ux"
    }
  }'
\`\`\`

### Severity Guide

- **critical** - App down, security issue, data loss
- **high** - Major feature broken, significant errors
- **medium** - Feature partially broken, minor bugs
- **low** - Cosmetic issues, minor improvements

### Categories

- **service** - PM2/process health
- **performance** - Slow loading, high resource usage
- **security** - Vulnerabilities, exposed data
- **data** - Data issues, API errors
- **ux** - User experience issues, confusing behavior

### Step 4: Post Summary Comment

Post a summary on the triggering task:

\`\`\`bash
curl -X POST $VIBE_SUITE_API/api/agent/tasks/${taskId}/comments \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-ID: ${agentId}" \\
  -d '{
    "content": "## App Health Check: ${appName}\\n\\n**Date:** ${date}\\n**Duration:** X minutes\\n\\n### Status\\n\\n[HEALTHY/DEGRADED/DOWN]\\n\\n### Service Health\\n\\n- PM2 Status: [online/stopped/errored]\\n- Memory: X MB\\n- Restarts: X\\n\\n### Functionality\\n\\n- Page loads: [OK/FAILED]\\n- Console errors: [None/X errors]\\n- API calls: [OK/FAILED]\\n\\n### Findings\\n\\n- Critical: X\\n- High: X\\n- Medium: X\\n- Low: X\\n\\n### Issues Found\\n\\n1. ...\\n2. ..."
  }'
\`\`\``;
  }

  /**
   * Main entry point for healthcheck prompts.
   * Determines whether this is a core infrastructure or app-specific check based on config.
   */
  getHealthcheckPrompt(config: CoreHealthcheckPromptConfig & { appName?: string; deploymentUrl?: string }): string {
    // If appName is provided and not a core service, use app-specific prompt
    const coreServices = ['orchestrator', 'vibe-suite', 'vibe-suite-staging', 'orchestrator-staging'];

    if (config.appName && !coreServices.includes(config.appName)) {
      return this.getAppHealthcheckPrompt({
        taskId: config.taskId,
        title: config.title,
        description: config.description,
        agentId: config.agentId,
        appName: config.appName,
        deploymentUrl: config.deploymentUrl,
      });
    }

    // Default to core infrastructure check
    return this.getCoreHealthcheckPrompt(config);
  }
}
