module.exports = {
  apps: [
    {
      name: 'GenieAI',
      script: './src/index.ts',
      interpreter: 'bun',
      interpreter_args: '--preload ./src/infrastructure/instrumentation/sentry/instrumentation.ts',
      max_restarts: 10,
      exp_backoff_restart_delay: 100,
      min_uptime: "15s",
      shutdown_with_message: true, // Windows only flag: process.platform === "win32"?
      env: {
        LOG_LEVEL: "debug",
        NODE_ENV: "production",
      },
    }
  ]
};