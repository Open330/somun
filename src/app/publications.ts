import { and, desc, eq, gt, inArray, ne } from "drizzle-orm";
import { publicationEffect } from "../core/metrics.js";
import { unmarkPublished } from "./ledger.js";
import { refreshPublicationReactions, refreshReactions } from "./reactions.js";
import { schema } from "../infra/db/index.js";
import type { PerformanceSummary, Channel, PublicationStats, PublicationWithMetrics } from "../shared/types.js";
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
 * URL 유무와 관계없이 사용자가 확인한 게시만 센다. 복사는 게시의 증거가 아니다.
 */
export function hasAnnounced(ctx: AppContext, ownerId: string, repo: string, channel?: string): boolean {
  return lastAnnouncedAt(ctx, ownerId, repo, channel) !== undefined;
}

/** 이 저장소를 마지막으로 게시했다고 확인한 시각. channel을 주면 그 채널의 이력만 본다. */
export function lastAnnouncedAt(ctx: AppContext, ownerId: string, repo: string, channel?: string): number | undefined {
  const published = ctx.db.select({ at: schema.publications.publishedAt }).from(schema.publications).innerJoin(schema.candidates, eq(schema.candidates.id, schema.publications.candidateId))
    .where(and(eq(schema.publications.ownerId, ownerId), eq(schema.candidates.repo, repo), channel ? eq(schema.publications.channel, channel) : undefined)).orderBy(desc(schema.publications.publishedAt)).get()?.at;
  return published;
}

/** 등록 순서가 아닌 실제 게시 시각으로 변경 원장의 마지막 발행을 맞춘다. 소개는 변경 발행이 아니다. */
function syncPublishedChanges(ctx: AppContext, ownerId: string, candidateId: number): void {
  const changePost = ctx.db.select({ channel: schema.publications.channel, publishedAt: schema.publications.publishedAt, purpose: schema.drafts.purpose }).from(schema.publications)
    .leftJoin(schema.drafts, and(eq(schema.drafts.id, schema.publications.draftId), eq(schema.drafts.ownerId, ownerId)))
    .where(and(eq(schema.publications.ownerId, ownerId), eq(schema.publications.candidateId, candidateId)))
    .orderBy(desc(schema.publications.publishedAt)).all().find((p) => p.purpose !== "introduction");
  unmarkPublished(ctx, ownerId, candidateId, changePost);
}

function validatePublishedAt(ctx: AppContext, ownerId: string, at: number): void {
  if (!Number.isSafeInteger(at) || at <= 0 || at > Date.now()) throw new InvalidInputError(say(localeOf(ctx, ownerId), "실제 게시 시각을 입력해 주세요. 미래 시각은 사용할 수 없습니다.", "Enter the actual publication time. Future times are not allowed."));
}

export function registerPublication(ctx: AppContext, ownerId: string, input: { candidateId: number; draftId?: number; channel: Channel; lang?: string; url?: string; publishedAt?: number }): number {
  getCandidateRow(ctx, ownerId, input.candidateId);
  const url = input.url?.trim() ?? "";
  validateUrl(ctx, ownerId, input.channel, url);
  const now = Date.now(), publishedAt = input.publishedAt ?? now;
  validatePublishedAt(ctx, ownerId, publishedAt);
  if (input.draftId !== undefined) {
    const d = ctx.db.select({ id: schema.drafts.id, channel: schema.drafts.channel, lang: schema.drafts.lang }).from(schema.drafts).where(and(eq(schema.drafts.id, input.draftId), eq(schema.drafts.ownerId, ownerId), eq(schema.drafts.candidateId, input.candidateId))).get();
    if (!d) throw new NotFoundError("draft");
    if (d.channel !== input.channel || (input.lang && d.lang !== input.lang)) throw new InvalidInputError(say(localeOf(ctx, ownerId), "초안과 게시 채널·언어가 다릅니다.", "The publication channel or language does not match the draft."));
  }
  const id = ctx.db.$client.transaction(() => {
    const id = Number(ctx.db.insert(schema.publications).values({ ownerId, candidateId: input.candidateId, draftId: input.draftId ?? null, channel: input.channel, lang: input.lang ?? null, url, publishedAt }).run().lastInsertRowid);
    ctx.db.update(schema.candidates).set({ status: "published", updatedAt: now }).where(and(eq(schema.candidates.id, input.candidateId), eq(schema.candidates.ownerId, ownerId))).run();
    syncPublishedChanges(ctx, ownerId, input.candidateId);
    return id;
  })();
  channelResultsCache.get(ctx.db)?.delete(ownerId);
  // 등록 직후 한 번 반응을 받아 둔다 (기준선). 실패해도 등록은 된다.
  void refreshReactions(ctx, ownerId, true).catch(() => undefined);
  emit(ctx, ownerId, { resource: "publications", id });
  emit(ctx, ownerId, { resource: "candidates", id: input.candidateId });
  return id;
}

/** 잘못 적은 발행 URL 고치기. 자동 반응은 새 URL로 다시 받는다. */
export function updatePublicationUrl(ctx: AppContext, ownerId: string, id: number, url: string): void {
  updatePublication(ctx, ownerId, id, { url });
}

