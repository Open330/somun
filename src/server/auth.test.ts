import { createServer } from "node:http";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, it } from "vitest";
import { authMiddleware, type AuthVars } from "./auth.js";
import { loadConfig } from "./config.js";

it("checks JWT expiry, audience and issuer while limiting query tokens to SSE", async () => {
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
    expect((await app.request(`/api/me?token=${valid}`)).status).toBe(401);
    expect((await app.request(`/api/events?token=${valid}`)).status).toBe(200);
    expect((await app.request(`/api/events?token=${await sign("somun", "-1m")}`)).status).toBe(401);
  } finally { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); }
}, 20_000);
