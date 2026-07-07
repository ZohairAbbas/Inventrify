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
  ],
};
