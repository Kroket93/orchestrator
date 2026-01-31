/**
 * PM2 Ecosystem Configuration for Orchestrator
 *
 * Environments:
 *   Production: orchestrator (port 3020)
 *   Staging: orchestrator-staging (port 3021)
 *
 * Data Isolation:
 *   Production DB: /home/claude/data/orchestrator.db
 *   Staging DB: /home/claude/data/orchestrator-staging/orchestrator.db
 *   Production events: /home/claude/data/orchestrator-events
 *   Staging events: /home/claude/data/orchestrator-staging/events
 */

// Get GitHub token from gh CLI
const { execSync } = require('child_process');
let GITHUB_TOKEN = '';
try {
  GITHUB_TOKEN = execSync('gh auth token', { encoding: 'utf8' }).trim();
} catch (e) {
  console.warn('Warning: Could not get GitHub token from gh CLI.');
}

module.exports = {
  apps: [
    {
      name: 'orchestrator',
      script: './dist/main.js',
      cwd: '/home/claude/projects/orchestrator',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3020,
        DATABASE_PATH: '/home/claude/data/orchestrator.db',
        EVENT_DIR: '/home/claude/data/orchestrator-events',
        WORKSPACES_DIR: '/home/claude/agent-workspaces',
        GITHUB_TOKEN,
      },
    },
    {
      name: 'orchestrator-staging',
      script: './dist/main.js',
      cwd: '/home/claude/projects/orchestrator',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'staging',
        PORT: 3021,
        DATABASE_PATH: '/home/claude/data/orchestrator-staging/orchestrator.db',
        EVENT_DIR: '/home/claude/data/orchestrator-staging/events',
        WORKSPACES_DIR: '/home/claude/agent-workspaces-staging',
        GITHUB_TOKEN,
      },
    },
  ],
};
