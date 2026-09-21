import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { editLessonPrompt } from "../core/prompts.js";
import { schema } from "../infra/db/index.js";
import { runLlm, usageProviderOf } from "../infra/llm/providers.js";
import { UsageReporter } from "../infra/usage.js";
import type { GuideSuggestion } from "../shared/types.js";
import { emit, type AppContext } from "./context.js";
import { keyPoolOps } from "./keys.js";
import { normalizeText, similar } from "./ledger.js";
import { getSettings, updateSettings } from "./settings.js";

/**
 * 학습 루프. 검수 행동(수정, 버림)을 다음 초안에 쓰일 것으로 바꾼다.
 *  - 수정 diff, "문체가 아님" 버림 → 지침 제안 (사용자가 승인해야 지침이 된다)
 *  - "사실이 틀림" 버림 → 그 글감의 변경을 원장에 '틀림'으로 표시. 다이제스트·초안이 피한다.
 *  - "글감 아님" 버림 → 저장소별 버림 횟수. 판단이 더 엄격해진다.
 */

const toSuggestion = (r: typeof schema.guideSuggestions.$inferSelect): GuideSuggestion => ({ id: r.id, rule: r.rule, category: r.category as GuideSuggestion["category"], count: r.count, sources: r.sources, status: r.status as GuideSuggestion["status"], createdAt: r.createdAt, updatedAt: r.updatedAt });

export function listSuggestions(ctx: AppContext, ownerId: string, status: GuideSuggestion["status"] = "pending"): GuideSuggestion[] {
  return ctx.db.select().from(schema.guideSuggestions).where(and(eq(schema.guideSuggestions.ownerId, ownerId), eq(schema.guideSuggestions.status, status))).orderBy(desc(schema.guideSuggestions.count), desc(schema.guideSuggestions.updatedAt)).all().map(toSuggestion);
}

function upsertSuggestion(ctx: AppContext, ownerId: string, rule: string, category: string, source: { kind: "edit" | "drop"; draftId: number; at: number }): GuideSuggestion {
  const norm = normalizeText(rule);
  const rows = ctx.db.select().from(schema.guideSuggestions).where(eq(schema.guideSuggestions.ownerId, ownerId)).all();
  const dup = rows.find((r) => r.status !== "dismissed" && similar(r.normalized, norm));
  const now = Date.now();
  if (dup) {
    ctx.db.update(schema.guideSuggestions).set({ count: dup.count + 1, sources: [...dup.sources, source].slice(-10), updatedAt: now }).where(eq(schema.guideSuggestions.id, dup.id)).run();
    emit(ctx, ownerId, { resource: "settings" });
    return toSuggestion({ ...dup, count: dup.count + 1, sources: [...dup.sources, source], updatedAt: now });
  }
  const id = Number(ctx.db.insert(schema.guideSuggestions).values({ ownerId, rule, normalized: norm, category, count: 1, sources: [source], status: "pending", createdAt: now, updatedAt: now }).run().lastInsertRowid);
  emit(ctx, ownerId, { resource: "settings" });
  return toSuggestion(ctx.db.select().from(schema.guideSuggestions).where(eq(schema.guideSuggestions.id, id)).get()!);
}

/** 수정 diff나 버린 초안에서 규칙 하나를 뽑는다. 뽑을 게 없으면 undefined. 실패는 삼킨다(검수 흐름을 막지 않기 위해). */
export async function learnFromEdit(ctx: AppContext, ownerId: string, input: { draftId: number; channel: string; lang: string; before: string; after?: string; dropReason?: string; note?: string }): Promise<GuideSuggestion | undefined> {
  try {
    const settings = getSettings(ctx, ownerId);
    const cfg = settings.llm.provider === "local-agent" ? { provider: "gemini" as const, model: "gemini-3.5-flash-lite" } : settings.llm;
    const startedAt = Date.now();
    const res = await runLlm({ ...cfg }, editLessonPrompt({ channel: input.channel, lang: input.lang, before: input.before, after: input.after, dropReason: input.dropReason, note: input.note, currentGuide: settings.voice.guide || undefined }), "digest", keyPoolOps(ctx), ctx.env.geminiKeys);
    ctx.usage.record({ userId: UsageReporter.userIdOf(ownerId), occurredAt: new Date(startedAt).toISOString(), provider: usageProviderOf(res.provider, cfg.baseUrl), model: res.model, apiKeyLabel: res.keyLabel === "byok" ? "user" : res.keyLabel, latencyMs: res.latencyMs, status: "success", inputTokens: res.usage?.inputTokens ?? 0, outputTokens: res.usage?.outputTokens ?? 0, cachedInputTokens: res.usage?.cachedInputTokens ?? 0, totalTokens: res.usage?.totalTokens ?? 0 });
    const r = res.json as { rule?: string; category?: string };
    const rule = String(r.rule ?? "").trim();
    const category = String(r.category ?? "none");
    if (!rule || category === "none" || rule.length > 160) return undefined;
    return upsertSuggestion(ctx, ownerId, rule, category, { kind: input.after !== undefined ? "edit" : "drop", draftId: input.draftId, at: Date.now() });
  } catch (e) {
    ctx.log.warn({ err: (e as Error).message }, "learnFromEdit failed");
    return undefined;
  }
}