/** URL과 실제 게시 시각을 함께 수정한다. 시각 수정은 지표와 변경 원장에도 반영한다. */
export function updatePublication(ctx: AppContext, ownerId: string, id: number, input: { url?: string; publishedAt?: number }): void {
  const publication = ctx.db.select().from(schema.publications).where(and(eq(schema.publications.id, id), eq(schema.publications.ownerId, ownerId))).get();
  if (!publication) throw new NotFoundError("publication");
  const url = input.url?.trim() ?? publication.url;
  validateUrl(ctx, ownerId, publication.channel as Channel, url);
  if (input.publishedAt !== undefined) validatePublishedAt(ctx, ownerId, input.publishedAt);
  ctx.db.$client.transaction(() => {
    const r = ctx.db.update(schema.publications).set({ url, publishedAt: input.publishedAt ?? publication.publishedAt, ...(url !== publication.url ? { autoStats: null, autoStatsAt: null } : {}) }).where(and(eq(schema.publications.id, id), eq(schema.publications.ownerId, ownerId))).run();
    if (r.changes === 0) throw new NotFoundError("publication");
    if (input.publishedAt !== undefined) syncPublishedChanges(ctx, ownerId, publication.candidateId);
  })();
  void refreshPublicationReactions(ctx, ownerId, id).catch(() => undefined);
  channelResultsCache.get(ctx.db)?.delete(ownerId);
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
    syncPublishedChanges(ctx, ownerId, p.candidateId);
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

export function setManualStats(ctx: AppContext, ownerId: string, id: number, stats: PublicationStats): void {
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
  // 목록의 100건 제한 밖에 있는 같은 저장소 게시도 기여 구분에 포함한다.
  const related = ctx.db.select({ id: schema.publications.id, at: schema.publications.publishedAt, repo: schema.candidates.repo }).from(schema.publications)
    .innerJoin(schema.candidates, and(eq(schema.candidates.id, schema.publications.candidateId), eq(schema.candidates.ownerId, ownerId)))
    .where(eq(schema.publications.ownerId, ownerId)).all();
  const voices = new Map(draftIds.length ? ctx.db.select({ id: schema.drafts.id, v: schema.drafts.voice }).from(schema.drafts).where(and(eq(schema.drafts.ownerId, ownerId), inArray(schema.drafts.id, draftIds))).all().map((d) => [d.id, d.v]) : []);
  const snapsByRepo = new Map<string, (typeof schema.metricSnapshots.$inferSelect)[]>();
  for (const repo of new Set([...cands.values()].map((c) => c.repo))) {
    // 최근 60일만 읽으면 오래된 완료 관측이 자료 부족으로 바뀌어 추천에서 사라진다.
    snapsByRepo.set(repo, ctx.db.select().from(schema.metricSnapshots).where(and(eq(schema.metricSnapshots.ownerId, ownerId), eq(schema.metricSnapshots.repo, repo))).orderBy(desc(schema.metricSnapshots.at)).all());
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
    const day = 86400e3;
    const end = p.publishedAt + 7 * day;
    const final = snaps.find((s) => s.at <= end && s.at >= end - day);
    const observationStatus = Date.now() < end ? "pending" as const : effect.baseline && p.publishedAt - effect.baseline.at <= 2 * day && final ? "complete" as const : "insufficient" as const;
    const sharedWith = related.filter((o) => o.id !== p.id && o.repo === c.repo && Math.abs(o.at - p.publishedAt) < 7 * 86400e3).length;
    out.push({ ...toPublication(p), observationStatus, ...(sharedWith ? { sharedWith } : {}), candidateTitle: c.title, repo: c.repo, voice, baselineStars: before[0]?.stars, latestStars: after[0]?.stars ?? snaps[0]?.stars, ...(observationStatus === "complete" ? { starDelta7d: effect.observed, expectedStarDelta7d: effect.expected, excessStars7d: effect.excess } : {}), series: snaps.slice(0, 30).reverse().map((s) => ({ at: s.at, stars: s.stars, uniques: s.viewsUniques14d ?? undefined, downloads: s.npmDownloadsMonth ?? undefined })) });
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
  // 동시 게시의 저장소 스타는 어느 글에서 왔는지 모른다. 임의 배분으로 추천 자료를 만들지 않는다.
  const attributable = (p: PublicationWithMetrics) => p.observationStatus === "complete" && !p.sharedWith;
  const delta = (p: PublicationWithMetrics) => attributable(p) ? p.starDelta7d : undefined;
  const excess = (p: PublicationWithMetrics) => attributable(p) ? p.excessStars7d : undefined;
  const likes = (p: PublicationWithMetrics) => p.autoStats?.likes ?? p.manualStats?.likes;
  const avg = (xs: (number | undefined)[]) => { const v = xs.filter((x): x is number => x !== undefined); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : undefined; };
  const group = <K extends string>(key: (p: PublicationWithMetrics) => K | undefined) => {
    const m = new Map<K, PublicationWithMetrics[]>();
    for (const p of pubs) { const k = key(p); if (k) m.set(k, [...(m.get(k) ?? []), p]); }
    return [...m.entries()].map(([k, ps]) => ({ key: k, count: ps.length, measured: ps.filter((p) => delta(p) !== undefined).length, pending: ps.filter((p) => p.observationStatus === "pending").length, unattributed: ps.filter((p) => Boolean(p.sharedWith)).length, avgStarDelta: avg(ps.map(delta)), avgExcessStars: avg(ps.map(excess)), avgLikes: avg(ps.filter((p) => p.observationStatus === "complete").map(likes)) })).sort((a, b) => b.count - a.count);
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
    `${g.key}: ${g.count} posts (${g.measured} with completed 7-day star observations and no overlapping same-repo posts; observational, not causal attribution)`,
    g.avgExcessStars !== undefined ? `avg ${g.avgExcessStars > 0 ? "+" : ""}${g.avgExcessStars} stars beyond the prior trend in 7 days` : g.avgStarDelta !== undefined ? `avg +${g.avgStarDelta} stars in 7 days (no prior trend)` : "",
  ].filter(Boolean).join(", "));
}
