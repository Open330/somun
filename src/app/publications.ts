import { and, desc, eq, gt, inArray, isNotNull, ne } from "drizzle-orm";
import { publicationEffect } from "../core/metrics.js";
import { markPublished, unmarkPublished } from "./ledger.js";
import { refreshPublicationReactions, refreshReactions } from "./reactions.js";
import { schema } from "../infra/db/index.js";
import type { PerformanceSummary, Channel, PublicationWithMetrics } from "../shared/types.js";
import { getCandidateRow, toPublication } from "./candidates.js";
import { emit, InvalidInputError, NotFoundError, type AppContext } from "./context.js";
import { publicationChannel } from "../core/publication-url.js";
import { CHANNELS } from "../core/channels.js";
import { localeOf, say } from "./i18n.js";

function validateUrl(ctx: AppContext, ownerId: string, channel: Channel, url: string): void {
  const actual = publicationChannel(url);
  if (actual && actual !== channel) throw new InvalidInputError(say(localeOf(ctx, ownerId), `이 링크는 ${CHANNELS[actual].label} 주소입니다. ${CHANNELS[channel].label} 게시글 링크를 입력하거나 해당 채널에서 등록해 주세요.`, `This is a ${CHANNELS[actual].label} URL. Enter a ${CHANNELS[channel].label} post URL or register it under the matching channel.`));
}

/**
 * 이 저장소를 한 번이라도 알렸는가. 없으면 다음 글은 첫 소개다.
 * 게시 URL을 등록하지 않고 복사해서 직접 올리는 사용자가 많다. 초안을 복사한 적이 있으면 알린 것으로 본다.
 * 그렇지 않으면 이 사용자의 모든 글이 영원히 첫 소개가 되어 실제 변경점을 다루지 못한다.
 */
export function hasAnnounced(ctx: AppContext, ownerId: string, repo: string): boolean {
  return lastAnnouncedAt(ctx, ownerId, repo) !== undefined;
}

/** 이 저장소를 마지막으로 알린 시각(게시 등록 또는 초안 복사). channel을 주면 그 채널에서 알린 것만 본다. 알린 적이 없으면 undefined. */
export function lastAnnouncedAt(ctx: AppContext, ownerId: string, repo: string, channel?: string): number | undefined {
  const published = ctx.db.select({ at: schema.publications.publishedAt }).from(schema.publications).innerJoin(schema.candidates, eq(schema.candidates.id, schema.publications.candidateId))
    .where(and(eq(schema.publications.ownerId, ownerId), eq(schema.candidates.repo, repo), channel ? eq(schema.publications.channel, channel) : undefined)).orderBy(desc(schema.publications.publishedAt)).get()?.at;
  const copied = ctx.db.select({ at: schema.drafts.copiedAt }).from(schema.drafts).innerJoin(schema.candidates, eq(schema.candidates.id, schema.drafts.candidateId))
    .where(and(eq(schema.drafts.ownerId, ownerId), eq(schema.candidates.repo, repo), isNotNull(schema.drafts.copiedAt), channel ? eq(schema.drafts.channel, channel) : undefined)).orderBy(desc(schema.drafts.copiedAt)).get()?.at ?? undefined;
  const times = [published, copied].filter((t): t is number => typeof t === "number");
  return times.length ? Math.max(...times) : undefined;
}

