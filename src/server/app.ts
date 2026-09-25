import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { serveStatic } from "@hono/node-server/serve-static";
import { ZodError } from "zod";
import { ForbiddenError, GenerationConflictError, NotFoundError, UnavailableError, type AppContext } from "../app/context.js";
import { UnsafeUrlError } from "../infra/net.js";
import { bodyLimit } from "hono/body-limit";
import { authMiddleware, sessionRoutes, TicketStore } from "./auth.js";
import type { Config } from "./config.js";
import { apiRoutes } from "./routes/api.js";
import { githubWebhook } from "./routes/webhooks.js";
import { githubAppCreated } from "./routes/github-app.js";
import { seoRoutes } from "./seo.js";

export function createApp(ctx: AppContext, config: Config) {
  const app = new Hono();
  const tickets = new TicketStore();
  app.get("/health", (c) => c.text("ok"));
  // GitHub webhook은 25MB까지 온다. 서명 검증이 있으므로 상한 앞에 둔다.
  app.post("/api/webhooks/github", githubWebhook(ctx));
  app.get("/api/github/app/created", githubAppCreated(ctx));
  // 나머지 API의 요청 본문 상한. 세션 요약 업로드·예시 가져오기도 이 안에 든다.
  app.use("/api/*", bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ error: "payload too large" }, 413) }));
  app.route("/api/session", sessionRoutes(config));
  app.use("/api/*", authMiddleware(config, tickets));
  app.route("/api", apiRoutes(ctx, config, tickets));
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    if (err instanceof HTTPException && err.status < 500) return c.json({ error: err.message }, err.status);
    if (err instanceof ZodError) return c.json({ error: "invalid request", issues: err.issues }, 400);
    if (err instanceof GenerationConflictError) return c.json({ error: err.message }, 409);
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ForbiddenError) return c.json({ error: err.message }, 403);
    if (err instanceof UnavailableError) return c.json({ error: err.message }, 503);
    if (err instanceof UnsafeUrlError) return c.json({ error: `unsafe URL: ${err.message}` }, 400);
    ctx.log.error({ err: err.message, path: c.req.path }, "unhandled");
    return c.json({ error: "internal server error" }, 500);
  });
  // 정적 웹 (빌드 결과). 첫 화면과 SPA 폴백은 검색용 머리말을 붙여 내려준다.
  const page = seoRoutes(app, config);
  app.get("/", (c) => c.html(page("/")));
  app.get("/index.html", (c) => c.redirect("/", 301));
  app.use("/*", serveStatic({ root: config.WEB_DIST }));
  app.get("/*", (c) => c.html(page(c.req.path)));
  return app;
}
