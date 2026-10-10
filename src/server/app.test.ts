import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../app/context.js";
import { openDb, schema } from "../infra/db/index.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

describe("HTTP response boundaries", () => {
  let ctx: AppContext;
  let webDir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    webDir = mkdtempSync(join(tmpdir(), "somun-web-"));
    writeFileSync(join(webDir, "index.html"), "<html>somun test</html>");
    ctx = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: {} as AppContext["usage"] };
    app = createApp(ctx, loadConfig({ SOMUN_TOKEN: "test-token", WEB_DIST: relative(process.cwd(), webDir) }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    ctx.db.$client.close();
    rmSync(webDir, { recursive: true, force: true });
  });

  const headers = { Authorization: "Bearer test-token", "Content-Type": "application/json" };

  it("accepts a single selected channel, another selection, and deliberately empty channel settings", async () => {
    for (const channelLangs of [{ x: ["en"] }, { threads: ["ko"] }, {}]) {
      const res = await app.request("/api/settings", { method: "PATCH", headers, body: JSON.stringify({ channelLangs }) });
      expect(res.status).toBe(200);
      expect((await res.json()).channelLangs).toEqual(channelLangs);
    }
    expect((await app.request("/api/settings", { method: "PATCH", headers, body: JSON.stringify({ channelLangs: { unknown: ["ko"] } }) })).status).toBe(400);
  });

  it("accepts URL-less confirmation and actual posting time, and validates review checkpoints", async () => {
    const now = Date.now();
    const candidateId = Number(ctx.db.insert(schema.candidates).values({ ownerId: "local", type: "release", title: "t", repo: "me/tool", key: "k", evidence: {}, createdAt: now, updatedAt: now }).run().lastInsertRowid);
    const draftId = Number(ctx.db.insert(schema.drafts).values({ ownerId: "local", candidateId, channel: "x", lang: "ko", version: 1, purpose: "introduction", body: "Body", lint: [], status: "proposed", model: "fixture", createdAt: now, updatedAt: now }).run().lastInsertRowid);
    const send = (method: string, path: string, body: unknown) => app.request(path, { method, headers, body: JSON.stringify(body) });
    const res = await send("POST", "/api/publications", { candidateId, draftId, channel: "x", lang: "ko", publishedAt: now - 86400e3 });
    expect(res.status).toBe(200);
    const { id } = await res.json();
    expect(ctx.db.select().from(schema.publications).get()).toMatchObject({ id, url: "", publishedAt: now - 86400e3 });
    expect((await send("POST", `/api/publications/${id}/stats`, { visits: 12, installs: 0 })).status).toBe(204);
    expect(ctx.db.select().from(schema.publications).get()?.manualStats).toEqual({ visits: 12, installs: 0 });
    expect((await send("POST", `/api/publications/${id}/stats`, { signups: -1 })).status).toBe(400);
    expect((await send("POST", `/api/publications/${id}/stats`, { visits: 1.5 })).status).toBe(400);
    expect((await send("PATCH", `/api/publications/${id}`, { publishedAt: now - 2 * 86400e3 })).status).toBe(204);
    expect((await send("POST", "/api/publications", { candidateId, channel: "x", publishedAt: now + 86400e3 })).status).toBe(400);
    expect((await send("POST", "/api/publications", { candidateId, draftId, channel: "linkedin" })).status).toBe(400);
    const sessionId = "00000000-0000-4000-8000-000000000001";
    expect((await send("PATCH", `/api/drafts/${draftId}/review`, { sessionId, activeSeconds: 0 })).status).toBe(204);
    expect((await send("PATCH", `/api/drafts/${draftId}/review`, { sessionId, activeSeconds: -1 })).status).toBe(400);
    expect((await send("PATCH", `/api/drafts/${draftId}/review`, { sessionId: "bad", activeSeconds: 0 })).status).toBe(400);
  });

  it("keeps unknown API routes out of the SPA fallback", async () => {
    for (const path of ["/api", "/api/does-not-exist"]) {
      const res = await app.request(path, { headers });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
    }
    const page = await app.request("/settings");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("somun test");
  });

  it("sends baseline security headers and 404s paths the app does not have", async () => {
    const home = await app.request("/");
    expect(home.headers.get("strict-transport-security")).toContain("max-age=");
    expect(home.headers.get("x-content-type-options")).toBe("nosniff");
    expect(home.headers.get("x-frame-options")).toBe("DENY");
    expect(home.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    for (const path of ["/does-not-exist", "/.env", "/favicon.ico"]) expect((await app.request(path)).status).toBe(404);
    for (const path of ["/c/12", "/voice", "/github/pick"]) expect((await app.request(path)).status).toBe(200);
    // 자기 Referrer-Policy를 정한 응답은 덮어쓰지 않는다.
    const callback = await app.request("/api/github/app/created?code=x&state=y");
    expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("answers check-now with 202 when collection takes longer than the wait limit, and keeps collecting", async () => {
    const slow = createApp(ctx, loadConfig({ SOMUN_TOKEN: "test-token", WEB_DIST: relative(process.cwd(), webDir), COLLECT_WAIT_MS: "20" }));
    ctx.db.insert(schema.sources).values({ ownerId: "local", kind: "blog", targets: ["https://blog.test/feed.xml"], enabled: true }).run();
    let finish: (r: Response) => void = () => {};
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((done) => (finish = done)));
    const res = await slow.request("/api/collect", { method: "POST", headers });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ pending: true });
    finish(new Response("<rss><channel></channel></rss>", { status: 200 }));
    await vi.waitFor(() => expect(ctx.db.select().from(schema.sources).get()?.lastPolledAt).toBeTruthy());
  });

  it("requires authentication and preserves resource-not-found responses", async () => {
    expect((await app.request("/api/me")).status).toBe(401);
    const me = await app.request("/api/me", { headers });
    expect(await me.json()).toEqual({ ownerId: "local" });
    const missing = await app.request("/api/candidates/999", { headers });
    expect(missing.status).toBe(404);
  });

  it("returns 400 for malformed JSON and invalid request fields", async () => {
    const malformed = await app.request("/api/sources", { method: "POST", headers, body: "{" });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid JSON" });
    const invalid = await app.request("/api/sources", { method: "POST", headers, body: "{}" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "invalid request" });
  });

  it("logs unexpected errors without exposing their details to clients", async () => {
    const log = vi.spyOn(ctx.log, "error");
    vi.spyOn(ctx.db, "select").mockImplementation(() => { throw new Error("private database detail"); });
    const res = await app.request("/api/sources", { headers });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal server error" });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ err: "private database detail" }), "unhandled");
  });
});
