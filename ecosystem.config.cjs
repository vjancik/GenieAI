// There seems to be a bug in latest PM2 version when running Bun processes that causes larger than normal CPU usage
module.exports = {
    apps: [
        {
            name: "GenieAI",
            script: "./src/index.ts",
            interpreter: "bun",
            interpreter_args: "--preload ./src/infrastructure/instrumentation/sentry/instrumentation.ts",
            max_restarts: 10,
            exp_backoff_restart_delay: 100,
            min_uptime: "15s",
            kill_timeout: 120000,
            env: {
                LOG_LEVEL: "debug",
                NODE_ENV: "production",
            },
        },
    ],
};
