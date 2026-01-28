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
      },
    },
  ],
};
