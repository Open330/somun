import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { classifyGeminiError, ptDayKey, RPD_SOFT_CAP } from "./lib/keypool";

/**
 * Gemini 무료 키 풀 상태. AI_API.md 운영 기준:
 * - 무료 키 라운드로빈 (가장 오래 안 쓴 키부터)
 * - 키별 소프트 상한 450 RPD → 넘긴 키는 그날 제외
 * - 429 PerMinute → 같은 키 짧은 쿨다운 (retryDelay 또는 60초)
 * - 429 PerDay → 그 키는 PT 자정까지 제외
 * - 401/403 (키 무효) → 1시간 제외
 */

/** 순환에 쓸 수 있는 라벨을 LRU 순서로. 상태가 없는 라벨은 맨 앞. */
export const order = internalQuery({
  args: { labels: v.array(v.string()) },
  handler: async (ctx, { labels }) => {
    const now = Date.now();
    const day = ptDayKey(now);
    const rows = await ctx.db.query("llmKeyState").collect();
    const byLabel = new Map(rows.map((r) => [r.label, r]));
    const usable = labels.filter((l) => {
      const r = byLabel.get(l);
      if (!r) return true;
      if (r.cooldownUntil && r.cooldownUntil > now) return false;
      if (r.dayKey === day && r.dayCount >= RPD_SOFT_CAP) return false;
      return true;
    });
    return usable.sort((a, b) => (byLabel.get(a)?.lastUsedAt ?? 0) - (byLabel.get(b)?.lastUsedAt ?? 0));
  },
});

export const report = internalMutation({
  args: { label: v.string(), ok: v.boolean(), status: v.optional(v.number()), body: v.optional(v.string()) },
  handler: async (ctx, { label, ok, status, body }) => {
    const now = Date.now();
    const day = ptDayKey(now);
    const row = await ctx.db.query("llmKeyState").withIndex("by_label", (q) => q.eq("label", label)).unique();
    const base = row && row.dayKey === day ? { dayKey: day, dayCount: row.dayCount + 1 } : { dayKey: day, dayCount: 1 };
    const patch: Record<string, unknown> = { label, lastUsedAt: now, ...base };
    if (!ok) {
      const c = classifyGeminiError(status, body, now);
      patch.cooldownUntil = c.cooldownUntil;
      patch.cooldownReason = c.reason;
      patch.lastQuotaId = c.quotaId;
      patch.lastRetryDelay = c.retryDelay;
      patch.lastErrorAt = now;
    }
    if (row) await ctx.db.patch(row._id, patch);
    else await ctx.db.insert("llmKeyState", patch as never);
  },
});

/** Settings 화면용: 키별 오늘 사용량과 쿨다운. 키 값은 없다. */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("llmKeyState").collect();
    const day = ptDayKey(Date.now());
    return rows
      .map((r) => ({ label: r.label, todayCount: r.dayKey === day ? r.dayCount : 0, cap: RPD_SOFT_CAP, cooldownUntil: r.cooldownUntil, cooldownReason: r.cooldownReason, lastUsedAt: r.lastUsedAt, lastQuotaId: r.lastQuotaId }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  },
});
