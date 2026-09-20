import { serve } from "@hono/node-server";
import { EventEmitter } from "node:events";
import type { AppContext } from "../app/context.js";
import { startScheduler } from "../app/scheduler.js";
import { openDb } from "../infra/db/index.js";
import { logger } from "../infra/logger.js";
import { UsageReporter } from "../infra/usage.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const db = openDb(config.dbFile);
const usage = new UsageReporter(db, logger, { apiUrl: config.JIUN_API_URL, serviceId: config.JIUN_USAGE_SERVICE_ID, serviceKey: config.JIUN_USAGE_KEY });
const ctx: AppContext = { db, log: logger, env: { githubToken: config.GITHUB_TOKEN, geminiKeys: config.GEMINI_API_KEYS }, bus: new EventEmitter(), usage };
// 못 보낸 사용량은 5분마다 다시 보낸다.
const usageFlush = setInterval(() => void usage.flush(), 5 * 60_000);
ctx.bus.setMaxListeners(100);

const cron = startScheduler(ctx, config.CRON);
const app = createApp(ctx, config);
const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  logger.info({ port: info.port, db: config.dbFile, cron: config.CRON, auth: config.anonymous ? "anonymous" : config.SOMUN_TOKEN ? "token" : "jwt" }, "somun up");
logger.info({ usage: usage.enabled ? "on" : "off (JIUN_USAGE_KEY unset)" }, "usage reporting");
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    cron.stop();
    clearInterval(usageFlush);
    void usage.flush().finally(() => server.close(() => process.exit(0)));
  });
}
