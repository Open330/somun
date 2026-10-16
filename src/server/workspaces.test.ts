import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import pino from "pino";
import { expect, it } from "vitest";
import type { AppContext } from "../app/context.js";
import { openDb, schema } from "../infra/db/index.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { enqueueJob } from "../app/pipeline.js";
import type { AccountWorkspaces } from "../shared/workspaces.js";

it("allows verified workspace switching, scoped reads/writes/jobs/tickets/deletion and rejects unsigned owners", async () => {
  const ctx: AppContext = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: {} as AppContext["usage"] };
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "workspace-test", alg: "RS256" };
  const server = createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no test server");
  const issuer = `http://127.0.0.1:${address.port}`;
  const primary = `${issuer}|current`, legacy = `${issuer}|old`;
  try {
    const app = createApp(ctx, loadConfig({ AUTH_ISSUER: issuer, AUTH_JWKS_URL: issuer, AUTH_AUDIENCE: "somun" }));
    const sign = (claims: Record<string, unknown> = {}) => new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "workspace-test" }).setSubject("current").setIssuer(issuer).setAudience("somun").setExpirationTime("5m").sign(privateKey);
    const jwt = await sign({ legacy_subs: ["old"] });
    const request = (path: string, owner?: string, method = "GET", body?: unknown, accessJwt = jwt) => app.request(`/api${path}`, { method, headers: { Authorization: `Bearer ${accessJwt}`, "Content-Type": "application/json", ...(owner ? { "X-Somun-Workspace": owner } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const ids: number[] = [];
    for (const [ownerId, label] of [[primary, "primary"], [legacy, "legacy"]]) {
      ctx.db.insert(schema.settings).values({ ownerId, data: { bannedPhrases: [label], llm: { provider: "local-agent" } }, updatedAt: 1 }).run();
      ids.push(Number(ctx.db.insert(schema.candidates).values({ ownerId, type: "release", title: label, repo: "me/test", key: label, evidence: {}, createdAt: 1, updatedAt: 1 }).run().lastInsertRowid));
    }
    const me = await request("/me");
    expect(me.status).toBe(200);
    expect(me.headers.get("cache-control")).toBe("private, no-store");
    expect(me.headers.get("vary")).toContain("X-Somun-Workspace");
    expect((await me.json() as AccountWorkspaces).ownerId).toBe(legacy);
    for (const [owner, phrase, ownId, otherId] of [[primary, "primary", ids[0], ids[1]], [legacy, "legacy", ids[1], ids[0]]] as const) {
      expect((await (await request("/me", owner)).json()).ownerId).toBe(owner);
      expect((await (await request("/settings", owner)).json()).bannedPhrases).toEqual([phrase]);
      expect((await request(`/candidates/${ownId}`, owner)).status).toBe(200);
      expect((await request(`/candidates/${otherId}`, owner)).status).toBe(404);
      const exported = await (await request("/account/export", owner)).json();
      expect(exported.candidates.map((item: { ownerId: string }) => item.ownerId)).toEqual([owner]);
    }
    expect((await request("/settings", primary, "PATCH", { bannedPhrases: ["changed"] })).status).toBe(200);
    expect((await (await request("/settings", legacy)).json()).bannedPhrases).toEqual(["legacy"]);
    for (const owner of [`${issuer}|stranger`, "https://evil.example|old", "old"]) expect((await request("/me", owner)).status).toBe(403);
    expect((await request("/me", legacy, "GET", undefined, await sign())).status).toBe(403);
    expect((await request("/me", undefined, "GET", undefined, await sign({ legacy_subs: [42] }))).status).toBe(401);
    const jobId = enqueueJob(ctx, primary, "draft", ids[0], "x", "en", { system: "s", user: "u", schema: {}, schemaName: "test" });
    expect((await (await request("/jobs/pending", primary)).json()).map((j: { id: number }) => j.id)).toEqual([jobId]);
    expect(await (await request("/jobs/pending", legacy)).json()).toEqual([]);
    expect(await (await request(`/jobs/${jobId}/claim`, legacy, "POST", { runner: "fixture" })).json()).toEqual({ claimed: false });
    const claim = await (await request(`/jobs/${jobId}/claim`, primary, "POST", { runner: "fixture" })).json();
    expect(claim.claimed).toBe(true);
    expect((await request(`/jobs/${jobId}/complete`, primary, "POST", { claimToken: claim.claimToken, error: "fixture cleanup" })).status).toBe(200);
    const ticket = await (await request("/events/ticket", primary, "POST")).json();
    const abort = new AbortController();
    const events = await app.request(`/api/events?ticket=${ticket.ticket}`, { signal: abort.signal });
    const reader = events.body!.getReader();
    const pending = reader.read();
    // Only the selected workspace's event can arrive through this ticket.
    ctx.bus.emit("change", { ownerId: legacy, resource: "sources" });
    ctx.bus.emit("change", { ownerId: primary, resource: "settings" });
    const message = await pending;
    expect(new TextDecoder().decode(message.value)).toContain("settings");
    abort.abort();
    await reader.cancel();
    expect((await app.request(`/api/events?ticket=${ticket.ticket}`)).status).toBe(401);
    expect((await request("/account/delete", primary, "POST", { confirm: "delete" })).status).toBe(200);
    expect(ctx.db.select().from(schema.settings).all().map(row => row.ownerId)).toEqual([legacy]);
    expect(ctx.db.select().from(schema.candidates).all().map(row => row.ownerId)).toEqual([legacy]);
  } finally {
    ctx.db.$client.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}, 20_000);
