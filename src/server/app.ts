import { SharedQuotaError } from "../app/shared-quota.js";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { serveStatic } from "@hono/node-server/serve-static";
import { ZodError } from "zod";
import { ForbiddenError, GenerationConflictError, InvalidInputError, NotFoundError, UnavailableError, type AppContext } from "../app/context.js";
import { UnsafeUrlError } from "../infra/net.js";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { authMiddleware, sessionRoutes, TicketStore } from "./auth.js";
import type { Config } from "./config.js";
import { apiRoutes } from "./routes/api.js";
import { githubWebhook } from "./routes/webhooks.js";
import { githubAppCreated } from "./routes/github-app.js";
import { seoRoutes } from "./seo.js";

export function createApp(ctx: AppContext, config: Config) {
  const app = new Hono();
  const tickets = new TicketStore();
  // 기본 보안 헤더. 스크립트 출처는 막지 않고(인증 서버·CDN 자산), 다른 사이트에 끼워 넣기·MIME 추측·주소 노출만 막는다.
  // 공유 이미지(og.png)는 다른 사이트가 불러가야 하므로 교차 출처 리소스 정책을 걸지 않는다.
  app.use("*", secureHeaders({
    strictTransportSecurity: "max-age=31536000; includeSubDomains",
    xFrameOptions: "DENY",
    referrerPolicy: false,
    contentSecurityPolicy: { frameAncestors: ["'none'"], baseUri: ["'self'"], objectSrc: ["'none'"] },
    crossOriginResourcePolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));
  // 주소 노출 정책은 응답이 정하지 않았을 때만(GitHub App 콜백은 no-referrer로 code·state를 지킨다).
  app.use("*", async (c, next) => {
    await next();
    if (!c.res.headers.has("Referrer-Policy")) c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  });
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
    if (err instanceof SharedQuotaError) { c.header("Retry-After", String(Math.max(1, Math.ceil((err.retryAt - Date.now()) / 1000)))); return c.json({ error: err.message, retryAt: err.retryAt }, 429); }
    if (err instanceof GenerationConflictError) return c.json({ error: err.message }, 409);
    if (err instanceof InvalidInputError) return c.json({ error: err.message }, 400);
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ForbiddenError) return c.json({ error: err.message }, 403);
    if (err instanceof UnavailableError) return c.json({ error: err.message }, 503);
    if (err instanceof UnsafeUrlError) return c.json({ error: `unsafe URL: ${err.message}` }, 400);
    ctx.log.error({ err: err.message, path: c.req.path }, "unhandled");
    return c.json({ error: "internal server error" }, 500);
  });
  // 정적 웹 (빌드 결과). 첫 화면과 SPA 폴백은 검색용 머리말을 붙여 내려준다.
  const page = seoRoutes(app, config);
  const html = (c: Context) => {
    const res = page(c.req.path, c.req.header("Accept-Language"));
    if (res === undefined) return c.notFound();
    c.header("Vary", "Accept-Language");
    return c.html(res.body, res.status);
  };
  app.get("/", html);
  app.get("/index.html", (c) => c.redirect("/", 301));
  app.use("/*", serveStatic({ root: config.WEB_DIST }));
  app.get("/*", html);
  return app;
}
