import { and, eq, gte } from "drizzle-orm";
import { schema } from "../infra/db/index.js";
import type { AutoStats } from "../shared/types.js";
import { emit, type AppContext } from "./context.js";

/**
 * 발행 글의 반응 수 자동 수집. 로그인 없이 되는 곳만.
 *  - X: FxTwitter 공개 API (api.fxtwitter.com). 좋아요·리포스트·답글·조회.
 *  - Show HN: HN Firebase API. 점수·댓글.
 * LinkedIn·Threads·GeekNews는 공개 엔드포인트가 없어 수동 입력 그대로.
 */
const DAY = 86400e3;
const UA = "somun/1.0 (+https://somun.jiun.dev)";

export function parseXStatus(url: string): { user: string; id: string } | null {
  const m = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([\w]+)\/status\/(\d+)/i.exec(url);
  return m ? { user: m[1], id: m[2] } : null;
}
export function parseHnItem(url: string): string | null {
  const m = /news\.ycombinator\.com\/item\?id=(\d+)/i.exec(url);
  return m ? m[1] : null;
}

export async function fetchReactions(channel: string, url: string): Promise<AutoStats | null> {
  if (channel === "x") {
    const p = parseXStatus(url);
    if (!p) return null;
    const r = await fetch(`https://api.fxtwitter.com/${p.user}/status/${p.id}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { code?: number; tweet?: { likes?: number; retweets?: number; replies?: number; views?: number | null } };
    if (!j.tweet) return null;
    return { likes: j.tweet.likes, reposts: j.tweet.retweets, comments: j.tweet.replies, views: j.tweet.views ?? undefined, source: "fxtwitter" };
  }
  if (channel === "show_hn") {
    const id = parseHnItem(url);
    if (!id) return null;
    const r = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { score?: number; descendants?: number } | null;
    if (!j) return null;
    return { score: j.score, likes: j.score, comments: j.descendants, source: "hn" };
  }
  return null;
}

/** 30일 안의 발행 글을 갱신한다. 12시간 안에 받은 것은 건너뛴다. */
export async function refreshReactions(ctx: AppContext, ownerId?: string, force = false): Promise<number> {
  const since = Date.now() - 30 * DAY;
  const where = ownerId ? and(eq(schema.publications.ownerId, ownerId), gte(schema.publications.publishedAt, since)) : gte(schema.publications.publishedAt, since);
  const rows = ctx.db.select().from(schema.publications).where(where).all();
  let n = 0;
  for (const p of rows) {
    if (!force && p.autoStatsAt && Date.now() - p.autoStatsAt < 12 * 3600e3) continue;
    try {
      const stats = await fetchReactions(p.channel, p.url);
      if (!stats) continue;
      ctx.db.update(schema.publications).set({ autoStats: stats, autoStatsAt: Date.now() }).where(eq(schema.publications.id, p.id)).run();
      n++;
    } catch (e) { ctx.log.warn({ id: p.id, err: (e as Error).message }, "reactions fetch failed"); }
  }
  return n;
}

/** 발행 하나의 반응을 지금 받는다. 오래된 발행도 대상이다(링크를 고친 경우). */
export async function refreshPublicationReactions(ctx: AppContext, ownerId: string, id: number): Promise<boolean> {
  const p = ctx.db.select().from(schema.publications).where(and(eq(schema.publications.id, id), eq(schema.publications.ownerId, ownerId))).get();
  if (!p) return false;
  const stats = await fetchReactions(p.channel, p.url).catch((e: Error) => { ctx.log.warn({ id, err: e.message }, "reactions fetch failed"); return null; });
  if (!stats) return false;
  ctx.db.update(schema.publications).set({ autoStats: stats, autoStatsAt: Date.now() }).where(eq(schema.publications.id, id)).run();
  emit(ctx, ownerId, { resource: "publications", id });
  return true;
}
