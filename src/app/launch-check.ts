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
/** 하위 페이지는 사이트맵 순서로 최대 25개, 동시에 4개씩, 전체 20초 안에서만 연다(남의 사이트에 부담을 주지 않게). */
const MAX_PAGES = 25, PAGE_CONCURRENCY = 4, CRAWL_BUDGET_MS = 20_000;
type Crawl = { items: CheckItem[]; pages?: LaunchCheckPages; homeCopy: { title?: string; description?: string } } | { unreachable: true };
const cache = new Map<string, { at: number; crawl: Crawl }>();
/** 같은 홈페이지를 동시에 여러 번 점검하면 한 번만 연다. */
const inflight = new Map<string, Promise<Crawl>>();

async function get(url: string): Promise<Fetched> {
  try {
    const res = await publicFetch(url, { headers: { "User-Agent": "somun (+https://github.com/Open330/somun)" }, signal: AbortSignal.timeout(6_000) });
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

/** 리다이렉트 끝이 홈페이지 경로 밖(다른 출처, 다른 프로젝트)이면 그 페이지의 결과로 치지 않는다. */
async function getWithin(url: string, homepage: string): Promise<Fetched> {
  const res = await get(url);
  return res && withinSite(res.url ?? url, homepage) ? res : undefined;
}

const okSitemap = (res: Fetched) => checkSitemap(res).level === "ok";

/** 사이트맵의 하위 페이지를 점검한다. 사이트맵 색인(sitemapindex)이면 첫 하위 사이트맵 두 개까지 읽는다. */
async function checkSubpages(homepage: string, sitemap: Fetched): Promise<LaunchCheckPages | undefined> {
  if (!okSitemap(sitemap)) return undefined;
  const origin = new URL(homepage).origin;
  let xmls = [sitemap!.body];
  if (/<sitemapindex\b/i.test(sitemap!.body)) {
    const children = [...sitemap!.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!).filter((u) => { try { return new URL(u).origin === origin; } catch { return false; } }).slice(0, 2);
    xmls = (await Promise.all(children.map((u) => get(u)))).filter((r) => r && r.status < 400 && new URL(r.url ?? origin).origin === origin).map((r) => r!.body);
  }
  // 하위 사이트맵마다 따로 고른다. 하나로 이으면 앞 사이트맵이 길 때 뒤 사이트맵이 잘린다.
  const all = [...new Set(xmls.flatMap((xml) => sitemapPages(xml, homepage, MAX_PAGES * 4)))];
  if (!all.length) return undefined;
  const urls = all.slice(0, MAX_PAGES);
  const deadline = Date.now() + CRAWL_BUDGET_MS;
  const results: { url: string; items?: CheckItem[] }[] = [];
  for (let i = 0; i < urls.length && Date.now() < deadline; i += PAGE_CONCURRENCY) {
    const batch = urls.slice(i, i + PAGE_CONCURRENCY);
    const pages = await Promise.all(batch.map((u) => getWithin(u, homepage)));
    batch.forEach((url, j) => {
      const page = pages[j];
      results.push({ url, items: page && page.status < 400 ? checkPage(page.body) : undefined });
    });
  }
  const issues = results.flatMap((r) => (r.items ? [{ url: r.url, items: r.items.filter((it) => it.level !== "ok") }] : [])).filter((r) => r.items.length);
  return { checked: results.filter((r) => r.items).length, unreachable: results.filter((r) => !r.items).length, total: all.length, issues };
}

async function crawl(homepage: string): Promise<Crawl> {
  const origin = new URL(homepage).origin;
  const [page, robots, sitemap] = await Promise.all([get(homepage), get(`${origin}/robots.txt`), get(`${origin}/sitemap.xml`)]);
  if (!page || page.status >= 400) return { unreachable: true };
  const items = [...checkPage(page.body), checkRobots(robots), checkSitemap(sitemap)];
  // 경로 아래 사이트(GitHub Pages 프로젝트)는 그 경로의 sitemap.xml을 먼저 본다. 진짜 사이트맵이 아니면(200 오류 페이지 등) 출처 사이트맵에서 경로 아래만 고른다.
  const sub = new URL(homepage).pathname.replace(/\/+$/, "");
  const own = sub ? await getWithin(`${origin}${sub}/sitemap.xml`, homepage) : undefined;
  const pages = await checkSubpages(homepage, okSitemap(own) ? own : sitemap);
  return { items, pages, homeCopy: pageCopy(page.body) };
}

/** 저장소 설명·홈페이지 문구·승인한 한 줄을 README와 비교한다(core/consistency). README가 없으면 비교하지 않았다는 뜻으로 undefined. */
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
  const productName = profile?.naming?.trim() || evidence.repo.split("/").at(-1);
  return copyIssues({ readme: evidence.readmeForChecks, readmeTruncated: evidence.readmeTruncated !== false, productName, texts });
}

export async function launchCheck(ctx: AppContext, ownerId: string, candidateId: number): Promise<LaunchCheck> {
  const evidence = getCandidateRow(ctx, ownerId, candidateId).evidence as Evidence;
  const homepage = evidence.homepage;
  if (!homepage || !/^https?:\/\//i.test(homepage) || homepage.length > 300) return { items: [], copy: copyCheck(ctx, ownerId, evidence, {}) };
  if (/^https?:\/\/(www\.)?github\.com\//i.test(homepage)) return { homepage, items: [], copy: copyCheck(ctx, ownerId, evidence, {}) };
  let hit = cache.get(homepage);
  if (!hit || Date.now() - hit.at >= TTL_MS) {
    let pending = inflight.get(homepage);
    if (!pending) {
      pending = crawl(homepage).finally(() => inflight.delete(homepage));
      inflight.set(homepage, pending);
    }
    const result = await pending;
    if (cache.size >= MAX_CACHE && !cache.has(homepage)) cache.delete(cache.keys().next().value!);
    hit = cache.get(homepage);
    if (!hit || Date.now() - hit.at >= TTL_MS) {
      if ("unreachable" in result) ctx.log.info({ homepage }, "launch check: homepage unreachable");
      hit = { at: Date.now(), crawl: result };
      // 열지 못한 결과는 기억하지 않는다. 사이트가 돌아오면 바로 다시 점검한다.
      if (!("unreachable" in result)) cache.set(homepage, hit);
    }
  }
  const { at, crawl: c } = hit;
  if ("unreachable" in c) return { homepage, items: [], unreachable: true, copy: copyCheck(ctx, ownerId, evidence, {}) };
  return { homepage, items: c.items, checkedAt: at, pages: c.pages, copy: copyCheck(ctx, ownerId, evidence, c.homeCopy) };
}
