// PM2 — POB Index UI + API (Express serves Vite dist + /api/pobindex).
// Rewards cycle is a one-shot script — schedule with cron (see deploy/DEPLOY.md).
//
//   pm2 start pobindex-worker/deploy/ecosystem.config.js --env production
//   pm2 save && pm2 startup

const path = require('path');
const root = path.join(__dirname, '..', '..');
const workerRoot = path.join(root, 'pobindex-worker');

module.exports = {
  apps: [
    {
      name: 'pobindex-serve',
      script: 'src/server.js',
      cwd: workerRoot,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env_production: {
        NODE_ENV: 'production',
        POBINDEX_SERVER_PORT: '3050',
        LISTEN_HOST: '127.0.0.1',
        LOG_LEVEL: 'info',
      },
      error_file: path.join(workerRoot, 'logs', 'pobindex-serve-error.log'),
      out_file: path.join(workerRoot, 'logs', 'pobindex-serve-out.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
