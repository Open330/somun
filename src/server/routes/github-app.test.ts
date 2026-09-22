import { EventEmitter } from "node:events";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../../app/context.js";
import { githubAppConfig } from "../../app/connectors.js";
import { openDb } from "../../infra/db/index.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";

describe("GitHub App setup authorization", () => {
  let ctx: AppContext;
  let app: ReturnType<typeof createApp>;
  const headers = { Authorization: "Bearer admin-token" };
  beforeEach(() => {
    vi.stubEnv("GITHUB_APP_ID", ""); vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");
    ctx = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: {} as AppContext["usage"] };
    app = createApp(ctx, loadConfig({ SOMUN_TOKEN: "admin-token", SOMUN_TOKEN_OWNER_ID: "admin", SOMUN_ADMIN_OWNER_ID: "admin", SOMUN_PUBLIC_URL: "https://somun.example" }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 1, slug: "somun-test", pem: "test-pem" }))));
  });
  afterEach(() => { ctx.db.$client.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
  async function start() {
    const response = await app.request("/api/github/app/setup", { method: "POST", headers });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("SameSite=Lax"); expect(cookie).toContain("Secure");
    const setup = await response.json() as { createUrl: string };
    return { state: new URL(setup.createUrl).searchParams.get("state")!, cookie: cookie.split(";")[0] };
  }
  it("rejects anonymous callers, ordinary users, and unset admin configuration", async () => {
    expect((await app.request("/api/github/app/setup", { method: "POST" })).status).toBe(401);
    for (const env of [
      { SOMUN_ALLOW_ANONYMOUS: "true", SOMUN_ADMIN_OWNER_ID: "local" },
      { SOMUN_TOKEN: "admin-token", SOMUN_ADMIN_OWNER_ID: "someone-else" },
      { SOMUN_TOKEN: "admin-token" },
    ]) {
      const other = createApp(ctx, loadConfig(env));
      expect((await other.request("/api/github/app/setup", { method: "POST", headers })).status).toBe(403);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires matching state and browser cookie, consumes state once, and prevents replacement", async () => {
    const { state, cookie } = await start();
    const path = `/api/github/app/created?code=test&state=${state}`;
    expect((await app.request(path)).status).toBe(400);
    expect((await app.request(path.replace(state, "wrong"), { headers: { Cookie: cookie } })).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect((await app.request(path, { headers: { Cookie: cookie } })).status).toBe(302);
    expect(githubAppConfig(ctx)?.slug).toBe("somun-test");
    expect((await app.request(path, { headers: { Cookie: cookie } })).status).toBe(400);
    expect((await app.request("/api/github/app/setup", { method: "POST", headers })).status).toBe(409);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects expired state without calling GitHub", async () => {
    vi.useFakeTimers(); const { state, cookie } = await start();
    vi.advanceTimersByTime(15 * 60_000);
    expect((await app.request(`/api/github/app/created?code=test&state=${state}`, { headers: { Cookie: cookie } })).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("consumes state even when the upstream conversion fails", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("error", { status: 502 }));
    const { state, cookie } = await start();
    const path = `/api/github/app/created?code=test&state=${state}`;
    expect((await app.request(path, { headers: { Cookie: cookie } })).status).toBe(502);
    expect((await app.request(path, { headers: { Cookie: cookie } })).status).toBe(400);
  });
});
