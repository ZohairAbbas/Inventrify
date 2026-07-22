module.exports = {
  apps: [
    {
      name: "inventorify",
      script: "/root/inventorify/start.sh",
      cwd: "/root/inventorify",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        PORT: 3016,
      },
      error_file: "/root/inventorify/logs/err.log",
      out_file: "/root/inventorify/logs/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
    {
      name: "inventorify-cron",
      script: "/root/inventorify/cron-start.sh",
      cwd: "/root/inventorify",
      instances: 1, // CRITICAL: only 1 instance, to prevent duplicate job runs
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "production",
        // CRON_SECRET is sourced from .env by cron-start.sh — never hardcode it here.
        CRON_BASE_URL: "http://localhost:3016",
      },
      error_file: "/root/inventorify/logs/cron-err.log",
      out_file: "/root/inventorify/logs/cron-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
  ],
};
