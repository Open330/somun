import { copyIssues, type CopyIssue, type CopySource } from "../core/consistency.js";
import { checkPage, checkRobots, checkSitemap, pageCopy, sitemapPages, withinSite, type CheckItem, type Fetched } from "../core/launch-check.js";
import { publicFetch } from "../infra/net.js";
import type { Evidence, LaunchCheck, LaunchCheckPages } from "../shared/types.js";
import type { AppContext } from "./context.js";
import { getCandidateRow } from "./candidates.js";
import { getProfile } from "./profiles.js";

/**
 * 글감의 홈페이지를 올리기 전에 점검한다. 공인 주소만(publicFetch), 크기 제한, 한 시간 기억.
 * GitHub 저장소 페이지는 미리보기가 이미 갖춰져 있어 점검하지 않는다.
 */
const TTL_MS = 3600_000, MAX_CACHE = 200, MAX_BYTES = 300_000;
/**
 * 남의 사이트에 부담을 주지 않게: 하위 페이지는 사이트맵 순서로 최대 25개, 한 점검에서 4개씩.
 * 점검 하나는 시작부터 20초 안에 끝내고(요청마다 남은 시간만큼만 기다린다), 서버 전체에서 동시에 여는 하위 페이지는 8개까지다.
 */
const MAX_PAGES = 25, PAGE_CONCURRENCY = 4, CRAWL_BUDGET_MS = 20_000, REQUEST_MS = 6_000, GLOBAL_SUBPAGES = 8;
type Crawl = { items: CheckItem[]; pages?: LaunchCheckPages; homeCopy: { title?: string; description?: string } } | { unreachable: true };
const cache = new Map<string, { at: number; crawl: Crawl }>();
/** 같은 홈페이지(#… 차이는 같은 페이지)를 동시에 여러 번 점검하면 한 번만 연다. */
const inflight = new Map<string, Promise<Crawl>>();

let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= GLOBAL_SUBPAGES) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

type Get = { deadline: number; scope?: (url: URL) => boolean };

/** 한 번 연다. scope가 있으면 리다이렉트 대상을 요청하기 전에 거른다. 시간이 다 됐으면 열지 않는다. */
async function get(url: string, opts: Get): Promise<Fetched> {
  const left = Math.min(REQUEST_MS, opts.deadline - Date.now());
  if (left < 300) return undefined;
  try {
    const res = await publicFetch(url, { headers: { "User-Agent": "somun (+https://github.com/Open330/somun)" }, signal: AbortSignal.timeout(left) }, 3, opts.scope);
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel().catch(() => undefined); break; }
      chunks.push(value);
    }
    return { status: res.status, contentType: res.headers.get("content-type") ?? "", body: Buffer.concat(chunks).toString("utf8"), url: res.url || url };
  } catch {
    return undefined;
  }
}

/** 사이트맵 본문이 진짜 사이트맵인가. 200으로 온 오류 페이지(content-type이 xml이어도)는 아니다. */
const realSitemap = (res: Fetched) => checkSitemap(res).level === "ok" && /<(?:urlset|sitemapindex)\b/i.test(res!.body);

/** 사이트맵의 하위 페이지를 점검한다. 사이트맵 색인(sitemapindex)이면 같은 출처의 첫 하위 사이트맵 두 개까지 읽는다. */
async function checkSubpages(homepage: string, sitemap: Fetched, deadline: number): Promise<LaunchCheckPages | undefined> {
  if (!realSitemap(sitemap)) return undefined;
  const origin = new URL(homepage).origin;
  const sameOrigin = (u: URL) => u.origin === origin;
  let xmls = [sitemap!.body];
  if (/<sitemapindex\b/i.test(sitemap!.body)) {
    const children = sitemapLocs(sitemap!.body).filter((u) => { try { return sameOrigin(new URL(u)); } catch { return false; } }).slice(0, 2);
    xmls = (await Promise.all(children.map((u) => get(u, { deadline, scope: sameOrigin })))).filter(realSitemap).map((r) => r!.body);
  }
  // 하위 사이트맵마다 따로 고른다. 하나로 이으면 앞 사이트맵이 길 때 뒤 사이트맵이 잘린다.
  const all = [...new Set(xmls.flatMap((xml) => sitemapPages(xml, homepage, MAX_PAGES * 4)))];
  if (!all.length) return undefined;
  const urls = all.slice(0, MAX_PAGES);
  const inScope = (u: URL) => withinSite(u.href, homepage);
  const results: { url: string; items?: CheckItem[] }[] = [];
  for (let i = 0; i < urls.length; i += PAGE_CONCURRENCY) {
    const batch = urls.slice(i, i + PAGE_CONCURRENCY);
    const pages = await Promise.all(batch.map((u) => slot(() => get(u, { deadline, scope: inScope }))));
    batch.forEach((url, j) => {
      const page = pages[j];
      results.push({ url, items: page && page.status < 400 ? checkPage(page.body) : undefined });
    });
  }
  const issues = results.flatMap((r) => (r.items ? [{ url: r.url, items: r.items.filter((it) => it.level !== "ok") }] : [])).filter((r) => r.items.length);
  return { checked: results.filter((r) => r.items).length, unreachable: results.filter((r) => !r.items).length, total: all.length, issues };
}

