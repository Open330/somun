import { eq } from "drizzle-orm";
import { classifyGeminiError, ptDayKey, RPD_SOFT_CAP } from "../core/keypool.js";
import { schema } from "../infra/db/index.js";
import type { KeyPoolOps } from "../infra/llm/providers.js";
import type { KeyStatus } from "../shared/types.js";
import { emit, type AppContext } from "./context.js";

/** 서버 Gemini 무료 키 풀 상태 (AI_API.md 운영 기준). */
export function keyPoolOps(ctx: AppContext): KeyPoolOps {
  return {
    order: async (labels) => {
      const now = Date.now();
      const day = ptDayKey(now);
      const rows = ctx.db.select().from(schema.llmKeyState).all();
      const by = new Map(rows.map((r) => [r.label, r]));
      return labels
        .filter((l) => {
          const r = by.get(l);
          if (!r) return true;
          if (r.cooldownUntil && r.cooldownUntil > now) return false;
          if (r.dayKey === day && r.dayCount >= RPD_SOFT_CAP) return false;
          return true;
        })
        .sort((a, b) => (by.get(a)?.lastUsedAt ?? 0) - (by.get(b)?.lastUsedAt ?? 0));
    },
    report: async ({ label, ok, status, body }) => {
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
    .map((r) => ({ label: r.label, todayCount: r.dayKey === day ? r.dayCount : 0, cap: RPD_SOFT_CAP, cooldownUntil: r.cooldownUntil ?? undefined, cooldownReason: r.cooldownReason ?? undefined, lastUsedAt: r.lastUsedAt, lastQuotaId: r.lastQuotaId ?? undefined }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}
