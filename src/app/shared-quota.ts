import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema } from "../infra/db/index.js";
import { freeGeminiKeys } from "../infra/llm/providers.js";
import { emit, type AppContext } from "./context.js";
import { localeOf, say } from "./i18n.js";
import { getSettings } from "./settings.js";

export class SharedQuotaError extends Error {
  constructor(message: string, public readonly retryAt: number) { super(message); }
}

/** A model execution includes a profile, analysis, draft or repair, before provider retries. UTC day. */
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
const nextDay = (now: number) => Date.parse(`${dayOf(now)}T00:00:00Z`) + 86_400_000;
const quotaKey = (ownerId: string) => `shared_quota:${createHash("sha256").update(ownerId).digest("hex")}`;

export function usesSharedModel(ctx: AppContext, ownerId: string): boolean {
  const { llm } = getSettings(ctx, ownerId);
  return llm.provider === "gemini" && !llm.apiKey && freeGeminiKeys(ctx.env.geminiKeys).length > 0;
}

export function sharedUsage(ctx: AppContext, ownerId: string, now = Date.now()) {
  const row = ctx.db.select().from(schema.appState).where(eq(schema.appState.key, quotaKey(ownerId))).get();
  const saved = row ? JSON.parse(row.value) as { day: string; count: number } : undefined;
  const usage = { day: dayOf(now), count: saved?.day === dayOf(now) ? saved.count : 0 };
  return { used: usage.count, limit: ctx.env.sharedModelDailyLimit ?? 50, resetAt: nextDay(now), pendingLimit: ctx.env.sharedModelPendingLimit ?? 20 };
}

function assertDaily(ctx: AppContext, ownerId: string, now: number): { day: string; count: number } {
  const usage = sharedUsage(ctx, ownerId, now);
  const limit = usage.limit;
  if (usage.used >= limit) throw new SharedQuotaError(say(localeOf(ctx, ownerId), `오늘 공유 모델 실행 한도(${limit}회)에 도달했습니다. UTC 자정 이후 다시 시도하거나 개인 API 키·로컬 워커를 사용해 주세요.`, `Today's shared model execution limit (${limit}) has been reached. Try after midnight UTC or use your own API key or local worker.`), usage.resetAt);
  return { day: dayOf(now), count: usage.used };
}

/** Called inside queue admission transactions, after duplicate work has been merged. */
export function assertSharedQueueCapacity(ctx: AppContext, ownerId: string, now = Date.now()): void {
  if (!usesSharedModel(ctx, ownerId)) return;
  assertDaily(ctx, ownerId, now);
  const pending = ctx.db.select({ count: sql<number>`count(*)` }).from(schema.llmJobs).where(and(eq(schema.llmJobs.ownerId, ownerId), eq(schema.llmJobs.executor, "server"), inArray(schema.llmJobs.status, ["pending", "claimed"]))).get()!.count;
  const limit = ctx.env.sharedModelPendingLimit ?? 20;
  if (pending >= limit) throw new SharedQuotaError(say(localeOf(ctx, ownerId), `공유 모델 대기·실행 작업은 최대 ${limit}개입니다. 진행 중인 작업이 끝난 뒤 다시 시도해 주세요.`, `You can have at most ${limit} queued or running shared model jobs. Try after a current job finishes.`), now + 60_000);
}

/** Reserve before network I/O; failures still use capacity. Persisted and atomic across processes/restarts. */
export function reserveSharedExecution(ctx: AppContext, ownerId: string, now = Date.now()): void {
  if (!usesSharedModel(ctx, ownerId)) return;
  ctx.db.$client.transaction(() => {
    const usage = assertDaily(ctx, ownerId, now);
    ctx.db.insert(schema.appState).values({ key: quotaKey(ownerId), value: JSON.stringify({ ...usage, count: usage.count + 1 }), updatedAt: now }).onConflictDoUpdate({ target: schema.appState.key, set: { value: JSON.stringify({ ...usage, count: usage.count + 1 }), updatedAt: now } }).run();
  }).immediate();
  emit(ctx, ownerId, { resource: "keys" });
}
