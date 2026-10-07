import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema } from "../infra/db/index.js";
import { freeGeminiKeys, type LlmConfig } from "../infra/llm/providers.js";
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

export function usesSharedModel(ctx: AppContext, ownerId: string, llm = getSettings(ctx, ownerId).llm): boolean {
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
  if (usage.used >= limit) throw new SharedQuotaError(say(localeOf(ctx, ownerId), `오늘 공유 모델 실행 한도(${limit}회)에 도달했습니다. 한도는 매일 00:00 UTC(한국 시간 09:00)에 초기화됩니다. 그 뒤 다시 시도하거나 개인 API 키·로컬 워커를 사용해 주세요.`, `Today's shared model execution limit (${limit}) has been reached. It resets daily at 00:00 UTC (09:00 KST). Try again after that, or use your own API key or local worker.`), usage.resetAt);
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

/**
 * 뒤에서 도는 작업(프로필, 자동 분석)이 남겨 두는 몫: 하루 한도의 40%와 20회 중 작은 쪽.
 * 사용자가 직접 요청한 분석·초안이 그 작업들 때문에 한도에 막히지 않게 한다. 한도가 작아도 0이 되지 않게 비율로 둔다.
 */
export const backgroundReserve = (limit: number) => Math.min(20, Math.floor(limit * 0.4));

/** Reserve before network I/O; failures still use capacity. Persisted and atomic across processes/restarts. */
export function reserveSharedExecution(ctx: AppContext, ownerId: string, now = Date.now(), config?: LlmConfig, opts: { background?: boolean } = {}): void {
  if (!usesSharedModel(ctx, ownerId, config)) return;
  ctx.db.$client.transaction(() => {
    const usage = assertDaily(ctx, ownerId, now);
    const limit = ctx.env.sharedModelDailyLimit ?? 50;
    // 호출할 때마다 확인한다(긴 수집 도중 다른 작업이 한도를 써도 남겨 둔 몫을 넘지 않게).
    if (opts.background && usage.count >= limit - backgroundReserve(limit)) {
      throw new SharedQuotaError(say(localeOf(ctx, ownerId), `오늘 공유 모델 한도의 마지막 ${backgroundReserve(limit)}회는 직접 요청한 작업에 남겨 둡니다. 자동 작업은 내일 이어집니다.`, `The last ${backgroundReserve(limit)} shared model runs today are kept for work you start yourself. Automatic work continues tomorrow.`), sharedUsage(ctx, ownerId, now).resetAt);
    }
    ctx.db.insert(schema.appState).values({ key: quotaKey(ownerId), value: JSON.stringify({ ...usage, count: usage.count + 1 }), updatedAt: now }).onConflictDoUpdate({ target: schema.appState.key, set: { value: JSON.stringify({ ...usage, count: usage.count + 1 }), updatedAt: now } }).run();
  }).immediate();
  emit(ctx, ownerId, { resource: "keys" });
}
