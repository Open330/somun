import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import pino from "pino";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppContext } from "../../app/context.js";
import { saveGithubApp } from "../../app/connectors.js";
import { openDb, schema } from "../../infra/db/index.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";

let ctx: AppContext;
beforeEach(() => {
  vi.stubEnv("GITHUB_APP_ID", ""); vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");
  ctx = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: {} as AppContext["usage"] };
  saveGithubApp(ctx, { id: 1, pem: "test", slug: "test", webhook_secret: "whsec" });
});
afterEach(() => { ctx.db.$client.close(); vi.unstubAllEnvs(); });

const send = (payload: unknown, secret = "whsec") => {
  const body = JSON.stringify(payload);
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  return createApp(ctx, loadConfig({ SOMUN_TOKEN: "t" })).request("/api/webhooks/github", { method: "POST", body, headers: { "x-github-event": "installation", "x-hub-signature-256": sig } });
};

it("remembers who installed an unlinked installation, and ignores unsigned deliveries", async () => {
  expect((await send({ action: "created", installation: { id: 8 }, sender: { id: 5, login: "member" } }, "wrong")).status).toBe(401);
  expect(ctx.db.select().from(schema.appState).all().some((r) => r.key === "installer:8")).toBe(false);
  expect((await send({ action: "created", installation: { id: 8 }, sender: { id: 5, login: "member" } })).status).toBe(200);
  expect(JSON.parse(ctx.db.select().from(schema.appState).all().find((r) => r.key === "installer:8")!.value)).toEqual({ id: 5, login: "member" });
});