export function registerPublication(ctx: AppContext, ownerId: string, input: { candidateId: number; draftId?: number; channel: Channel; lang?: string; url: string }): number {
  getCandidateRow(ctx, ownerId, input.candidateId);
  validateUrl(ctx, ownerId, input.channel, input.url);
  let introduction = false;
  if (input.draftId !== undefined) {
    const d = ctx.db.select({ id: schema.drafts.id, purpose: schema.drafts.purpose }).from(schema.drafts).where(and(eq(schema.drafts.id, input.draftId), eq(schema.drafts.ownerId, ownerId), eq(schema.drafts.candidateId, input.candidateId))).get();
    if (!d) throw new NotFoundError("draft");
    introduction = d.purpose === "introduction";
  }
  const now = Date.now();
  const id = Number(ctx.db.insert(schema.publications).values({ ownerId, candidateId: input.candidateId, draftId: input.draftId ?? null, channel: input.channel, lang: input.lang ?? null, url: input.url, publishedAt: now }).run().lastInsertRowid);
  ctx.db.update(schema.candidates).set({ status: "published", updatedAt: now }).where(and(eq(schema.candidates.id, input.candidateId), eq(schema.candidates.ownerId, ownerId))).run();
  if (!introduction) markPublished(ctx, ownerId, input.candidateId, input.channel, now);
  channelResultsCache.get(ctx.db)?.delete(ownerId);
  // 등록 직후 한 번 반응을 받아 둔다 (기준선). 실패해도 등록은 된다.
  void refreshReactions(ctx, ownerId, true).catch(() => undefined);
  emit(ctx, ownerId, { resource: "publications", id });
  emit(ctx, ownerId, { resource: "candidates", id: input.candidateId });
  return id;
}

/** 잘못 적은 발행 URL 고치기. 자동 반응은 새 URL로 다시 받는다. */
export function updatePublicationUrl(ctx: AppContext, ownerId: string, id: number, url: string): void {
  const publication = ctx.db.select().from(schema.publications).where(and(eq(schema.publications.id, id), eq(schema.publications.ownerId, ownerId))).get();
  if (!publication) throw new NotFoundError("publication");
  validateUrl(ctx, ownerId, publication.channel as Channel, url);
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
    const changePost = ctx.db.select({ channel: schema.publications.channel, publishedAt: schema.publications.publishedAt, purpose: schema.drafts.purpose }).from(schema.publications)
      .leftJoin(schema.drafts, and(eq(schema.drafts.id, schema.publications.draftId), eq(schema.drafts.ownerId, ownerId)))
      .where(and(eq(schema.publications.candidateId, p.candidateId), eq(schema.publications.ownerId, ownerId)))
      .orderBy(desc(schema.publications.publishedAt)).all().find((post) => post.purpose !== "introduction");
    unmarkPublished(ctx, ownerId, p.candidateId, changePost);
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
    const sharedWith = pubs.filter((o) => o.id !== p.id && cands.get(o.candidateId)?.repo === c.repo && Math.abs(o.publishedAt - p.publishedAt) < 7 * 86400e3).length;
    out.push({ ...toPublication(p), ...(sharedWith ? { sharedWith } : {}), candidateTitle: c.title, repo: c.repo, voice, baselineStars: before[0]?.stars, latestStars: after[0]?.stars ?? snaps[0]?.stars, starDelta7d: effect.observed, expectedStarDelta7d: effect.expected, excessStars7d: effect.excess, series: snaps.slice(0, 30).reverse().map((s) => ({ at: s.at, stars: s.stars, uniques: s.viewsUniques14d ?? undefined, downloads: s.npmDownloadsMonth ?? undefined })) });
  }
  return out;
}

/**
 * 하루 한 번 스냅샷. 20시간 안이면 덮어쓴다.
 * 단, 마지막 스냅샷 뒤에 이 저장소의 글을 올렸다면 덮어쓰지 않고 새로 남긴다. 덮어쓰면 발행 전 기준값이
 * 발행 뒤 값으로 바뀌어(스타 webhook마다 수집이 다시 돈다) 발행 효과가 기준선과 추세에 흡수된다.
 */