/** 승인: 지침 끝에 한 줄 붙인다. */
export function acceptSuggestion(ctx: AppContext, ownerId: string, id: number): void {
  const r = ctx.db.select().from(schema.guideSuggestions).where(and(eq(schema.guideSuggestions.id, id), eq(schema.guideSuggestions.ownerId, ownerId))).get();
  if (!r) return;
  const settings = getSettings(ctx, ownerId);
  const guide = settings.voice.guide.trim();
  if (!guide.split("\n").some((l) => similar(normalizeText(l), r.normalized))) updateSettings(ctx, ownerId, { voice: { ...settings.voice, guide: guide ? `${guide}\n${r.rule}` : r.rule, chosenAt: settings.voice.chosenAt ?? Date.now() } });
  ctx.db.update(schema.guideSuggestions).set({ status: "accepted", updatedAt: Date.now() }).where(eq(schema.guideSuggestions.id, id)).run();
  emit(ctx, ownerId, { resource: "settings" });
}

export function dismissSuggestion(ctx: AppContext, ownerId: string, id: number): void {
  ctx.db.update(schema.guideSuggestions).set({ status: "dismissed", updatedAt: Date.now() }).where(and(eq(schema.guideSuggestions.id, id), eq(schema.guideSuggestions.ownerId, ownerId))).run();
  emit(ctx, ownerId, { resource: "settings" });
}

/** "사실이 틀림": 그 글감의 원장 항목을 틀림으로 표시. */
export function disputeCandidateFacts(ctx: AppContext, ownerId: string, candidateId: number): number {
  return ctx.db.update(schema.changeLedger).set({ disputedAt: Date.now() }).where(and(eq(schema.changeLedger.ownerId, ownerId), eq(schema.changeLedger.candidateId, candidateId), isNull(schema.changeLedger.disputedAt))).run().changes;
}

export function disputedFor(ctx: AppContext, ownerId: string, repo: string): string[] {
  return ctx.db.select().from(schema.changeLedger).where(and(eq(schema.changeLedger.ownerId, ownerId), eq(schema.changeLedger.repo, repo), sql`${schema.changeLedger.disputedAt} is not null`)).orderBy(desc(schema.changeLedger.disputedAt)).limit(20).all().map((r) => r.text);
}

/** "글감 아님"으로 버린 횟수 (저장소별, 180일). 판단 프롬프트에 들어간다. */
export function repoDropCount(ctx: AppContext, ownerId: string, repo: string): number {
  const since = Date.now() - 180 * 86400e3;
  const rows = ctx.db.select().from(schema.feedback).where(and(eq(schema.feedback.ownerId, ownerId), eq(schema.feedback.reason, "not_worth"))).all().filter((f) => f.createdAt >= since);
  if (rows.length === 0) return 0;
  // feedback.targetId는 draft id(문자열) 또는 judgment id. 저장소로 잇기 위해 둘 다 후보를 거친다.
  let n = 0;
  for (const f of rows) {
    const tid = Number(f.targetId);
    const cid = f.targetType === "draft" ? ctx.db.select({ c: schema.drafts.candidateId }).from(schema.drafts).where(eq(schema.drafts.id, tid)).get()?.c : ctx.db.select({ c: schema.judgments.candidateId }).from(schema.judgments).where(eq(schema.judgments.id, tid)).get()?.c;
    if (cid === undefined) continue;
    const cand = ctx.db.select({ repo: schema.candidates.repo }).from(schema.candidates).where(eq(schema.candidates.id, cid)).get();
    if (cand?.repo === repo) n++;
  }
  return n;
}
