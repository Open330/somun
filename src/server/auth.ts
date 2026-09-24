import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Config } from "./config.js";

/**
 * 인증 미들웨어. 세 모드:
 *  - anonymous: 로컬 개발. ownerId "local".
 *  - token: SOMUN_TOKEN 하나로 단일 사용자. ownerId는 SOMUN_TOKEN_OWNER_ID 또는 "local".
 *    스크립트·워커는 Bearer 헤더, 브라우저는 토큰을 한 번 내고 받은 세션 쿠키(HttpOnly)로 인증한다(토큰을 브라우저 저장소에 두지 않는다).
 *  - jwt: jiun-api 등 외부 발급자의 RS256 JWT (JWKS). ownerId = sub 또는 tokenIdentifier.
 * 세 모드는 동시에 켜질 수 있고, 어느 하나만 통과하면 된다.
 *
 * SSE(EventSource)는 헤더를 못 붙이므로 /api/events 만 1회용 티켓(?ticket=)을 받는다. 토큰·JWT를 주소에 넣지 않는다.
 */
export type AuthMethod = "token" | "jwt" | "anonymous";
export type AuthVars = { ownerId: string; authMethod: AuthMethod };

export const SESSION_COOKIE = "somun_session";
const SESSION_TTL_S = 30 * 86_400;
const TICKET_TTL_MS = 60_000;

/** 길이가 달라도 시간 차이로 새지 않게 비교한다. */
export function sameSecret(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest(), hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** SSE 1회용 티켓. 발급 뒤 60초 안에 한 번만 쓸 수 있다. 프로세스 메모리에 둔다(단일 인스턴스 배포). */
export class TicketStore {
  private readonly tickets = new Map<string, { ownerId: string; method: AuthMethod; exp: number }>();
  issue(ownerId: string, method: AuthMethod, now = Date.now()): string {
    for (const [k, v] of this.tickets) if (v.exp < now) this.tickets.delete(k);
    const ticket = randomBytes(24).toString("base64url");
    this.tickets.set(ticket, { ownerId, method, exp: now + TICKET_TTL_MS });
    return ticket;
  }
  consume(ticket: string, now = Date.now()): { ownerId: string; method: AuthMethod } | undefined {
    const t = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return t && t.exp >= now ? t : undefined;
  }
}

/** 세션 쿠키 서명 키. SOMUN_TOKEN에서 만든다: 토큰을 바꾸면 기존 세션이 모두 끊긴다. */
const sessionKey = (token: string) => createHash("sha256").update(`somun-session:${token}`).digest();

/**
 * 세션 값: 만료 시각 + 서명. 소유자는 담지 않는다(토큰 모드의 소유자는 설정 SOMUN_TOKEN_OWNER_ID 하나이므로,
 * 그 값을 바꾸면 기존 세션도 바로 새 소유자로 인증된다). 토큰을 바꾸면 서명 키가 바뀌어 모든 세션이 끊긴다.
 */
export function signSession(token: string, now = Date.now()): string {
  const exp = String(Math.floor(now / 1000) + SESSION_TTL_S);
  return `${exp}.${createHmac("sha256", sessionKey(token)).update(exp).digest("base64url")}`;
}

export function verifySession(token: string, value: string, now = Date.now()): boolean {
  const [exp, sig] = value.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  const expected = createHmac("sha256", sessionKey(token)).update(exp).digest("base64url");
  return sameSecret(sig, expected) && Number(exp) * 1000 >= now;
}

/** 쿠키로 인증한 변경 요청은 같은 출처에서 온 것만 받는다(SameSite=Strict에 더한 한 겹). */
function sameOrigin(c: Context): boolean {
  const origin = c.req.header("origin");
  if (!origin) return true;
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
  try { return new URL(origin).host === host; } catch { return false; }
}

const secureRequest = (c: Context, config: Config) => c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:" || Boolean(config.SOMUN_PUBLIC_URL?.startsWith("https:"));

export function authMiddleware(config: Config, tickets?: TicketStore): MiddlewareHandler<{ Variables: AuthVars }> {
  const jwks = config.AUTH_JWKS_URL ? createRemoteJWKSet(new URL(config.AUTH_JWKS_URL)) : null;
  const tokenOwner = config.SOMUN_TOKEN_OWNER_ID || "local";
  return async (c, next) => {
    const pass = (ownerId: string, method: AuthMethod) => { c.set("ownerId", ownerId); c.set("authMethod", method); return next(); };
    if (c.req.path.endsWith("/api/events") && tickets) {
      const ticket = c.req.query("ticket");
      const t = ticket ? tickets.consume(ticket) : undefined;
      if (t) return pass(t.ownerId, t.method);
    }
    const header = c.req.header("authorization") ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (bearer && config.SOMUN_TOKEN && sameSecret(bearer, config.SOMUN_TOKEN)) return pass(tokenOwner, "token");
    if (bearer && jwks) {
      try {
        const { payload } = await jwtVerify(bearer, jwks, { issuer: config.AUTH_ISSUER, audience: config.AUTH_AUDIENCE });
        const id = String(payload.sub ?? "");
        if (id) return pass(`${config.AUTH_ISSUER ?? "jwt"}|${id}`, "jwt");
      } catch {
        /* 아래 판정으로 */
      }
    }
    const session = config.SOMUN_TOKEN ? getCookie(c, SESSION_COOKIE) : undefined;
    if (session && config.SOMUN_TOKEN) {
      if (verifySession(config.SOMUN_TOKEN, session) && (["GET", "HEAD"].includes(c.req.method) || sameOrigin(c))) return pass(tokenOwner, "token");
    }
    if (config.anonymous) return pass("local", "anonymous");
    return c.json({ error: "unauthorized" }, 401);
  };
}

/** 토큰 모드 브라우저 로그인: 토큰을 한 번 내면 세션 쿠키를 준다. 인증 미들웨어 앞에 둔다. */
export function sessionRoutes(config: Config) {
  const app = new Hono();
  app.post("/", async (c) => {
    const { token } = (await c.req.json().catch(() => ({}))) as { token?: unknown };
    if (!config.SOMUN_TOKEN || typeof token !== "string" || !sameSecret(token.trim(), config.SOMUN_TOKEN) || !sameOrigin(c)) return c.json({ error: "unauthorized" }, 401);
    const ownerId = config.SOMUN_TOKEN_OWNER_ID || "local";
    setCookie(c, SESSION_COOKIE, signSession(config.SOMUN_TOKEN), { httpOnly: true, sameSite: "Strict", secure: secureRequest(c, config), path: "/", maxAge: SESSION_TTL_S });
    return c.json({ ownerId });
  });
  app.delete("/", (c) => { deleteCookie(c, SESSION_COOKIE, { path: "/" }); return c.body(null, 204); });
  return app;
}
