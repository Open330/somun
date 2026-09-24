import { createServer } from "node:http";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { authMiddleware, sessionRoutes, signSession, TicketStore, verifySession, type AuthVars } from "./auth.js";
import { loadConfig } from "./config.js";

it("checks JWT expiry, audience and issuer and never accepts credentials in the URL", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "RS256" };
  const server = createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  const issuer = `http://127.0.0.1:${address.port}`;
  try {
    const app = new Hono<{ Variables: AuthVars }>();
    app.use("/api/*", authMiddleware(loadConfig({ AUTH_ISSUER: issuer, AUTH_JWKS_URL: `${issuer}/jwks`, AUTH_AUDIENCE: "somun" })));
    app.get("/api/me", (c) => c.json({ ownerId: c.get("ownerId") }));
    app.get("/api/events", (c) => c.json({ ownerId: c.get("ownerId") }));
    const sign = (audience = "somun", expires = "5m", iss = issuer) => new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "test-key" }).setSubject("user").setIssuer(iss).setAudience(audience).setExpirationTime(expires).sign(privateKey);
    const valid = await sign();
    expect(await (await app.request("/api/me", { headers: { Authorization: `Bearer ${valid}` } })).json()).toEqual({ ownerId: `${issuer}|user` });
    for (const token of [await sign("other"), await sign("somun", "-1m"), await sign("somun", "5m", "https://wrong.test")]) {
      expect((await app.request("/api/me", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    }
    // 토큰·JWT를 주소로 받지 않는다. SSE도 1회용 티켓만.
    expect((await app.request(`/api/me?token=${valid}`)).status).toBe(401);
    expect((await app.request(`/api/events?token=${valid}`)).status).toBe(401);
  } finally { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); }
}, 20_000);

describe("browser sessions and SSE tickets", () => {
  const config = () => loadConfig({ SOMUN_TOKEN: "operator-token-123", SOMUN_TOKEN_OWNER_ID: "op" });
  const build = () => {
    const tickets = new TicketStore();
    const app = new Hono<{ Variables: AuthVars }>();
    app.route("/api/session", sessionRoutes(config()));
    app.use("/api/*", authMiddleware(config(), tickets));
    app.get("/api/me", (c) => c.json({ ownerId: c.get("ownerId") }));
    app.post("/api/change", (c) => c.json({ ok: true }));
    app.post("/api/events/ticket", (c) => c.json({ ticket: tickets.issue(c.get("ownerId"), c.get("authMethod")) }));
    app.get("/api/events", (c) => c.json({ ownerId: c.get("ownerId") }));
    return app;
  };

  it("exchanges the token once for an HttpOnly SameSite=Strict cookie that authenticates later requests", async () => {
    const app = build();
    expect((await app.request("/api/session", { method: "POST", body: JSON.stringify({ token: "wrong" }) })).status).toBe(401);
    const res = await app.request("/api/session", { method: "POST", body: JSON.stringify({ token: "operator-token-123" }) });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/somun_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const session = cookie.split(";")[0];
    expect(await (await app.request("/api/me", { headers: { Cookie: session } })).json()).toEqual({ ownerId: "op" });
    // 다른 출처에서 온 변경 요청은 쿠키만으로 통과하지 않는다.
    expect((await app.request("/api/change", { method: "POST", headers: { Cookie: session, Origin: "https://evil.example", Host: "somun.test" } })).status).toBe(401);
    expect((await app.request("/api/change", { method: "POST", headers: { Cookie: session, Origin: "https://somun.test", Host: "somun.test" } })).status).toBe(200);
    // 서명이 틀리거나 토큰이 바뀐 서버의 쿠키는 거부된다.
    expect((await app.request("/api/me", { headers: { Cookie: session.replace(/.$/, "x") } })).status).toBe(401);
    expect(verifySession("rotated-token", session.split("=")[1])).toBeUndefined();
  });

  it("lets SSE connect with a single-use ticket instead of a token in the URL", async () => {
    const app = build();
    const { ticket } = await (await app.request("/api/events/ticket", { method: "POST", headers: { Authorization: "Bearer operator-token-123" } })).json() as { ticket: string };
    expect(await (await app.request(`/api/events?ticket=${ticket}`)).json()).toEqual({ ownerId: "op" });
    expect((await app.request(`/api/events?ticket=${ticket}`)).status).toBe(401);
    expect((await app.request("/api/me?ticket=" + ticket)).status).toBe(401);
  });

  it("expires tickets after a minute", () => {
    const store = new TicketStore();
    const t = store.issue("op", "token", 0);
    expect(store.consume(t, 61_000)).toBeUndefined();
    expect(signSession("tok", "op", 0)).not.toBe(signSession("tok", "op", 1000));
  });
});
