import { copyIssues, type CopySource } from "../core/consistency.js";
import { checkPage, checkRobots, checkSitemap, pageCopy, sitemapPages, type CheckItem, type Fetched } from "../core/launch-check.js";
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
/** 하위 페이지는 사이트맵 순서로 최대 25개, 동시에 4개씩만 연다(남의 사이트에 부담을 주지 않게). */
const MAX_PAGES = 25, PAGE_CONCURRENCY = 4;
type Cached = { at: number; items: CheckItem[]; pages?: LaunchCheckPages; homeCopy: { title?: string; description?: string } };
const cache = new Map<string, Cached>();

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
    return { status: res.status, contentType: res.headers.get("content-type") ?? "", body: Buffer.concat(chunks).toString("utf8") };
  } catch {
    return undefined;
  }
}

/** 사이트맵의 하위 페이지를 점검한다. 사이트맵 색인(sitemapindex)이면 첫 하위 사이트맵 두 개까지 읽는다. */
async function checkSubpages(homepage: string, sitemap: Fetched): Promise<LaunchCheckPages | undefined> {
  if (!sitemap || sitemap.status >= 400) return undefined;
  let xml = sitemap.body;
  if (/<sitemapindex\b/i.test(xml)) {
    const origin = new URL(homepage).origin;
    const children = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!).filter((u) => { try { return new URL(u).origin === origin; } catch { return false; } }).slice(0, 2);
    xml = (await Promise.all(children.map(get))).map((r) => (r && r.status < 400 ? r.body : "")).join("\n");
  }
  const all = sitemapPages(xml, homepage, Number.MAX_SAFE_INTEGER);
  if (!all.length) return undefined;
  const urls = all.slice(0, MAX_PAGES);
  const results: { url: string; items?: CheckItem[] }[] = [];
  for (let i = 0; i < urls.length; i += PAGE_CONCURRENCY) {
    const batch = urls.slice(i, i + PAGE_CONCURRENCY);
    const pages = await Promise.all(batch.map(get));
    batch.forEach((url, j) => {
      const page = pages[j];
      results.push({ url, items: page && page.status < 400 ? checkPage(page.body) : undefined });
    });
  }
  const issues = results.flatMap((r) => (r.items ? [{ url: r.url, items: r.items.filter((it) => it.level !== "ok") }] : [])).filter((r) => r.items.length);
  return { checked: results.filter((r) => r.items).length, unreachable: results.filter((r) => !r.items).length, total: all.length, issues };
}

/** 저장소 설명·홈페이지 문구·승인한 한 줄을 README와 비교한다(core/consistency). 홈페이지가 없어도 나머지는 본다. */
function copyCheck(ctx: AppContext, ownerId: string, evidence: Evidence, homeCopy: { title?: string; description?: string }) {
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
  const hit = cache.get(homepage);
  if (hit && Date.now() - hit.at < TTL_MS) return { homepage, items: hit.items, checkedAt: hit.at, pages: hit.pages, copy: copyCheck(ctx, ownerId, evidence, hit.homeCopy) };
  const origin = new URL(homepage).origin;
  const [page, robots, sitemap] = await Promise.all([get(homepage), get(`${origin}/robots.txt`), get(`${origin}/sitemap.xml`)]);
  if (!page || page.status >= 400) {
    ctx.log.info({ homepage, status: page?.status }, "launch check: homepage unreachable");
    return { homepage, items: [], unreachable: true, copy: copyCheck(ctx, ownerId, evidence, {}) };
  }
  const items = [...checkPage(page.body), checkRobots(robots), checkSitemap(sitemap)];
  // 경로 아래 사이트(GitHub Pages 프로젝트)는 그 경로의 sitemap.xml을 먼저 본다. 없으면 출처 사이트맵에서 경로 아래만 고른다.
  const sub = new URL(homepage).pathname.replace(/\/+$/, "");
  const ownSitemap = sub ? await get(`${origin}${sub}/sitemap.xml`) : undefined;
  const pages = await checkSubpages(homepage, ownSitemap && ownSitemap.status < 400 ? ownSitemap : sitemap);
  const homeCopy = pageCopy(page.body);
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
  const at = Date.now();
  cache.set(homepage, { at, items, pages, homeCopy });
  return { homepage, items, checkedAt: at, pages, copy: copyCheck(ctx, ownerId, evidence, homeCopy) };
}
