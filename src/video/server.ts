import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { sameSecret } from "../server/auth.js";
import { VIDEO_ASPECTS, VIDEO_DURATIONS } from "../shared/video.js";
import type { BridgeRegistry } from "./bridges.js";
import { handleMcp } from "./mcp.js";
import { MAX_SCENE_BYTES, VideoError, type VideoService } from "./service.js";

/**
 * 영상 서버 HTTP. 세 종류의 호출자가 각자 다른 토큰을 쓴다.
 *  - somun 서버:  /v1/renders*          서비스 토큰(VIDEO_SERVICE_TOKEN)
 *  - 로컬 bridge: /v1/sessions/next     bridge 토큰(VIDEO_BRIDGE_TOKENS 또는 somun이 발급해 해시를 등록한 것)
 *  - 연출 모델:   /mcp, 세션 종료        세션 토큰(렌더 하나에만 유효)
 */
export type VideoServerConfig = { serviceToken: string; bridges: BridgeRegistry };

/** "token" 또는 "owner=token,owner2=token2". 소유자 없이 쓴 토큰은 모든 렌더를 가져간다(단일 사용자). */
export function parseBridgeTokens(raw: string): { owner: string; token: string }[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.lastIndexOf("=");
    return i > 0 ? { owner: s.slice(0, i), token: s.slice(i + 1) } : { owner: "*", token: s };
  });
}

const briefSchema = z.object({
  project: z.string().min(1).max(120),
  repoUrl: z.string().max(300),
  lang: z.string().min(2).max(8),
  durationSec: z.union(VIDEO_DURATIONS.map((d) => z.literal(d)) as [z.ZodLiteral<10>, z.ZodLiteral<15>, z.ZodLiteral<20>]),
  aspect: z.enum(VIDEO_ASPECTS),
  headline: z.string().max(300),
  facts: z.string().max(40_000),
  grounding: z.string().max(400_000),
  script: z.string().max(3_000).optional(),
  voice: z.string().max(4_000),
  bannedPhrases: z.array(z.string().max(80)).max(200),
  // 남의 페이지에서 온 값이라 모양을 좁게 제한한다: 색은 #rrggbb, 글꼴은 영문·숫자·공백.
  brand: z.object({
    accents: z.array(z.string().regex(/^#[0-9a-f]{6}$/)).max(3),
    background: z.string().regex(/^#[0-9a-f]{6}$/).optional(),
    ink: z.string().regex(/^#[0-9a-f]{6}$/).optional(),
    fonts: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ]{0,39}$/)).max(3),
    source: z.string().url().max(300),
  }).optional(),
});

const bearer = (c: Context) => { const h = c.req.header("authorization") ?? ""; return h.startsWith("Bearer ") ? h.slice(7) : ""; };
const LONG_POLL_MAX_SEC = 25;

export function videoServer(service: VideoService, config: VideoServerConfig) {
  const app = new Hono();
  const fail = (c: Context, err: unknown) => {
    if (err instanceof VideoError) return c.json({ error: err.message }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: "invalid request", issues: err.issues.slice(0, 5) }, 400);
    throw err;
  };
  app.onError((err, c) => fail(c, err));

  app.get("/healthz", (c) => c.json({ ok: true }));

  // somun → 렌더 요청·조회·영상
  const service_ = new Hono();
  service_.use(async (c, next) => (sameSecret(bearer(c), config.serviceToken) ? next() : c.json({ error: "unauthorized" }, 401)));
  service_.post("/", bodyLimit({ maxSize: 1_000_000 }), async (c) => {
    const input = z.object({ owner: z.string().min(1).max(300), brief: briefSchema }).parse(await c.req.json());
    return c.json(service.create(input.owner, input.brief), 201);
  });
  service_.get("/:id", (c) => c.json(service.get(c.req.param("id"))));
  service_.get("/:id/video", (c) => sendFile(c, service.video(c.req.param("id"))));
  service_.delete("/:id", (c) => { service.remove(c.req.param("id")); return c.body(null, 204); });
  app.route("/v1/renders", service_);

  // somun → 사용자별 bridge 토큰(해시) 등록과 연결 상태
  const tokens = new Hono();
  tokens.use(async (c, next) => (sameSecret(bearer(c), config.serviceToken) ? next() : c.json({ error: "unauthorized" }, 401)));
  tokens.put("/", bodyLimit({ maxSize: 1_000_000 }), async (c) => {
    const input = z.object({ tokens: z.array(z.object({ id: z.string().min(1).max(64), owner: z.string().min(1).max(300), tokenHash: z.string().regex(/^[a-f0-9]{64}$/) })).max(10_000) }).parse(await c.req.json());
    config.bridges.replace(input.tokens);
    return c.body(null, 204);
  });
  tokens.get("/", (c) => c.json(config.bridges.status(c.req.query("owner") || undefined)));
  app.route("/v1/bridge-tokens", tokens);

  // bridge → 다음 세션(롱 폴링). 없으면 204.
  app.get("/v1/sessions/next", async (c) => {
    const who = config.bridges.authenticate(bearer(c));
    if (!who) return c.json({ error: "unauthorized" }, 401);
    const bridge = (c.req.query("bridge") ?? "bridge").slice(0, 120);
    const wait = Math.min(LONG_POLL_MAX_SEC, Math.max(0, Number(c.req.query("wait") ?? 0) || 0));
    const until = Date.now() + wait * 1000;
    for (;;) {
      // 연결이 끊긴 bridge에게 렌더를 넘기지 않는다(넘기면 세션 시간이 다 갈 때까지 멈춰 있다).
      if (c.req.raw.signal.aborted) return c.body(null, 204);
      const ticket = service.claim(who.owner, bridge);
      if (ticket) return c.json(ticket);
      if (Date.now() >= until) return c.body(null, 204);
      await new Promise((r) => setTimeout(r, 1000));
    }
  });
  app.post("/v1/sessions/finish", async (c) => {
    const input = z.object({ note: z.string().max(4000).optional(), error: z.string().max(4000).optional(), model: z.string().max(100).optional(), costUsd: z.number().optional(), durationMs: z.number().optional() }).parse(await c.req.json());
    return c.json(service.finish(bearer(c), input));
  });

  // 연출 모델의 도구
  app.post("/mcp", bodyLimit({ maxSize: MAX_SCENE_BYTES * 2 }), async (c) => {
    const token = bearer(c);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400); }
    const out = await handleMcp(service, token, body);
    return out === null ? c.body(null, 202) : c.json(out);
  });
  // 서버가 먼저 보내는 스트림은 쓰지 않는다.
  app.on(["GET", "DELETE"], "/mcp", (c) => c.body(null, 405));

  return app;
}

/** MP4 전송. 브라우저가 앞뒤로 옮겨 볼 수 있게 Range를 받는다. */
function sendFile(c: Context, file: string): Response {
  const size = statSync(file).size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
  const headers: Record<string, string> = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" };
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    const stream = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
    return new Response(stream, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) } });
  }
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers: { ...headers, "Content-Length": String(size) } });
}
