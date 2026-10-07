import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { openDb, schema } from "../infra/db/index.js";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { enqueueJob } from "./pipeline.js";
import { updateSettings } from "./settings.js";
import { assertSharedQueueCapacity, backgroundReserve, reserveSharedExecution, SharedQuotaError } from "./shared-quota.js";

let ctx: AppContext;
const now = Date.parse("2026-10-06T12:00:00Z");
const prompt = { schemaName: "fixture", system: "fixture", user: "fixture", schema: {} };
function candidate(ownerId = "local") {
  return Number(ctx.db.insert(schema.candidates).values({ ownerId, type: "update", title: "fixture", repo: "test/repo", key: String(Math.random()), evidence: {}, createdAt: now, updatedAt: now }).run().lastInsertRowid);
}
beforeEach(() => {
  ctx = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: { geminiKeys: JSON.stringify({ "free-1": "fixture" }), sharedModelDailyLimit: 2, sharedModelPendingLimit: 2 }, bus: new EventEmitter(), usage: { record() {} } as unknown as AppContext["usage"] };
});
afterEach(() => ctx.db.$client.close());

describe("shared model capacity", () => {
  it("counts failed executions, separates owners, and resets at the next UTC day", () => {
    reserveSharedExecution(ctx, "a", now);
    reserveSharedExecution(ctx, "a", now);
    expect(() => reserveSharedExecution(ctx, "a", now)).toThrow(SharedQuotaError);
    expect(() => assertSharedQueueCapacity(ctx, "a", now)).toThrow(SharedQuotaError);
    expect(() => reserveSharedExecution(ctx, "b", now)).not.toThrow();
    expect(() => reserveSharedExecution(ctx, "a", Date.parse("2026-10-07T00:00:00Z"))).not.toThrow();
  });
  it("merges duplicates at capacity and rejects excess work without inserting it", () => {
    const cid = candidate();
    const first = enqueueJob(ctx, "local", "digest", cid, undefined, undefined, prompt);
    enqueueJob(ctx, "local", "digest", candidate(), undefined, undefined, prompt);
    expect(enqueueJob(ctx, "local", "digest", cid, undefined, undefined, prompt)).toBe(first);
    expect(() => enqueueJob(ctx, "local", "digest", candidate(), undefined, undefined, prompt)).toThrow(SharedQuotaError);
    expect(ctx.db.select().from(schema.llmJobs).all()).toHaveLength(2);
  });
  it.each([
    {
      provider: "gemini" as const,
      apiKey: "dummy-user-key",
    },
    {
      provider: "openai" as const,
      apiKey: "dummy-user-key",
    },
    { provider: "local-agent" as const },
  ])("does not consume shared capacity for $provider with a personal key or worker", (llm) => {
    reserveSharedExecution(ctx, "a", now); reserveSharedExecution(ctx, "a", now);
    updateSettings(ctx, "a", { llm });
    for (let i = 0; i < 5; i++) {
      reserveSharedExecution(ctx, "a", now);
      enqueueJob(ctx, "a", "digest", candidate("a"), undefined, undefined, prompt);
    }
  });
  it("returns HTTP 429 and Retry-After and rolls back an oversized batch", async () => {
    const app = createApp(ctx, loadConfig({ SOMUN_ALLOW_ANONYMOUS: "true" }));
    const ids = [candidate(), candidate(), candidate()];
    const response = await app.request("/api/candidates/judge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect((await response.json()).error).toContain("2개");
    expect(ctx.db.select().from(schema.llmJobs).all()).toHaveLength(0);
  });
  it("keeps reservations across database reopen and shares them between connections", () => {
    const dir = mkdtempSync(join(tmpdir(), "somun-quota-"));
    try {
      const file = join(dir, "somun.db");
      const db = openDb(file);
      reserveSharedExecution({ ...ctx, db }, "a", now); db.$client.close();
      const first = openDb(file), second = openDb(file);
      try {
        reserveSharedExecution({ ...ctx, db: second }, "a", now);
        expect(() => reserveSharedExecution({ ...ctx, db: first }, "a", now)).toThrow(SharedQuotaError);
      } finally { first.$client.close(); second.$client.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

it("keeps the last part of the daily limit for user-started work, scaled to the limit", () => {
  expect(backgroundReserve(50)).toBe(20);
  expect(backgroundReserve(10)).toBe(4);
  expect(backgroundReserve(2)).toBe(0);
  ctx.env.sharedModelDailyLimit = 10;
  for (let i = 0; i < 6; i++) reserveSharedExecution(ctx, "local", now, undefined, { background: true });
  // 7번째 자동 작업은 남겨 둔 4회를 쓰지 않는다. 사용자가 시작한 작업은 그대로 쓸 수 있다.
  expect(() => reserveSharedExecution(ctx, "local", now, undefined, { background: true })).toThrow(SharedQuotaError);
  expect(() => reserveSharedExecution(ctx, "local", now)).not.toThrow();
});
