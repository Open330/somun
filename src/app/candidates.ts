import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { schema } from "../infra/db/index.js";
import type { Candidate, CandidateDetail, CandidateListItem, CandidateStatus, Channel, Decision, Draft, Evidence, FeedbackReason, Judgment, Publication, SignalKind } from "../shared/types.js";
import { emit, NotFoundError, type AppContext } from "./context.js";

const DAY = 24 * 3600 * 1000;

export const toCandidate = (r: typeof schema.candidates.$inferSelect): Candidate => ({ id: r.id, type: r.type as Candidate["type"], title: r.title, repo: r.repo, key: r.key, evidence: r.evidence as Evidence, status: r.status as CandidateStatus, latestJudgmentId: r.latestJudgmentId ?? undefined, createdAt: r.createdAt, updatedAt: r.updatedAt });
export const toJudgment = (r: typeof schema.judgments.$inferSelect): Judgment => ({ id: r.id, candidateId: r.candidateId, scores: r.scores as Judgment["scores"], total: r.total, reasoning: r.reasoning, decision: r.decision as Decision, suggestedChannels: r.suggestedChannels as Channel[], model: r.model, overriddenDecision: (r.overriddenDecision as "draft" | "drop" | null) ?? undefined, overrideReason: r.overrideReason ?? undefined, createdAt: r.createdAt });
export const toDraft = (r: typeof schema.drafts.$inferSelect): Draft => ({ id: r.id, candidateId: r.candidateId, channel: r.channel as Channel, lang: r.lang, version: r.version, title: r.title ?? undefined, body: r.body, mediaHint: r.mediaHint ?? undefined, lint: r.lint, status: r.status as Draft["status"], model: r.model, createdAt: r.createdAt, updatedAt: r.updatedAt });
export const toPublication = (r: typeof schema.publications.$inferSelect): Publication => ({ id: r.id, candidateId: r.candidateId, draftId: r.draftId ?? undefined, channel: r.channel as Channel, lang: r.lang ?? undefined, url: r.url, publishedAt: r.publishedAt, manualStats: r.manualStats ?? undefined });

export function getCandidateRow(ctx: AppContext, ownerId: string, id: number) {
  const row = ctx.db.select().from(schema.candidates).where(and(eq(schema.candidates.id, id), eq(schema.candidates.ownerId, ownerId))).get();
  if (!row) throw new NotFoundError("candidate");
  return row;
}

export function listInbox(ctx: AppContext, ownerId: string): CandidateListItem[] {
  const rows = ctx.db.select().from(schema.candidates).where(eq(schema.candidates.ownerId, ownerId)).orderBy(desc(schema.candidates.updatedAt)).limit(200).all();
  const jids = rows.map((r) => r.latestJudgmentId).filter((x): x is number => x !== null);
  const js = jids.length ? ctx.db.select().from(schema.judgments).where(inArray(schema.judgments.id, jids)).all() : [];
  const byId = new Map(js.map((j) => [j.id, toJudgment(j)]));
  return rows.map((r) => ({ ...toCandidate(r), judgment: r.latestJudgmentId ? byId.get(r.latestJudgmentId) ?? null : null }));
}

export function getCandidateDetail(ctx: AppContext, ownerId: string, id: number): CandidateDetail {
  const c = getCandidateRow(ctx, ownerId, id);
  const judgments = ctx.db.select().from(schema.judgments).where(eq(schema.judgments.candidateId, id)).orderBy(desc(schema.judgments.createdAt)).all().map(toJudgment);
  const drafts = ctx.db.select().from(schema.drafts).where(eq(schema.drafts.candidateId, id)).all().map(toDraft);
  const publications = ctx.db.select().from(schema.publications).where(eq(schema.publications.candidateId, id)).all().map(toPublication);
  const signals = ctx.db.select().from(schema.signals).where(eq(schema.signals.candidateId, id)).orderBy(desc(schema.signals.occurredAt)).limit(30).all().map((s) => ({ id: s.id, kind: s.kind as SignalKind, title: s.title, occurredAt: s.occurredAt }));
  return { candidate: toCandidate(c), judgments, drafts, publications, signals };
}

export function setCandidateStatus(ctx: AppContext, ownerId: string, id: number, status: CandidateStatus): void {
  getCandidateRow(ctx, ownerId, id);
  ctx.db.update(schema.candidates).set({ status, updatedAt: Date.now() }).where(eq(schema.candidates.id, id)).run();
  emit(ctx, ownerId, { resource: "candidates", id });
}

