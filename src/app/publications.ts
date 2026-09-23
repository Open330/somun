import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { publicationEffect } from "../core/metrics.js";
import { markPublished, unmarkPublished } from "./ledger.js";
import { refreshPublicationReactions, refreshReactions } from "./reactions.js";
import { schema } from "../infra/db/index.js";
import type { PerformanceSummary, Channel, PublicationWithMetrics } from "../shared/types.js";
import { getCandidateRow, toPublication } from "./candidates.js";
import { emit, NotFoundError, type AppContext } from "./context.js";

export function registerPublication(ctx: AppContext, ownerId: string, input: { candidateId: number; draftId?: number; channel: Channel; lang?: string; url: string }): number {
  getCandidateRow(ctx, ownerId, input.candidateId);
  if (input.draftId !== undefined) {
    const d = ctx.db.select({ id: schema.drafts.id }).from(schema.drafts).where(and(eq(schema.drafts.id, input.draftId), eq(schema.drafts.ownerId, ownerId), eq(schema.drafts.candidateId, input.candidateId))).get();
    if (!d) throw new NotFoundError("draft");
  }
  const now = Date.now();
  const id = Number(ctx.db.insert(schema.publications).values({ ownerId, candidateId: input.candidateId, draftId: input.draftId ?? null, channel: input.channel, lang: input.lang ?? null, url: input.url, publishedAt: now }).run().lastInsertRowid);
  ctx.db.update(schema.candidates).set({ status: "published", updatedAt: now }).where(and(eq(schema.candidates.id, input.candidateId), eq(schema.candidates.ownerId, ownerId))).run();
  if (input.draftId) ctx.db.update(schema.drafts).set({ status: "copied", updatedAt: now }).where(eq(schema.drafts.id, input.draftId)).run();
  markPublished(ctx, ownerId, input.candidateId, input.channel, now);
  channelResultsCache.get(ctx.db)?.delete(ownerId);
  // 등록 직후 한 번 반응을 받아 둔다 (기준선). 실패해도 등록은 된다.
  void refreshReactions(ctx, ownerId, true).catch(() => undefined);
  emit(ctx, ownerId, { resource: "publications", id });
  emit(ctx, ownerId, { resource: "candidates", id: input.candidateId });
  return id;
}

/** 잘못 적은 발행 URL 고치기. 자동 반응은 새 URL로 다시 받는다. */
export function updatePublicationUrl(ctx: AppContext, ownerId: string, id: number, url: string): void {
  const r = ctx.db.update(schema.publications).set({ url, autoStats: null, autoStatsAt: null }).where(and(eq(schema.publications.id, id), eq(schema.publications.ownerId, ownerId))).run();
  if (r.changes === 0) throw new NotFoundError("publication");
  void refreshPublicationReactions(ctx, ownerId, id).catch(() => undefined);
  emit(ctx, ownerId, { resource: "publications", id });
}

/** 발행 기록 지우기. 삭제·원장 되돌림·글감 상태를 한 트랜잭션으로. 남은 발행이 없으면 글감을 초안·판단 유무에 맞는 단계로 되돌린다. */
export function removePublication(ctx: AppContext, ownerId: string, id: number): void {
  const candidateId = ctx.db.$client.transaction(() => {
    const p = ctx.db.select().from(schema.publications).where(and(eq(schema.publications.id, id), eq(schema.publications.ownerId, ownerId))).get();
    if (!p) throw new NotFoundError("publication");
    ctx.db.delete(schema.publications).where(eq(schema.publications.id, id)).run();
    const rest = ctx.db.select().from(schema.publications).where(and(eq(schema.publications.candidateId, p.candidateId), eq(schema.publications.ownerId, ownerId))).orderBy(desc(schema.publications.publishedAt)).get();
    // 원장의 "이미 알림" 표시도 되돌린다. 그대로 두면 판단이 이 변경들을 발행된 것으로 보고 새로움 점수를 깎는다.
    unmarkPublished(ctx, ownerId, p.candidateId, rest ? { channel: rest.channel, publishedAt: rest.publishedAt } : undefined);
    const c = ctx.db.select().from(schema.candidates).where(and(eq(schema.candidates.id, p.candidateId), eq(schema.candidates.ownerId, ownerId))).get();
    if (!rest && c?.status === "published") {
      const hasDraft = ctx.db.select({ id: schema.drafts.id }).from(schema.drafts).where(and(eq(schema.drafts.candidateId, c.id), ne(schema.drafts.status, "dropped"))).get();
      ctx.db.update(schema.candidates).set({ status: hasDraft ? "drafted" : c.latestJudgmentId ? "judged" : "new", updatedAt: Date.now() }).where(eq(schema.candidates.id, c.id)).run();
    }
    return p.candidateId;
  }).immediate();
  channelResultsCache.get(ctx.db)?.delete(ownerId);
  emit(ctx, ownerId, { resource: "publications", id });
  emit(ctx, ownerId, { resource: "candidates", id: candidateId });
}

