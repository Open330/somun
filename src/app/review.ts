import { and, desc, eq } from "drizzle-orm";
import type { Channel } from "../core/channels.js";
import { draftLintFacts, lintDraft } from "../core/lint.js";
import { schema } from "../infra/db/index.js";
import type { Draft, Evidence, Example, FeedbackReason } from "../shared/types.js";
import { toDraft } from "./candidates.js";
import { emit, NotFoundError, type AppContext } from "./context.js";
import { getProfile } from "./profiles.js";
import { getSettings } from "./settings.js";
import { disputeCandidateFacts, learnFromEdit } from "./learning.js";

/** 검수 루프: 복사/수정/버림이 문체 예시와 피드백을 만든다. */

function getDraftRow(ctx: AppContext, ownerId: string, id: number) {
  const d = ctx.db.select().from(schema.drafts).where(and(eq(schema.drafts.id, id), eq(schema.drafts.ownerId, ownerId))).get();
  if (!d) throw new NotFoundError("draft");
  return d;
}

/** 사용자 예시가 채널당 5개 쌓이면 시드는 비활성화. */
function retireSeeds(ctx: AppContext, ownerId: string, channel: string, lang: string) {
  const active = ctx.db.select().from(schema.examples).where(and(eq(schema.examples.ownerId, ownerId), eq(schema.examples.channel, channel), eq(schema.examples.lang, lang), eq(schema.examples.active, true))).all();
  if (active.filter((e) => e.source !== "seed").length >= 5) {
    for (const s of active.filter((e) => e.source === "seed")) ctx.db.update(schema.examples).set({ active: false }).where(eq(schema.examples.id, s.id)).run();
  }
}

export function saveDraftEdit(ctx: AppContext, ownerId: string, id: number, input: { title?: string; body: string; markCopied: boolean }): Draft {
  const d = getDraftRow(ctx, ownerId, id);
  const settings = getSettings(ctx, ownerId);
  const changed = d.body !== input.body || (d.title ?? "") !== (input.title ?? "");
  const now = Date.now();
  const lang = d.lang;
  if (changed) {
    const exId = Number(ctx.db.insert(schema.examples).values({ ownerId, channel: d.channel, lang, title: input.title ?? null, body: input.body, source: "edited", note: `candidate ${d.candidateId} v${d.version}`, active: true, createdAt: now }).run().lastInsertRowid);
    ctx.db.insert(schema.draftEdits).values({ ownerId, draftId: id, channel: d.channel, before: d.body, after: input.body, promotedExampleId: exId, createdAt: now }).run();
    retireSeeds(ctx, ownerId, d.channel, lang);
    // 수정에서 규칙을 뽑는다. 검수 흐름을 막지 않도록 뒤에서.
    void learnFromEdit(ctx, ownerId, { draftId: id, channel: d.channel, lang, before: d.body, after: input.body });
  } else if (input.markCopied) {
    ctx.db.insert(schema.examples).values({ ownerId, channel: d.channel, lang, title: input.title ?? null, body: input.body, source: "approved", active: true, createdAt: now }).run();
    retireSeeds(ctx, ownerId, d.channel, lang);
  }
  const cand = ctx.db.select().from(schema.candidates).where(eq(schema.candidates.id, d.candidateId)).get();
  const status = input.markCopied ? "copied" : changed ? "edited" : d.status;
  ctx.db.update(schema.drafts).set({ title: input.title ?? null, body: input.body, lint: lintDraft(d.channel as Channel, input.title, input.body, settings.bannedPhrases, cand ? draftLintFacts({ title: cand.title, type: cand.type, evidence: cand.evidence as Evidence }, getProfile(ctx, ownerId, cand.repo)?.profile) : {}), status, updatedAt: now }).where(eq(schema.drafts.id, id)).run();
  emit(ctx, ownerId, { resource: "drafts", id });
  emit(ctx, ownerId, { resource: "examples" });
  return toDraft(getDraftRow(ctx, ownerId, id));
}