const sitemapLocs = (xml: string) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!);

async function crawl(requested: string): Promise<Crawl> {
  const deadline = Date.now() + CRAWL_BUDGET_MS;
  const page = await get(requested, { deadline });
  if (!page || page.status >= 400) return { unreachable: true };
  // 홈페이지가 다른 주소(www, 다른 경로)로 넘어가면 그 주소를 기준으로 robots·사이트맵·하위 페이지를 본다.
  const homepage = page.url ?? requested;
  const origin = new URL(homepage).origin;
  const sub = new URL(homepage).pathname.replace(/\/+$/, "");
  const [robots, rootSitemap, ownSitemap] = await Promise.all([
    get(`${origin}/robots.txt`, { deadline }),
    get(`${origin}/sitemap.xml`, { deadline }),
    // 경로 아래 사이트(GitHub Pages 프로젝트)는 그 경로의 sitemap.xml을 먼저 본다.
    sub ? get(`${origin}${sub}/sitemap.xml`, { deadline, scope: (u) => withinSite(u.href, homepage) }) : Promise.resolve(undefined),
  ]);
  const sitemap = realSitemap(ownSitemap) ? ownSitemap : rootSitemap;
  // 사이트맵 항목도 실제로 쓴 사이트맵으로 판정한다(프로젝트 사이트맵이 있는데 출처 404로 경고하지 않게).
  const items = [...checkPage(page.body), checkRobots(robots), checkSitemap(sitemap)];
  const pages = await checkSubpages(homepage, sitemap, deadline);
  return { items, pages, homeCopy: pageCopy(page.body) };
}

/**
 * 저장소 설명·홈페이지 문구·승인한 한 줄을 README와 비교한다(core/consistency).
 * README가 없거나 비교할 문구가 하나도 없으면 비교하지 않았다는 뜻으로 undefined를 돌려준다(빈 배열은 "비교했고 문제없음").
 */
function copyCheck(ctx: AppContext, ownerId: string, evidence: Evidence, homeCopy: { title?: string; description?: string }): CopyIssue[] | undefined {
  if (!evidence.readmeForChecks?.trim()) return undefined;
  const profile = getProfile(ctx, ownerId, evidence.repo)?.profile;
  const texts: { source: CopySource; text?: string }[] = [
    { source: "description", text: evidence.description },
    { source: "homepage_title", text: homeCopy.title },
    { source: "homepage_description", text: homeCopy.description },
    { source: "oneliner_ko", text: profile?.oneLinerKo },
    { source: "oneliner_en", text: profile?.oneLinerEn },
  ];
  if (!texts.some((t) => t.text?.trim())) return undefined;
  const productName = profile?.naming?.trim() || evidence.repo.split("/").at(-1);
  return copyIssues({ readme: evidence.readmeForChecks, readmeTruncated: evidence.readmeTruncated !== false, productName, texts });
}

export async function launchCheck(ctx: AppContext, ownerId: string, candidateId: number): Promise<LaunchCheck> {
  const evidence = getCandidateRow(ctx, ownerId, candidateId).evidence as Evidence;
  const homepage = evidence.homepage;
  if (!homepage || !/^https?:\/\//i.test(homepage) || homepage.length > 300) return { items: [], copy: copyCheck(ctx, ownerId, evidence, {}) };
  if (/^https?:\/\/(www\.)?github\.com\//i.test(homepage)) return { homepage, items: [], copy: copyCheck(ctx, ownerId, evidence, {}) };
  let key: string;
  try { const u = new URL(homepage); u.hash = ""; key = u.href; } catch { return { homepage, items: [], unreachable: true, copy: copyCheck(ctx, ownerId, evidence, {}) }; }
  let hit = cache.get(key);
  if (!hit || Date.now() - hit.at >= TTL_MS) {
    let pending = inflight.get(key);
    if (!pending) {
      pending = crawl(key).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    const result = await pending;
    hit = cache.get(key);
    if (!hit || Date.now() - hit.at >= TTL_MS) {
      if ("unreachable" in result) ctx.log.info({ homepage }, "launch check: homepage unreachable");
      hit = { at: Date.now(), crawl: result };
      // 열지 못한 결과는 기억하지 않는다. 사이트가 돌아오면 바로 다시 점검한다.
      if (!("unreachable" in result)) {
        if (cache.size >= MAX_CACHE && !cache.has(key)) cache.delete(cache.keys().next().value!);
        cache.set(key, hit);
      }
    }
  }
  const { at, crawl: c } = hit;
  if ("unreachable" in c) return { homepage, items: [], unreachable: true, copy: copyCheck(ctx, ownerId, evidence, {}) };
  return { homepage, items: c.items, checkedAt: at, pages: c.pages, copy: copyCheck(ctx, ownerId, evidence, c.homeCopy) };
}