export function setManualStats(ctx: AppContext, ownerId: string, id: number, stats: { likes?: number; comments?: number; reposts?: number }): void {
  const r = ctx.db.update(schema.publications).set({ manualStats: stats }).where(and(eq(schema.publications.id, id), eq(schema.publications.ownerId, ownerId))).run();
  if (r.changes === 0) throw new NotFoundError("publication");
  emit(ctx, ownerId, { resource: "publications", id });
}

/**
 * 발행물 + 발행 전 7일 추세 대비 지표. 판단 프롬프트를 만들 때마다(쓰기 트랜잭션 안) 불리므로
 * 글감·초안·스냅샷을 발행물마다가 아니라 한 번씩 묶어 읽는다.
 */
export function listPublicationsWithMetrics(ctx: AppContext, ownerId: string): PublicationWithMetrics[] {
  const pubs = ctx.db.select().from(schema.publications).where(eq(schema.publications.ownerId, ownerId)).orderBy(desc(schema.publications.publishedAt)).limit(100).all();
  if (!pubs.length) return [];
  const cands = new Map(ctx.db.select().from(schema.candidates).where(and(eq(schema.candidates.ownerId, ownerId), inArray(schema.candidates.id, [...new Set(pubs.map((p) => p.candidateId))]))).all().map((c) => [c.id, c]));
  const draftIds = pubs.map((p) => p.draftId).filter((x): x is number => x !== null);
  const voices = new Map(draftIds.length ? ctx.db.select({ id: schema.drafts.id, v: schema.drafts.voice }).from(schema.drafts).where(and(eq(schema.drafts.ownerId, ownerId), inArray(schema.drafts.id, draftIds))).all().map((d) => [d.id, d.v]) : []);
  const snapsByRepo = new Map<string, (typeof schema.metricSnapshots.$inferSelect)[]>();
  for (const repo of new Set([...cands.values()].map((c) => c.repo))) {
    snapsByRepo.set(repo, ctx.db.select().from(schema.metricSnapshots).where(and(eq(schema.metricSnapshots.ownerId, ownerId), eq(schema.metricSnapshots.repo, repo))).orderBy(desc(schema.metricSnapshots.at)).limit(60).all());
  }
  const out: PublicationWithMetrics[] = [];
  for (const p of pubs) {
    const c = cands.get(p.candidateId);
    if (!c) continue;
    const snaps = snapsByRepo.get(c.repo) ?? [];
    const before = snaps.filter((s) => s.at <= p.publishedAt);
    const after = snaps.filter((s) => s.at > p.publishedAt);
    const voice = p.draftId ? voices.get(p.draftId) ?? undefined : undefined;
    const effect = publicationEffect(snaps, p.publishedAt);
    out.push({ ...toPublication(p), candidateTitle: c.title, repo: c.repo, voice, baselineStars: before[0]?.stars, latestStars: after[0]?.stars ?? snaps[0]?.stars, starDelta7d: effect.observed, expectedStarDelta7d: effect.expected, excessStars7d: effect.excess, series: snaps.slice(0, 30).reverse().map((s) => ({ at: s.at, stars: s.stars, uniques: s.viewsUniques14d ?? undefined, downloads: s.npmDownloadsMonth ?? undefined })) });
  }
  return out;
}

/** 하루 한 번 스냅샷. 20시간 안이면 덮어쓴다. */
export function snapshotMetrics(ctx: AppContext, ownerId: string, m: { repo: string; stars: number; forks: number; viewsUniques14d?: number; referrers?: { referrer: string; uniques: number }[]; npmDownloadsMonth?: number }): void {
  const last = ctx.db.select().from(schema.metricSnapshots).where(and(eq(schema.metricSnapshots.ownerId, ownerId), eq(schema.metricSnapshots.repo, m.repo))).orderBy(desc(schema.metricSnapshots.at)).get();
  const values = { ownerId, repo: m.repo, stars: m.stars, forks: m.forks, viewsUniques14d: m.viewsUniques14d ?? null, referrers: m.referrers ?? null, npmDownloadsMonth: m.npmDownloadsMonth ?? null };
  if (last && Date.now() - last.at < 20 * 3600 * 1000) ctx.db.update(schema.metricSnapshots).set(values).where(eq(schema.metricSnapshots.id, last.id)).run();
  else ctx.db.insert(schema.metricSnapshots).values({ ...values, at: Date.now() }).run();
}

