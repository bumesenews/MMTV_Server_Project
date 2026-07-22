module.exports = {
  apps: [
    {
      name: 'football-streaming',
      script: 'src/index.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      // Watch Node RSS only — Chromium is separate. Keep Node small on 1GB hosts.
      max_memory_restart: '450M',
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Yangon',
        HOST: '0.0.0.0',
        PORT: 3000,
        LOW_MEMORY_MODE: 'true',
        // Cap V8 heap so Node cannot crowd out Chromium / the OS
        NODE_OPTIONS: '--max-old-space-size=256',
        BROWSER_RESTART_EVERY_N_PAGES: '8',
        PUPPETEER_TIMEOUT_MS: '35000',
        PUPPETEER_BLOCK_RESOURCES: 'true',
        HIGHLIGHT_LIMIT: '12',
        MAX_STREAM_RETRIES: '2',
        SOCO_CONCURRENCY: '2',
        MYANMARTV_CONCURRENCY: '2',
      },
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      merge_logs: true,
      time: true,
      kill_timeout: 20000,
      listen_timeout: 10000,
      autorestart: true,
      max_restarts: 30,
      restart_delay: 8000,
    },
  ],
};
