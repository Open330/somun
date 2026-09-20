import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { ZodError } from "zod";
import { NotFoundError, type AppContext } from "../app/context.js";
import { authMiddleware } from "./auth.js";
import type { Config } from "./config.js";
import { apiRoutes } from "./routes/api.js";
import { githubAppCreated, githubWebhook } from "./routes/webhooks.js";

export function createApp(ctx: AppContext, config: Config) {
  const app = new Hono();
  app.get("/health", (c) => c.text("ok"));
  app.post("/api/webhooks/github", githubWebhook(ctx));
  app.get("/api/github/app/created", githubAppCreated(ctx));
  app.use("/api/*", authMiddleware(config));
  app.route("/api", apiRoutes(ctx));
  app.onError((err, c) => {
    if (err instanceof ZodError) return c.json({ error: "invalid request", issues: err.issues }, 400);
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    ctx.log.error({ err: err.message, path: c.req.path }, "unhandled");
    return c.json({ error: err.message }, 500);
  });
  // 정적 웹 (빌드 결과). SPA 폴백.
  app.use("/*", serveStatic({ root: config.WEB_DIST }));
  app.get("/*", serveStatic({ root: config.WEB_DIST, path: "index.html" }));
  return app;
}