/** 판단 오버라이드. 사유는 feedback에 남아 다음 판단 프롬프트에 들어간다. */
export function overrideJudgment(ctx: AppContext, ownerId: string, id: number, decision: "draft" | "drop", reason: FeedbackReason, note?: string): void {
  const c = getCandidateRow(ctx, ownerId, id);
  if (c.latestJudgmentId) ctx.db.update(schema.judgments).set({ overriddenDecision: decision, overrideReason: note ?? reason }).where(eq(schema.judgments.id, c.latestJudgmentId)).run();
  ctx.db.insert(schema.feedback).values({ ownerId, targetType: "judgment", targetId: String(c.latestJudgmentId ?? id), reason, note: note ?? null, createdAt: Date.now() }).run();
  ctx.db.update(schema.candidates).set({ status: decision === "drop" ? "dropped" : "judged", updatedAt: Date.now() }).where(eq(schema.candidates.id, id)).run();
  emit(ctx, ownerId, { resource: "candidates", id });
}

export function listByStatus(ctx: AppContext, status: CandidateStatus, ownerId?: string) {
  const where = ownerId ? and(eq(schema.candidates.status, status), eq(schema.candidates.ownerId, ownerId)) : eq(schema.candidates.status, status);
  return ctx.db.select().from(schema.candidates).where(where).all();
}

export function recentPublishedTitles(ctx: AppContext, ownerId: string, days: number): string[] {
  const since = Date.now() - days * DAY;
  const pubs = ctx.db.select().from(schema.publications).where(and(eq(schema.publications.ownerId, ownerId), gte(schema.publications.publishedAt, since))).all();
  return pubs.map((p) => {
    const c = ctx.db.select().from(schema.candidates).where(eq(schema.candidates.id, p.candidateId)).get();
    return c ? `${c.title} (${p.channel})` : null;
  }).filter((x): x is string => Boolean(x));
}

/** 수집마다 열린 후보의 기본 사실을 최신으로. 다이제스트·omp 요약은 지우지 않는다. */
export function refreshEvidence(ctx: AppContext, ownerId: string, repo: string, incoming: Evidence): number {
  const rows = ctx.db.select().from(schema.candidates).where(and(eq(schema.candidates.ownerId, ownerId), eq(schema.candidates.repo, repo))).all();
  let n = 0;
  for (const c of rows) {
    if (["dropped", "published"].includes(c.status)) continue;
    const cur = c.evidence as Evidence;
    const limitations = cur.limitations?.length && !incoming.limitations?.length ? cur.limitations : incoming.limitations;
    const merged: Evidence = { ...cur, ...incoming, limitations, highlights: cur.highlights, highlightsAt: cur.highlightsAt, ompSummary: cur.ompSummary ?? incoming.ompSummary };
    ctx.db.update(schema.candidates).set({ evidence: merged as Record<string, unknown> }).where(eq(schema.candidates.id, c.id)).run();
    n++;
  }
  return n;
}

/** 같은 저장소의 열린 릴리스 후보(10일 내)를 하나로. 초안이 많은 것을 남기고 최신 태그로 이름을 바꾼다. */
export function mergeOpenReleases(ctx: AppContext, ownerId: string, repo: string): number {
  const rows = ctx.db.select().from(schema.candidates).where(and(eq(schema.candidates.ownerId, ownerId), eq(schema.candidates.repo, repo), eq(schema.candidates.type, "release"))).all()
    .filter((c) => !["dropped", "published"].includes(c.status) && Date.now() - c.createdAt < 10 * DAY);
  if (rows.length < 2) return 0;
  const counted = rows.map((c) => ({ c, drafts: ctx.db.select().from(schema.drafts).where(eq(schema.drafts.candidateId, c.id)).all().length }));
  counted.sort((a, b) => b.drafts - a.drafts || b.c.createdAt - a.c.createdAt);
  const keeper = counted[0].c;
  const newestTag = rows.map((c) => c.key.split("@")[1] ?? "").sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  for (const { c } of counted.slice(1)) {
    ctx.db.update(schema.signals).set({ candidateId: keeper.id }).where(eq(schema.signals.candidateId, c.id)).run();
    ctx.db.delete(schema.judgments).where(eq(schema.judgments.candidateId, c.id)).run();
    ctx.db.delete(schema.llmJobs).where(eq(schema.llmJobs.candidateId, c.id)).run();
    ctx.db.delete(schema.candidates).where(eq(schema.candidates.id, c.id)).run();
  }
  if (newestTag) ctx.db.update(schema.candidates).set({ title: `${repo} ${newestTag}`, key: `release:${repo}@${newestTag}`, updatedAt: Date.now() }).where(eq(schema.candidates.id, keeper.id)).run();
  emit(ctx, ownerId, { resource: "candidates" });
  return counted.length - 1;
}