export function dropDraft(ctx: AppContext, ownerId: string, id: number, reason: FeedbackReason, note?: string): void {
  const d = getDraftRow(ctx, ownerId, id);
  ctx.db.update(schema.drafts).set({ status: "dropped", updatedAt: Date.now() }).where(eq(schema.drafts.id, id)).run();
  ctx.db.insert(schema.feedback).values({ ownerId, targetType: "draft", targetId: String(id), reason, note: note ?? null, createdAt: Date.now() }).run();
  // 사유별로 갈 곳이 다르다. 문체 → 지침 제안, 사실 틀림 → 원장에 틀림 표시, 글감 아님 → 저장소별 횟수(판단이 읽음).
  if (reason === "voice" || reason === "wrong_channel" || reason === "other") void learnFromEdit(ctx, ownerId, { draftId: id, channel: d.channel, lang: d.lang, before: d.body, dropReason: reason, note });
  if (reason === "wrong_facts") disputeCandidateFacts(ctx, ownerId, d.candidateId);
  emit(ctx, ownerId, { resource: "drafts", id });
}

const toExample = (e: typeof schema.examples.$inferSelect): Example => ({ id: e.id, channel: e.channel as Channel, lang: e.lang, title: e.title ?? undefined, body: e.body, source: e.source as Example["source"], note: e.note ?? undefined, active: e.active, createdAt: e.createdAt });

export function listExamples(ctx: AppContext, ownerId: string, channel?: Channel): Example[] {
  const where = channel ? and(eq(schema.examples.ownerId, ownerId), eq(schema.examples.channel, channel)) : eq(schema.examples.ownerId, ownerId);
  return ctx.db.select().from(schema.examples).where(where).orderBy(desc(schema.examples.createdAt)).all().map(toExample);
}

export function addExample(ctx: AppContext, ownerId: string, input: { channel: Channel; lang: string; title?: string; body: string; note?: string; source?: "seed" | "approved" }): Example {
  const id = Number(ctx.db.insert(schema.examples).values({ ownerId, channel: input.channel, lang: input.lang, title: input.title ?? null, body: input.body, note: input.note ?? null, source: input.source ?? "approved", active: true, createdAt: Date.now() }).run().lastInsertRowid);
  emit(ctx, ownerId, { resource: "examples" });
  return toExample(ctx.db.select().from(schema.examples).where(eq(schema.examples.id, id)).get()!);
}

/** 시드 코퍼스 가져오기. 같은 본문은 다시 넣지 않는다. */
export function importSeeds(ctx: AppContext, ownerId: string, items: { channel: Channel; lang: string; title?: string; body: string; note?: string }[]): number {
  const seen = new Set(ctx.db.select({ body: schema.examples.body }).from(schema.examples).where(eq(schema.examples.ownerId, ownerId)).all().map((r) => r.body));
  let n = 0;
  for (const it of items) {
    if (seen.has(it.body)) continue;
    ctx.db.insert(schema.examples).values({ ownerId, channel: it.channel, lang: it.lang, title: it.title ?? null, body: it.body, note: it.note ?? null, source: "seed", active: true, createdAt: Date.now() }).run();
    seen.add(it.body);
    n++;
  }
  if (n) emit(ctx, ownerId, { resource: "examples" });
  return n;
}

export function setExampleActive(ctx: AppContext, ownerId: string, id: number, active: boolean): void {
  const r = ctx.db.update(schema.examples).set({ active }).where(and(eq(schema.examples.id, id), eq(schema.examples.ownerId, ownerId))).run();
  if (r.changes === 0) throw new NotFoundError("example");
  emit(ctx, ownerId, { resource: "examples" });
}

export function removeExample(ctx: AppContext, ownerId: string, id: number): void {
  const r = ctx.db.delete(schema.examples).where(and(eq(schema.examples.id, id), eq(schema.examples.ownerId, ownerId))).run();
  if (r.changes === 0) throw new NotFoundError("example");
  emit(ctx, ownerId, { resource: "examples" });
}