export function snapshotMetrics(ctx: AppContext, ownerId: string, m: { repo: string; stars: number; forks: number; viewsUniques14d?: number; referrers?: { referrer: string; uniques: number }[]; npmDownloadsMonth?: number }, now = Date.now()): void {
  const last = ctx.db.select().from(schema.metricSnapshots).where(and(eq(schema.metricSnapshots.ownerId, ownerId), eq(schema.metricSnapshots.repo, m.repo))).orderBy(desc(schema.metricSnapshots.at)).get();
  const values = { ownerId, repo: m.repo, stars: m.stars, forks: m.forks, viewsUniques14d: m.viewsUniques14d ?? null, referrers: m.referrers ?? null, npmDownloadsMonth: m.npmDownloadsMonth ?? null };
  const postedSince = last && Boolean(ctx.db.select({ id: schema.publications.id }).from(schema.publications).innerJoin(schema.candidates, eq(schema.candidates.id, schema.publications.candidateId))
    .where(and(eq(schema.publications.ownerId, ownerId), eq(schema.candidates.repo, m.repo), gt(schema.publications.publishedAt, last.at))).get());
  if (last && now - last.at < 20 * 3600 * 1000 && !postedSince) ctx.db.update(schema.metricSnapshots).set(values).where(eq(schema.metricSnapshots.id, last.id)).run();
  else ctx.db.insert(schema.metricSnapshots).values({ ...values, at: now }).run();
}

export function lastSnapshot(ctx: AppContext, ownerId: string, repo: string) {
  return ctx.db.select().from(schema.metricSnapshots).where(and(eq(schema.metricSnapshots.ownerId, ownerId), eq(schema.metricSnapshots.repo, repo))).orderBy(desc(schema.metricSnapshots.at)).get();
}

/** 채널·문체별 성과 요약. 발행 7일 뒤 스타 증가, 발행 전 추세를 뺀 증가, 방문자·반응 평균. */
export function performanceSummary(ctx: AppContext, ownerId: string): PerformanceSummary {
  const pubs = listPublicationsWithMetrics(ctx, ownerId);
  // 같은 저장소에 비슷한 때 여러 채널로 올리면 스타 증가는 하나다. 글마다 전부 주면 모든 채널이 같은 성과로 보인다. 나눠서 센다.
  const share = (p: PublicationWithMetrics, v: number | undefined) => (v === undefined ? undefined : v / (1 + (p.sharedWith ?? 0)));
  const delta = (p: PublicationWithMetrics) => share(p, p.starDelta7d);
  const excess = (p: PublicationWithMetrics) => share(p, p.excessStars7d);
  const uniq = (p: PublicationWithMetrics) => p.series.filter((s) => s.at > p.publishedAt).at(-1)?.uniques;
  const likes = (p: PublicationWithMetrics) => p.autoStats?.likes ?? p.manualStats?.likes;
  const avg = (xs: (number | undefined)[]) => { const v = xs.filter((x): x is number => x !== undefined); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : undefined; };
  const group = <K extends string>(key: (p: PublicationWithMetrics) => K | undefined) => {
    const m = new Map<K, PublicationWithMetrics[]>();
    for (const p of pubs) { const k = key(p); if (k) m.set(k, [...(m.get(k) ?? []), p]); }
    return [...m.entries()].map(([k, ps]) => ({ key: k, count: ps.length, measured: ps.filter((p) => p.starDelta7d !== undefined).length, avgStarDelta: avg(ps.map(delta)), avgExcessStars: avg(ps.map(excess)), avgUniques: avg(ps.map(uniq)), avgLikes: avg(ps.map(likes)) })).sort((a, b) => b.count - a.count);
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
  // 표본 기준은 스타 수치가 있는 글 수다. 글이 셋이어도 수치가 하나뿐이면 평균이 그 하나다.
  return performanceSummary(ctx, ownerId).byChannel.filter((g) => (g.measured ?? 0) >= 2).map((g) => [
    `${g.key}: ${g.count} posts (${g.measured} with star data; gains split across same-repo posts within 7 days)`,
    g.avgExcessStars !== undefined ? `avg ${g.avgExcessStars > 0 ? "+" : ""}${g.avgExcessStars} stars beyond the prior trend in 7 days` : g.avgStarDelta !== undefined ? `avg +${g.avgStarDelta} stars in 7 days (no prior trend)` : "",
    g.avgLikes !== undefined ? `avg ${g.avgLikes} reactions` : "",
  ].filter(Boolean).join(", "));
}
