import { and, asc, desc, eq } from "drizzle-orm";
import { editRatio } from "../core/metrics.js";
import type { Channel } from "../core/channels.js";
import { draftLintFacts, lintDraft } from "../core/lint.js";
import { schema } from "../infra/db/index.js";
import type { Draft, Evidence, Example, FeedbackReason } from "../shared/types.js";
import { toDraft } from "./candidates.js";
import { emit, GenerationConflictError, NotFoundError, type AppContext } from "./context.js";
import { getProfile } from "./profiles.js";
import { getSettings } from "./settings.js";
import { say } from "./i18n.js";
import { disputeCandidateFacts, queueLesson } from "./learning.js";

/** 검수 루프: 복사/수정/버림이 문체 예시와 피드백을 만든다. */

function getDraftRow(ctx: AppContext, ownerId: string, id: number) {
  const d = ctx.db.select().from(schema.drafts).where(and(eq(schema.drafts.id, id), eq(schema.drafts.ownerId, ownerId))).get();
  if (!d) throw new NotFoundError("draft");
  return d;
}

/** 채널·언어별로 프롬프트 후보가 되는 내 예시 수. 오래된 것부터 물러난다. */
export const OWN_EXAMPLE_CAP = 8;
/** 경고된 근거·표현 오류가 문체 예시로 굳지 않게 한다. 복사 사실과 수정량은 별도로 기록한다. */
const EXAMPLE_GATE = new Set(["banned_phrases", "no_emoji_bullets", "no_placeholder", "numbers_need_review", "claims_need_review", "author_role_need_review", "no_invented_limit", "repo_name", "mixed_korean_terms"]);

/** 사용자 예시가 채널당 5개 쌓이면 시드는 비활성화. 내 예시는 최근 OWN_EXAMPLE_CAP개만 활성. */
function retireSeeds(ctx: AppContext, ownerId: string, channel: string, lang: string) {
  const active = ctx.db.select().from(schema.examples).where(and(eq(schema.examples.ownerId, ownerId), eq(schema.examples.channel, channel), eq(schema.examples.lang, lang), eq(schema.examples.active, true))).orderBy(desc(schema.examples.createdAt), desc(schema.examples.id)).all();
  const own = active.filter((e) => e.source !== "seed");
  // 상한은 복사로 생긴 예시에만. 손으로 추가했거나 다시 켠 예시는 사용자가 정한 것이라 끄지 않는다.
  const retire = [...(own.length >= 5 ? active.filter((e) => e.source === "seed") : []), ...own.filter((e) => e.draftId !== null).slice(OWN_EXAMPLE_CAP)];
  for (const e of retire) ctx.db.update(schema.examples).set({ active: false }).where(eq(schema.examples.id, e.id)).run();
}

/** 복사한 초안 하나 = 내 예시 하나. 다시 복사하면 같은 예시를 최신 본문으로 바꾼다. */
function upsertOwnExample(ctx: AppContext, ownerId: string, d: { id: number; channel: string; lang: string; candidateId: number; version: number }, input: { title?: string; body: string }, source: "approved" | "edited", now: number) {
  const existing = ctx.db.select({ id: schema.examples.id }).from(schema.examples).where(and(eq(schema.examples.ownerId, ownerId), eq(schema.examples.draftId, d.id))).get();
  if (existing) ctx.db.update(schema.examples).set({ title: input.title ?? null, body: input.body, source, active: true, createdAt: now }).where(eq(schema.examples.id, existing.id)).run();
  else ctx.db.insert(schema.examples).values({ ownerId, channel: d.channel, lang: d.lang, title: input.title ?? null, body: input.body, source, note: `candidate ${d.candidateId} v${d.version}`, draftId: d.id, active: true, createdAt: now }).run();
  retireSeeds(ctx, ownerId, d.channel, d.lang);
}

/**
 * 초안 저장. 수정이면 diff를 남기고 규칙 뽑기를 큐에 넣는다.
 * 문체 예시는 "복사"한 글만 된다: 쓰지 않은 중간 수정은 예시가 아니다. 금지 표현 등 기본 규칙을 어긴 글도 예시로 쓰지 않는다.
 * base는 편집을 시작할 때 본 본문이다. 그사이 다른 탭에서 본문이 바뀌었으면 덮어쓰지 않고 충돌로 돌려준다.
 */
