import { sharedUsage } from "./shared-quota.js";
import { eq } from "drizzle-orm";
import { classifyGeminiError, nextPtMidnight, ptDayKey, RPD_SOFT_CAP } from "../core/keypool.js";
import { schema } from "../infra/db/index.js";
import { freeGeminiKeys, modelFor, type KeyPoolOps } from "../infra/llm/providers.js";
import type { KeyStatus, ModelAvailability } from "../shared/types.js";
import { emit, type AppContext } from "./context.js";
import { getSettings } from "./settings.js";

/** 서버 오류를 기억하는 시간. 이 안에 마지막 호출이 5xx로 끝났으면 모델이 불안정하다고 본다. */
export const UPSTREAM_FAILURE_WINDOW_MS = 10 * 60_000;

/**
 * 이 모델의 마지막 호출이 최근에 서버 오류(5xx)로 끝났으면 그 HTTP 상태. 5xx는 키 쿨다운을 걸지 않으므로(키를 바꿔도 같다)
 * 쿨다운만 보면 "요청 가능"으로 보인다. 마지막 호출이 성공했으면 회복된 것으로 본다.
 */
export function recentUpstreamFailure(ctx: AppContext, model: string, now = Date.now()): number | undefined {
  const rows = ctx.db.select().from(schema.llmKeyState).all().filter((r) => r.label.endsWith(`|${model}`));
  const last = rows.sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
  if (!last?.lastErrorAt || last.lastErrorAt !== last.lastUsedAt || now - last.lastErrorAt > UPSTREAM_FAILURE_WINDOW_MS) return undefined;
  const status = Number(/^upstream-(\d+)$/.exec(last.cooldownReason ?? "")?.[1]);
  return Number.isFinite(status) ? status : undefined;
}

export function modelAvailability(ctx: AppContext, ownerId: string, now = Date.now()): ModelAvailability {
  const { llm } = getSettings(ctx, ownerId);
  const keys = freeGeminiKeys(ctx.env.geminiKeys);
  const mode: ModelAvailability["mode"] = llm.provider === "local-agent" ? "local" : llm.apiKey ? "user" : llm.provider === "gemini" && keys.length ? "shared" : "missing";
  const usage = mode === "shared" ? sharedUsage(ctx, ownerId, now) : undefined;
  const rows = new Map(ctx.db.select().from(schema.llmKeyState).all().map((r) => [r.label, r]));
  const models = (["analysis", "draft"] as const).map((purpose): ModelAvailability["models"][number] => {
    const model = modelFor(llm, purpose === "draft" ? "draft" : "judge");
    if (mode !== "shared") return { purpose, model, state: mode === "user" ? "unknown" : mode };
    const waits = keys.map(({ label }) => {
      const row = rows.get(`${label}|${model}`);
      return Math.max(row?.cooldownUntil ?? 0, row?.dayKey === ptDayKey(now) && row.dayCount >= RPD_SOFT_CAP ? nextPtMidnight(now) : 0);
    });
    const retryAt = Math.max(Math.min(...waits), usage && usage.used >= usage.limit ? usage.resetAt : 0);
    if (retryAt > now) return { purpose, model, state: "waiting", retryAt };
    const failed = recentUpstreamFailure(ctx, model, now);
    return failed ? { purpose, model, state: "degraded", lastStatus: failed } : { purpose, model, state: "ready" };
  });
  return { mode, checkedAt: now, models, ...(usage ? { sharedUsage: usage } : {}) };
}

/** 서버 Gemini 무료 키 풀 상태 (AI_API.md 운영 기준). */
export function keyPoolOps(ctx: AppContext): KeyPoolOps {
  return {
    order: async (labels, model) => {
      const now = Date.now();
      const day = ptDayKey(now);
      const rows = ctx.db.select().from(schema.llmKeyState).all();
      const by = new Map(rows.map((r) => [r.label, r]));
      return labels
        .filter((l) => {
          const r = by.get(`${l}|${model}`);
          if (!r) return true;
          if (r.cooldownUntil && r.cooldownUntil > now) return false;
          if (r.dayKey === day && r.dayCount >= RPD_SOFT_CAP) return false;
          return true;
        })
        .sort((a, b) => (by.get(`${a}|${model}`)?.lastUsedAt ?? 0) - (by.get(`${b}|${model}`)?.lastUsedAt ?? 0));
    },
    report: async ({ label: base, model, ok, status, body }) => {
      const label = `${base}|${model}`;
      const now = Date.now();
      const day = ptDayKey(now);
      const row = ctx.db.select().from(schema.llmKeyState).where(eq(schema.llmKeyState.label, label)).get();
      const dayCount = row && row.dayKey === day ? row.dayCount + 1 : 1;
      const patch: Partial<typeof schema.llmKeyState.$inferInsert> = { lastUsedAt: now, dayKey: day, dayCount };
      if (!ok) {
        const c = classifyGeminiError(status, body, now);
        Object.assign(patch, { cooldownUntil: c.cooldownUntil, cooldownReason: c.reason, lastQuotaId: c.quotaId ?? null, lastRetryDelay: c.retryDelay ?? null, lastErrorAt: now });
      }
      ctx.db.insert(schema.llmKeyState).values({ label, ...patch } as typeof schema.llmKeyState.$inferInsert).onConflictDoUpdate({ target: schema.llmKeyState.label, set: patch }).run();
      // 실패 원인이 작업 오류 문구에는 뭉뚱그려지므로 로그에 남긴다(본문은 자격 증명이 섞일 수 있어 남기지 않는다).
      if (!ok) ctx.log.warn({ key: base, model, status, reason: patch.cooldownReason }, "model call failed");
      emit(ctx, "*", { resource: "keys" });
    },
    unavailable: async (model) => recentUpstreamFailure(ctx, model) !== undefined,
  };
}

export function keyStatus(ctx: AppContext): KeyStatus[] {
  const day = ptDayKey(Date.now());
  return ctx.db.select().from(schema.llmKeyState).all()
    .filter((r) => r.label.includes("|"))
    .map((r) => ({ label: r.label.replace("|", " · "), todayCount: r.dayKey === day ? r.dayCount : 0, cap: RPD_SOFT_CAP, cooldownUntil: r.cooldownUntil ?? undefined, cooldownReason: r.cooldownReason ?? undefined, lastUsedAt: r.lastUsedAt, lastQuotaId: r.lastQuotaId ?? undefined }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}