export function lastSnapshot(ctx: AppContext, ownerId: string, repo: string) {
  return ctx.db.select().from(schema.metricSnapshots).where(and(eq(schema.metricSnapshots.ownerId, ownerId), eq(schema.metricSnapshots.repo, repo))).orderBy(desc(schema.metricSnapshots.at)).get();
}

/** 채널·문체별 성과 요약. 발행 7일 뒤 스타 증가, 발행 전 추세를 뺀 증가, 방문자·반응 평균. */
export function performanceSummary(ctx: AppContext, ownerId: string): PerformanceSummary {
  const pubs = listPublicationsWithMetrics(ctx, ownerId);
  const delta = (p: PublicationWithMetrics) => p.starDelta7d;
  const excess = (p: PublicationWithMetrics) => p.excessStars7d;
  const uniq = (p: PublicationWithMetrics) => p.series.filter((s) => s.at > p.publishedAt).at(-1)?.uniques;
  const likes = (p: PublicationWithMetrics) => p.autoStats?.likes ?? p.manualStats?.likes;
  const avg = (xs: (number | undefined)[]) => { const v = xs.filter((x): x is number => x !== undefined); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : undefined; };
  const group = <K extends string>(key: (p: PublicationWithMetrics) => K | undefined) => {
    const m = new Map<K, PublicationWithMetrics[]>();
    for (const p of pubs) { const k = key(p); if (k) m.set(k, [...(m.get(k) ?? []), p]); }
    return [...m.entries()].map(([k, ps]) => ({ key: k, count: ps.length, avgStarDelta: avg(ps.map(delta)), avgExcessStars: avg(ps.map(excess)), avgUniques: avg(ps.map(uniq)), avgLikes: avg(ps.map(likes)) })).sort((a, b) => b.count - a.count);
  };
  return {
    byChannel: group((p) => p.channel).map((g) => ({ ...g, label: g.key })),
    byVoice: group((p) => p.voice ?? "unknown").map(({ key, count, avgStarDelta, avgExcessStars, avgLikes }) => ({ key, count, avgStarDelta, avgExcessStars, avgLikes })),
  };
}

/** 채널 성과는 하루 단위로 바뀐다. 판단 프롬프트마다(쓰기 트랜잭션 안) 다시 계산하지 않고 소유자별로 잠시 둔다. */
const CHANNEL_RESULTS_TTL_MS = 30 * 60_000;
const channelResultsCache = new WeakMap<AppContext["db"], Map<string, { at: number; lines: string[] }>>();

/** 판단 프롬프트에 넣는 채널별 지난 성과. 발행이 2건 이상인 채널만. 추천 채널을 고를 때 참고한다. */
export function channelResultsForJudge(ctx: AppContext, ownerId: string): string[] {
  const cache = channelResultsCache.get(ctx.db) ?? new Map<string, { at: number; lines: string[] }>();
  channelResultsCache.set(ctx.db, cache);
  const hit = cache.get(ownerId);
  if (hit && Date.now() - hit.at < CHANNEL_RESULTS_TTL_MS) return hit.lines;
  const lines = computeChannelResults(ctx, ownerId);
  cache.set(ownerId, { at: Date.now(), lines });
  return lines;
}

function computeChannelResults(ctx: AppContext, ownerId: string): string[] {
  return performanceSummary(ctx, ownerId).byChannel.filter((g) => g.count >= 2).map((g) => [
    `${g.key}: ${g.count} posts`,
    g.avgExcessStars !== undefined ? `avg ${g.avgExcessStars > 0 ? "+" : ""}${g.avgExcessStars} stars beyond the prior trend in 7 days` : g.avgStarDelta !== undefined ? `avg +${g.avgStarDelta} stars in 7 days (no prior trend)` : "",
    g.avgLikes !== undefined ? `avg ${g.avgLikes} reactions` : "",
  ].filter(Boolean).join(", "));
}
