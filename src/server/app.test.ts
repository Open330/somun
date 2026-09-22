import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../app/context.js";
import { openDb } from "../infra/db/index.js";
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
