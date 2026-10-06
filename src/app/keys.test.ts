import { EventEmitter } from "node:events";
import pino from "pino";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDb, schema } from "../infra/db/index.js";
import type { AppContext } from "./context.js";
import { modelAvailability, UPSTREAM_FAILURE_WINDOW_MS } from "./keys.js";
import { updateSettings } from "./settings.js";
import { ptDayKey, nextPtMidnight, RPD_SOFT_CAP } from "../core/keypool.js";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
let ctx: AppContext;
const now = Date.UTC(2026, 9, 4, 10);
beforeEach(() => {
  ctx = {
    db: openDb(":memory:"),
    log: pino({ level: "silent" }),
    env: {
      geminiKeys: JSON.stringify({ "free-a": "test-key-a", "free-b": "test-key-b", "paid-1": "paid-secret" }),
      trustedOwners: ["admin"],
    },
    bus: new EventEmitter(),
    usage: { record: vi.fn() } as unknown as AppContext["usage"],
  };
  updateSettings(ctx, "me", { llm: { provider: "gemini", model: "analysis-model", draftModel: "draft-model" } });
});
afterEach(() => ctx.db.$client.close());
const blocked = (label: string, model: string, cooldownUntil: number, count = 0) =>
  ctx.db
    .insert(schema.llmKeyState)
    .values({ label: `${label}|${model}`, dayKey: ptDayKey(now), dayCount: count, lastUsedAt: now, cooldownUntil })
    .run();
it("reports independent model availability and the earliest time any configured key is usable", () => {
  blocked("free-a", "draft-model", now + 60000);
  blocked("free-b", "draft-model", now + 120000);
  blocked("not-configured", "draft-model", 0);
  const view = modelAvailability(ctx, "me", now);
  expect(view.models).toEqual([
    { purpose: "analysis", model: "analysis-model", state: "ready" },
    { purpose: "draft", model: "draft-model", state: "waiting", retryAt: now + 60000 },
  ]);
  expect(modelAvailability(ctx, "me", now + 60000).models[1].state).toBe("ready");
});
it("waits for both daily cap reset and cooldown, but doesn't treat one blocked key as pool exhaustion", () => {
  blocked("free-a", "draft-model", now + 60000, RPD_SOFT_CAP);
  expect(modelAvailability(ctx, "me", now).models[1].state).toBe("ready");
  blocked("free-b", "draft-model", nextPtMidnight(now) + 60000, RPD_SOFT_CAP);
  expect(modelAvailability(ctx, "me", now).models[1].retryAt).toBe(nextPtMidnight(now));
  expect(modelAvailability(ctx, "me", nextPtMidnight(now)).models[1].state).toBe("ready");
});
it("shows a model as degraded while its last call failed with a server error, even though 5xx sets no cooldown", () => {
  ctx.db.insert(schema.llmKeyState).values({ label: "free-a|draft-model", dayKey: ptDayKey(now), dayCount: 3, lastUsedAt: now, lastErrorAt: now, cooldownUntil: now, cooldownReason: "upstream-503" }).run();
  expect(modelAvailability(ctx, "me", now + 1000).models[1]).toEqual({ purpose: "draft", model: "draft-model", state: "degraded", lastStatus: 503 });
  expect(modelAvailability(ctx, "me", now + UPSTREAM_FAILURE_WINDOW_MS + 1).models[1].state).toBe("ready");
  // 다른 키의 다음 호출이 성공하면 회복으로 본다.
  ctx.db.insert(schema.llmKeyState).values({ label: "free-b|draft-model", dayKey: ptDayKey(now), dayCount: 1, lastUsedAt: now + 500 }).run();
  expect(modelAvailability(ctx, "me", now + 1000).models[1].state).toBe("ready");
});
it("uses the current account's provider and never claims to know personal key or worker quotas", () => {
  updateSettings(ctx, "other", { llm: {
    provider: "openai",
    apiKey: "dummy-user-key",
    model: "own-model",
  } });
  expect(modelAvailability(ctx, "other", now)).toMatchObject({
    mode: "user",
    models: [
      { state: "unknown", model: "own-model" },
      { state: "unknown", model: "own-model" },
    ],
  });
  expect(modelAvailability(ctx, "me", now).mode).toBe("shared");
  updateSettings(ctx, "me", { llm: { provider: "local-agent", agentCli: "codex" } });
  expect(modelAvailability(ctx, "me", now)).toMatchObject({ mode: "local", models: [{ state: "local" }, { state: "local" }] });
  updateSettings(ctx, "me", { llm: { provider: "anthropic" } });
  expect(modelAvailability(ctx, "me", now).mode).toBe("missing");
});
it("exposes safe aggregate availability to a non-admin without shared key identities or secrets", async () => {
  const app = createApp(ctx, loadConfig({ SOMUN_TOKEN: "me-token", SOMUN_TOKEN_OWNER_ID: "me" }));
  const res = await app.request("/api/model-availability", { headers: { Authorization: "Bearer me-token" } });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(JSON.parse(text).mode).toBe("shared");
  for (const secret of ["free-a", "test-key", "paid-1", "dayCount", "cap"]) expect(text).not.toContain(secret);
});

it("shows only this account's shared execution usage and stops claiming readiness at its daily limit", async () => {
  const { reserveSharedExecution } = await import("./shared-quota.js");
  ctx.env.sharedModelDailyLimit = 1;
  reserveSharedExecution(ctx, "local", now);
  const view = modelAvailability(ctx, "local", now);
  expect(view.sharedUsage).toMatchObject({ used: 1, limit: 1, pendingLimit: 20 });
  expect(view.models.every((m) => m.state === "waiting" && m.retryAt === view.sharedUsage!.resetAt)).toBe(true);
  expect(modelAvailability(ctx, "other", now).sharedUsage!.used).toBe(0);
  updateSettings(ctx, "local", { llm: {
    provider: "gemini",
    apiKey: "dummy-user-key",
  } });
  expect(modelAvailability(ctx, "local", now).sharedUsage).toBeUndefined();
});