export function saveDraftEdit(ctx: AppContext, ownerId: string, id: number, input: { title?: string; body: string; markCopied: boolean; base?: { title?: string; body: string } }): Draft {
  const d = getDraftRow(ctx, ownerId, id);
  const settings = getSettings(ctx, ownerId);
  if (input.base && (input.base.body !== d.body || (input.base.title ?? "") !== (d.title ?? ""))) throw new GenerationConflictError(say(settings.ui?.locale ?? "ko", "편집하는 사이 다른 곳에서 이 초안이 먼저 저장되었습니다.", "This draft was saved elsewhere while you were editing."));
  const changed = d.body !== input.body || (d.title ?? "") !== (input.title ?? "");
  const now = Date.now();
  const cand = ctx.db.select().from(schema.candidates).where(and(eq(schema.candidates.id, d.candidateId), eq(schema.candidates.ownerId, ownerId))).get();
  const lint = lintDraft(d.channel as Channel, input.title, input.body, settings.bannedPhrases, cand ? draftLintFacts({ title: cand.title, type: cand.type, evidence: cand.evidence as Evidence }, getProfile(ctx, ownerId, cand.repo)?.profile, d.purpose as "introduction" | "update" | null) : {}, settings.ui?.locale);
  if (changed) {
    ctx.db.insert(schema.draftEdits).values({ ownerId, draftId: id, channel: d.channel, before: d.body, after: input.body, createdAt: now }).run();
    queueLesson(ctx, ownerId, { draftId: id, candidateId: d.candidateId, channel: d.channel, lang: d.lang, before: d.body, after: input.body });
  }
  const status = input.markCopied ? "copied" : changed ? "edited" : d.status;
  // 복사할 때 "생성 원문 → 복사본" 수정량을 한 번 재 둔다(학습 효과 지표). 원문은 첫 수정 기록의 before, 없으면 지금 본문.
  const original = input.markCopied ? ctx.db.select({ before: schema.draftEdits.before }).from(schema.draftEdits).where(eq(schema.draftEdits.draftId, id)).orderBy(asc(schema.draftEdits.createdAt), asc(schema.draftEdits.id)).get()?.before ?? d.body : undefined;
  ctx.db.update(schema.drafts).set({ title: input.title ?? null, body: input.body, lint, status, updatedAt: now, ...(original !== undefined ? { editRatio: editRatio(original, input.body), copiedAt: now } : {}) }).where(eq(schema.drafts.id, id)).run();
  if (input.markCopied && lint.filter((r) => EXAMPLE_GATE.has(r.rule)).every((r) => r.ok)) {
    upsertOwnExample(ctx, ownerId, d, input, original !== d.body || changed ? "edited" : "approved", now);
    emit(ctx, ownerId, { resource: "examples" });
  }
  emit(ctx, ownerId, { resource: "drafts", id });
  return toDraft(getDraftRow(ctx, ownerId, id));
}

export function dropDraft(ctx: AppContext, ownerId: string, id: number, reason: FeedbackReason, note?: string): void {
  const d = getDraftRow(ctx, ownerId, id);
  ctx.db.update(schema.drafts).set({ status: "dropped", updatedAt: Date.now() }).where(eq(schema.drafts.id, id)).run();
  ctx.db.insert(schema.feedback).values({ ownerId, targetType: "draft", targetId: String(id), reason, note: note ?? null, createdAt: Date.now() }).run();
  // 사유별로 갈 곳이 다르다. 문체 → 지침 제안, 사실 틀림 → 원장에 틀림 표시, 글감 아님 → 저장소별 횟수(판단이 읽음).
  if (reason === "voice" || reason === "wrong_channel" || reason === "other") queueLesson(ctx, ownerId, { draftId: id, candidateId: d.candidateId, channel: d.channel, lang: d.lang, before: d.body, dropReason: reason, note });
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
