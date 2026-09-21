import { and, desc, eq } from "drizzle-orm";
import { markPublished } from "./ledger.js";
import { schema } from "../infra/db/index.js";
import type { PerformanceSummary, Channel, PublicationWithMetrics } from "../shared/types.js";
import { getCandidateRow, toPublication } from "./candidates.js";
import { emit, NotFoundError, type AppContext } from "./context.js";

export function registerPublication(ctx: AppContext, ownerId: string, input: { candidateId: number; draftId?: number; channel: Channel; lang?: string; url: string }): number {
  getCandidateRow(ctx, ownerId, input.candidateId);
  const now = Date.now();
  const id = Number(ctx.db.insert(schema.publications).values({ ownerId, candidateId: input.candidateId, draftId: input.draftId ?? null, channel: input.channel, lang: input.lang ?? null, url: input.url, publishedAt: now }).run().lastInsertRowid);
  ctx.db.update(schema.candidates).set({ status: "published", updatedAt: now }).where(eq(schema.candidates.id, input.candidateId)).run();
  if (input.draftId) ctx.db.update(schema.drafts).set({ status: "copied", updatedAt: now }).where(eq(schema.drafts.id, input.draftId)).run();
  markPublished(ctx, ownerId, input.candidateId, input.channel, now);
  emit(ctx, ownerId, { resource: "publications", id });
  emit(ctx, ownerId, { resource: "candidates", id: input.candidateId });
  return id;
}

export function setManualStats(ctx: AppContext, ownerId: string, id: number, stats: { likes?: number; comments?: number; reposts?: number }): void {
  const r = ctx.db.update(schema.publications).set({ manualStats: stats }).where(and(eq(schema.publications.id, id), eq(schema.publications.ownerId, ownerId))).run();
  if (r.changes === 0) throw new NotFoundError("publication");
  emit(ctx, ownerId, { resource: "publications", id });
}

/** 발행물 + 발행 전 7일 기준선 대비 지표. */
export function listPublicationsWithMetrics(ctx: AppContext, ownerId: string): PublicationWithMetrics[] {
  const pubs = ctx.db.select().from(schema.publications).where(eq(schema.publications.ownerId, ownerId)).orderBy(desc(schema.publications.publishedAt)).limit(100).all();
  const out: PublicationWithMetrics[] = [];
  for (const p of pubs) {
    const c = ctx.db.select().from(schema.candidates).where(eq(schema.candidates.id, p.candidateId)).get();
    if (!c) continue;
    const snaps = ctx.db.select().from(schema.metricSnapshots).where(and(eq(schema.metricSnapshots.ownerId, ownerId), eq(schema.metricSnapshots.repo, c.repo))).orderBy(desc(schema.metricSnapshots.at)).limit(60).all();
    const before = snaps.filter((s) => s.at <= p.publishedAt);
    const after = snaps.filter((s) => s.at > p.publishedAt);
    const voice = p.draftId ? ctx.db.select({ v: schema.drafts.voice }).from(schema.drafts).where(eq(schema.drafts.id, p.draftId)).get()?.v ?? undefined : undefined;
    out.push({ ...toPublication(p), candidateTitle: c.title, repo: c.repo, voice, baselineStars: before[0]?.stars, latestStars: after[0]?.stars ?? snaps[0]?.stars, series: snaps.slice(0, 30).reverse().map((s) => ({ at: s.at, stars: s.stars, uniques: s.viewsUniques14d ?? undefined, downloads: s.npmDownloadsMonth ?? undefined })) });
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

/** 채널·문체별 성과 요약. 발행 7일 뒤 스타 증가와 방문자 평균. */
export function performanceSummary(ctx: AppContext, ownerId: string): PerformanceSummary {
  const pubs = listPublicationsWithMetrics(ctx, ownerId);
  const delta = (p: PublicationWithMetrics) => {
    const after7 = p.series.filter((s) => s.at > p.publishedAt && s.at <= p.publishedAt + 7 * 86400e3).at(-1) ?? p.series.filter((s) => s.at > p.publishedAt).at(-1);
    return after7 && p.baselineStars !== undefined ? after7.stars - p.baselineStars : undefined;
  };
  const uniq = (p: PublicationWithMetrics) => p.series.filter((s) => s.at > p.publishedAt).at(-1)?.uniques;
  const avg = (xs: (number | undefined)[]) => { const v = xs.filter((x): x is number => x !== undefined); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : undefined; };
  const group = <K extends string>(key: (p: PublicationWithMetrics) => K | undefined) => {
    const m = new Map<K, PublicationWithMetrics[]>();
    for (const p of pubs) { const k = key(p); if (k) m.set(k, [...(m.get(k) ?? []), p]); }
    return [...m.entries()].map(([k, ps]) => ({ key: k, count: ps.length, avgStarDelta: avg(ps.map(delta)), avgUniques: avg(ps.map(uniq)) })).sort((a, b) => b.count - a.count);
  };
  return {
    byChannel: group((p) => p.channel).map((g) => ({ ...g, label: g.key })),
    byVoice: group((p) => p.voice ?? "unknown").map(({ key, count, avgStarDelta }) => ({ key, count, avgStarDelta })),
  };
}
