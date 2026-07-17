module.exports = {
  apps: [
    {
      name: 'football-streaming',
      script: 'src/index.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Yangon',
      },
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      merge_logs: true,
      time: true,
      kill_timeout: 15000,
      listen_timeout: 10000,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
    },
  ],
};
