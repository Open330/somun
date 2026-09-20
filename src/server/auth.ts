import { createRemoteJWKSet, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import type { Config } from "./config.js";

/**
 * 인증 미들웨어. 세 모드:
 *  - anonymous: 로컬 개발. ownerId "local".
 *  - token: SOMUN_TOKEN 하나로 단일 사용자. ownerId "local".
 *  - jwt: jiun-api 등 외부 발급자의 RS256 JWT (JWKS). ownerId = sub 또는 tokenIdentifier.
 * 세 모드는 동시에 켜질 수 있고, 어느 하나만 통과하면 된다.
 */
export type AuthVars = { ownerId: string };

export function authMiddleware(config: Config): MiddlewareHandler<{ Variables: AuthVars }> {
  const jwks = config.AUTH_JWKS_URL ? createRemoteJWKSet(new URL(config.AUTH_JWKS_URL)) : null;
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (bearer && config.SOMUN_TOKEN && bearer === config.SOMUN_TOKEN) {
      c.set("ownerId", "local");
      return next();
    }
    if (bearer && jwks) {
      try {
        const { payload } = await jwtVerify(bearer, jwks, { issuer: config.AUTH_ISSUER, audience: config.AUTH_AUDIENCE });
        const id = String(payload.sub ?? "");
        if (id) {
          c.set("ownerId", `${config.AUTH_ISSUER ?? "jwt"}|${id}`);
          return next();
        }
      } catch {
        /* 아래 익명 판정으로 */
      }
    }
    if (config.anonymous) {
      c.set("ownerId", "local");
      return next();
    }
    return c.json({ error: "unauthorized" }, 401);
  };
}
