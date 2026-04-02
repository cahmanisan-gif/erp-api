module.exports = {
  apps: [{
    name: 'rajavavapor-api',
    script: './server.js',
    cwd: '/var/www/rajavavapor/backend',
    instances: 4,
    exec_mode: 'cluster',
    max_memory_restart: '512M',
    // Graceful restart
    listen_timeout: 5000,
    kill_timeout: 3000,
    // Auto restart on crash
    autorestart: true,
    max_restarts: 10,
    restart_delay: 1000,
    // Log
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
