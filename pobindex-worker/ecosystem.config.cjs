/**
 * PM2 config for the POBINDEX worker.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs pobindex-loop
 *   pm2 stop pobindex-loop
 *
 * Two processes:
 *   - pobindex-loop  : long-running worker (claim, basket refresh, spend, discover)
 *   - pobindex-serve : HTTP server for the dashboard + /api/basket /api/health
 */

module.exports = {
  apps: [
    {
      name: 'pobindex-loop',
      script: 'scripts/run-loop.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      restart_delay: 5_000,
      kill_timeout: 30_000,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'pobindex-serve',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '256M',
      restart_delay: 3_000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
