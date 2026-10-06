import { sharedUsage } from "./shared-quota.js";
import { eq } from "drizzle-orm";
import { classifyGeminiError, nextPtMidnight, ptDayKey, RPD_SOFT_CAP } from "../core/keypool.js";
import { schema } from "../infra/db/index.js";
import { freeGeminiKeys, modelFor, type KeyPoolOps } from "../infra/llm/providers.js";
import type { KeyStatus, ModelAvailability } from "../shared/types.js";
import { emit, type AppContext } from "./context.js";
import { getSettings } from "./settings.js";

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
    return retryAt > now ? { purpose, model, state: "waiting", retryAt } : { purpose, model, state: "ready" };
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
      emit(ctx, "*", { resource: "keys" });
    },
  };
}

export function keyStatus(ctx: AppContext): KeyStatus[] {
  const day = ptDayKey(Date.now());
  return ctx.db.select().from(schema.llmKeyState).all()
    .filter((r) => r.label.includes("|"))
    .map((r) => ({ label: r.label.replace("|", " · "), todayCount: r.dayKey === day ? r.dayCount : 0, cap: RPD_SOFT_CAP, cooldownUntil: r.cooldownUntil ?? undefined, cooldownReason: r.cooldownReason ?? undefined, lastUsedAt: r.lastUsedAt, lastQuotaId: r.lastQuotaId ?? undefined }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}
