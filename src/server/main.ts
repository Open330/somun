import { serve } from "@hono/node-server";
import { EventEmitter } from "node:events";
import type { AppContext } from "../app/context.js";
import { startScheduler } from "../app/scheduler.js";
import { openDb } from "../infra/db/index.js";
import { logger } from "../infra/logger.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const ctx: AppContext = { db: openDb(config.dbFile), log: logger, env: { githubToken: config.GITHUB_TOKEN, geminiKeys: config.GEMINI_API_KEYS }, bus: new EventEmitter() };
ctx.bus.setMaxListeners(100);

const cron = startScheduler(ctx, config.CRON);
const app = createApp(ctx, config);
const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  logger.info({ port: info.port, db: config.dbFile, cron: config.CRON, auth: config.anonymous ? "anonymous" : config.SOMUN_TOKEN ? "token" : "jwt" }, "somun up");
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    cron.stop();
    server.close(() => process.exit(0));
  });
}
