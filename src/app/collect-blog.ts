import type { Evidence } from "../shared/types.js";
import type { AppContext } from "./context.js";
import { ingestSignals, type IncomingSignal } from "./signals.js";
import { listEnabledSources, markPolled } from "./sources.js";

/**
 * 블로그 커넥터. RSS 2.0 / Atom 피드 URL을 소스로 두고, 새 글을 blog 글감으로 만든다.
 * 의존성 없이 정규식으로 읽는다. 제목·링크·날짜·요약만 있으면 된다.
 */
const DAY = 86400e3;

export type FeedItem = { title: string; url: string; publishedAt: number; summary?: string };

function unescape(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ").trim();
}
function tag(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i").exec(block);
  return m ? unescape(m[1]) : undefined;
}

export function parseFeed(xml: string): FeedItem[] {
  const out: FeedItem[] = [];
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = isAtom ? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [] : xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const b of blocks) {
    const title = tag(b, "title") ?? "";
    let url = "";
    if (isAtom) {
      const link = /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i.exec(b) ?? /<link[^>]*href=["']([^"']+)["']/i.exec(b);
      url = link?.[1] ?? "";
    } else url = tag(b, "link") ?? tag(b, "guid") ?? "";
    const dateRaw = tag(b, isAtom ? "published" : "pubDate") ?? tag(b, isAtom ? "updated" : "dc:date") ?? "";
    const publishedAt = Date.parse(dateRaw);
    const summary = (tag(b, isAtom ? "summary" : "description") ?? tag(b, "content") ?? tag(b, "content:encoded") ?? "").slice(0, 1200);
    if (title && url && !Number.isNaN(publishedAt)) out.push({ title, url, publishedAt, summary: summary || undefined });
  }
  return out;
}

const MAX_FEED_BYTES = 5_000_000;

export async function collectBlogSource(ctx: AppContext, sourceId: number): Promise<Record<string, number>> {
  const source = listEnabledSources(ctx, { kind: "blog" }).find((s) => s.id === sourceId);
  if (!source) return {};
  const ownerId = source.ownerId;
  const since = Date.now() - 30 * DAY;
  const summary: Record<string, number> = {};
  try {
    for (const feedUrl of source.targets) {
      // 타임아웃은 본문 읽기까지 묶는다. 피드가 비정상적으로 크면 읽지 않는다.
      const r = await fetch(feedUrl, { headers: { "User-Agent": "somun/1.0 (+https://somun.jiun.dev)", Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" }, signal: AbortSignal.timeout(15_000) }).catch((e: Error) => { ctx.log.warn({ feedUrl, err: e.message }, "feed fetch failed"); return null; });
      if (!r?.ok || Number(r.headers.get("content-length") ?? 0) > MAX_FEED_BYTES) { summary[feedUrl] = -1; if (r) ctx.log.warn({ feedUrl, status: r.status }, "feed fetch failed"); continue; }
      const items = parseFeed(await r.text()).filter((i) => i.publishedAt >= since);
      const host = new URL(feedUrl).host;
      const signals: IncomingSignal[] = items.map((i) => ({ kind: "blog_post", repo: `blog:${host}`, ref: `blog:${i.url}`, title: i.title, payload: { title: i.title, url: i.url, summary: i.summary }, occurredAt: i.publishedAt }));
      let inserted = 0;
      for (const s of signals) {
        // 글마다 근거가 다르므로 하나씩 넣는다 (ingestSignals의 evidence는 신호 묶음 공통).
        const ev: Evidence = { repo: `blog:${host}`, repoUrl: String(s.payload.url), description: String(s.payload.title), readmeExcerpt: s.payload.summary ? String(s.payload.summary) : undefined, releaseNotes: s.payload.summary ? `Blog post: ${s.payload.title}\n\n${s.payload.summary}` : undefined };
        inserted += ingestSignals(ctx, ownerId, sourceId, [s], {}, ev).inserted;
      }
      summary[feedUrl] = inserted;
    }
    markPolled(ctx, sourceId);
  } catch (e) {
    markPolled(ctx, sourceId, (e as Error).message);
    throw e;
  }
  return summary;
}
