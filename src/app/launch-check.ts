import { gunzipSync } from "node:zlib";
import { copyIssues, type CopyIssue, type CopySource } from "../core/consistency.js";
import { MAX_SITEMAP, checkPage, checkRobots, checkSitemap, pageCopy, pageKey, siteBase, sitemapLocs, sitemapPages, sitemapRoot, withinSite, type CheckItem, type Fetched } from "../core/launch-check.js";
import { publicFetch } from "../infra/net.js";
import type { Evidence, LaunchCheck, LaunchCheckPages } from "../shared/types.js";
import type { AppContext } from "./context.js";
import { getCandidateRow } from "./candidates.js";
import { getProfile } from "./profiles.js";

/**
 * 글감의 홈페이지를 올리기 전에 점검한다. 공인 주소만(publicFetch), 크기 제한, 한 시간 기억.
 * GitHub 저장소 페이지는 미리보기가 이미 갖춰져 있어 점검하지 않는다.
 */
const TTL_MS = 3600_000, INCOMPLETE_TTL_MS = 120_000, MAX_CACHE = 200, MAX_BYTES = 300_000, MAX_SITEMAP_BYTES = MAX_SITEMAP;
/**
 * 남의 사이트에 부담을 주지 않게: 하위 페이지는 사이트맵 순서로 최대 25개, 한 점검에서 4개씩.
 * 점검 하나는 시작부터 20초 안에 끝내고(요청마다 남은 시간만큼만 기다린다), 서버 전체에서 동시에 여는 하위 페이지는 8개까지다.
 */
const MAX_PAGES = 25, PAGE_CONCURRENCY = 4, CRAWL_BUDGET_MS = 20_000, REQUEST_MS = 6_000, GLOBAL_SUBPAGES = 8, MAX_CHILD_SITEMAPS = 5;
/** partial: 열지 못한 하위 페이지·사이트맵이 있거나 사이트맵이 잠시 실패했다(5xx, 연결 실패). 짧게만 기억한다. */
type Crawl = { items: CheckItem[]; pages?: LaunchCheckPages; homeCopy: { title?: string; description?: string }; partial: boolean } | { unreachable: true };
const cache = new Map<string, { at: number; ttl: number; crawl: Crawl }>();
/** 같은 홈페이지(#… 차이는 같은 페이지)를 동시에 여러 번 점검하면 한 번만 연다. */
const inflight = new Map<string, Promise<Crawl>>();

let active = 0;
const waiting: { grant: () => void }[] = [];
/**
 * 서버 전체에서 동시에 여는 하위 페이지 수를 묶는다. 끝난 자리는 숫자를 줄이지 않고 기다리던 쪽에 바로 넘겨,
 * 그 사이에 끼어든 요청이 같은 자리를 차지하지 못하게 한다. 마감까지 자리를 못 얻으면 열지 않는다(undefined).
 */
async function slot<T>(deadline: number, fn: () => Promise<T>): Promise<T | undefined> {
  if (active < GLOBAL_SUBPAGES) active++;
  else {
    const granted = await new Promise<boolean>((resolve) => {
      const entry = { grant: () => { clearTimeout(timer); resolve(true); } };
      const timer = setTimeout(() => { waiting.splice(waiting.indexOf(entry), 1); resolve(false); }, Math.max(0, deadline - Date.now()));
      waiting.push(entry);
    });
    if (!granted) return undefined;
  }
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next.grant();
    else active--;
  }
}

type Get = { deadline: number; scope?: (url: URL) => boolean; gzip?: boolean; maxBytes?: number };

/** 한 번 연다. scope가 있으면 리다이렉트 대상을 요청하기 전에 거른다. 시간이 다 됐으면 열지 않는다. */
async function get(url: string, opts: Get): Promise<Fetched> {
  const left = Math.min(REQUEST_MS, opts.deadline - Date.now());
  if (left < 300) return undefined;
  try {
    const res = await publicFetch(url, { headers: { "User-Agent": "somun (+https://github.com/Open330/somun)" }, signal: AbortSignal.timeout(left) }, 3, opts.scope);
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0, truncated = false;
    const limit = opts.maxBytes ?? MAX_BYTES;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { truncated = true; await reader.cancel().catch(() => undefined); break; }
      chunks.push(value);
    }
    const contentType = res.headers.get("content-type") ?? "";
    let bytes = Buffer.concat(chunks);
    // 압축한 사이트맵(pages.xml.gz)은 풀어서 읽는다. 풀린 크기는 묶어 둔다(압축 폭탄).
    // 홈페이지·하위 페이지는 풀지 않는다(전송 압축은 fetch가 이미 푼다). 하위 사이트맵 파일만 푼다.
    // 풀린 크기가 한도를 넘으면 gunzipSync가 실패하고, 그 사이트맵은 못 본 것으로 센다.
    if (opts.gzip && bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes, { maxOutputLength: limit });
    return { status: res.status, contentType, body: bytes.toString("utf8"), url: res.url || url, ...(truncated ? { truncated } : {}) };
  } catch {
    return undefined;
  }
}

/** 사이트맵 본문이 진짜 사이트맵인가(사이트맵 항목 판정과 같은 기준). 200으로 온 오류 문서는 아니다. */
const realSitemap = (res: Fetched) => checkSitemap(res).level === "ok";

/** 사이트맵의 하위 페이지를 점검한다. 사이트맵 색인(sitemapindex)이면 같은 출처의 하위 사이트맵을 다섯 개까지 읽는다. */
async function checkSubpages(homepage: string, sitemap: Fetched, deadline: number): Promise<LaunchCheckPages | undefined> {
  if (!realSitemap(sitemap)) return undefined;
  const origin = new URL(homepage).origin;
  const sameOrigin = (u: URL) => u.origin === origin;
  let xmls = [sitemap!.body];
  let missedSitemaps = 0;
  // 주석 속 낱말이 아니라 첫 요소로 색인인지 본다(사이트맵 항목 판정과 같은 기준).
  if (sitemapRoot(sitemap!.body) === "sitemapindex") {
    const children = sitemapLocs(sitemap!.body).filter((u) => { try { return sameOrigin(new URL(u)); } catch { return false; } });
    const fetched = await Promise.all(children.slice(0, MAX_CHILD_SITEMAPS).map((u) => get(u, { deadline, scope: sameOrigin, gzip: true, maxBytes: MAX_SITEMAP_BYTES })));
    // 열지 못했거나 상한 밖이라 읽지 않은 하위 사이트맵은 그 안의 페이지를 못 본 것이다. 결과에서 사라지지 않게 센다.
    // 크기 한도에서 잘린 사이트맵도 뒷부분을 못 본 것이다.
    missedSitemaps = fetched.filter((r) => !realSitemap(r) || r?.truncated).length + Math.max(0, children.length - MAX_CHILD_SITEMAPS);
    xmls = fetched.filter(realSitemap).map((r) => r!.body);
  }
  // 하위 사이트맵마다 따로 고른다. 하나로 이으면 앞 사이트맵이 길 때 뒤 사이트맵이 잘린다.
  // 하위 사이트맵끼리도 /p0와 /p0/를 한 페이지로 센다. 사이트맵 하나를 읽을 때마다 다른 요청에 차례를 넘긴다.
  const byKey = new Map<string, string>();
  for (const xml of xmls) {
    for (const url of sitemapPages(xml, homepage, Number.MAX_SAFE_INTEGER)) if (!byKey.has(pageKey(url))) byKey.set(pageKey(url), url);
    await new Promise((resolve) => setImmediate(resolve));
  }
  const all = [...byKey.values()];
  if (!all.length) return missedSitemaps ? { checked: 0, unreachable: 0, total: 0, issues: [], missedSitemaps } : undefined;
  const urls = all.slice(0, MAX_PAGES);
  // 홈페이지로 넘어가는 옛 주소는 그 페이지를 본 것이 아니다(이미 본 홈을 다시 봤을 뿐). 열지 못한 것으로 센다.
  const home = pageKey(homepage);
  const inScope = (u: URL) => withinSite(u.href, homepage) && pageKey(u.href) !== home;
  const results: { url: string; items?: CheckItem[] }[] = [];
  for (let i = 0; i < urls.length; i += PAGE_CONCURRENCY) {
    const batch = urls.slice(i, i + PAGE_CONCURRENCY);
    const pages = await Promise.all(batch.map((u) => slot(deadline, () => get(u, { deadline, scope: inScope }))));
    batch.forEach((url, j) => {
      const page = pages[j];
      results.push({ url, items: page && page.status < 400 ? checkPage(page.body) : undefined });
    });
  }
  const issues = results.flatMap((r) => (r.items ? [{ url: r.url, items: r.items.filter((it) => it.level !== "ok") }] : [])).filter((r) => r.items.length);
  return { checked: results.filter((r) => r.items).length, unreachable: results.filter((r) => !r.items).length, total: all.length, issues, ...(missedSitemaps ? { missedSitemaps } : {}) };
}

async function crawl(requested: string): Promise<Crawl> {
  const deadline = Date.now() + CRAWL_BUDGET_MS;
  const page = await get(requested, { deadline });
  if (!page || page.status >= 400) return { unreachable: true };
  // 홈페이지가 다른 주소(www, 다른 경로)로 넘어가면 그 주소를 기준으로 robots·사이트맵·하위 페이지를 본다.
  const homepage = page.url ?? requested;
  const origin = new URL(homepage).origin;
  // /project/index.html로 넘어가도 기준은 /project 폴더다.
  const sub = siteBase(homepage);
  const [robots, rootSitemap, ownSitemap] = await Promise.all([
    get(`${origin}/robots.txt`, { deadline }),
    get(`${origin}/sitemap.xml`, { deadline, maxBytes: MAX_SITEMAP_BYTES }),
    // 경로 아래 사이트(GitHub Pages 프로젝트)는 그 경로의 sitemap.xml을 먼저 본다.
    sub ? get(`${origin}${sub}/sitemap.xml`, { deadline, scope: (u) => withinSite(u.href, homepage), maxBytes: MAX_SITEMAP_BYTES }) : Promise.resolve(undefined),
  ]);
  const sitemap = realSitemap(ownSitemap) ? ownSitemap : rootSitemap;
  // 사이트맵 항목도 실제로 쓴 사이트맵으로 판정한다(프로젝트 사이트맵이 있는데 출처 404로 경고하지 않게).
  const items = [...checkPage(page.body), checkRobots(robots), checkSitemap(sitemap)];
  const pages = await checkSubpages(homepage, sitemap, deadline);
  // 5xx, 429(요청 제한), 408과 연결 실패는 잠시의 실패다.
  const transient = (r: Fetched) => !r || r.status >= 500 || r.status === 429 || r.status === 408;
  // 먼저 보려던 프로젝트 사이트맵이 잠시 실패해 출처 사이트맵으로 넘어갔어도 미완료다(404는 사이트맵이 없다는 뜻이라 아니다).
  const partial = transient(sitemap) || Boolean(sitemap?.truncated) || Boolean(sub && transient(ownSitemap)) || Boolean(pages && (pages.unreachable > 0 || pages.missedSitemaps));
  // 문구 점검은 앞 2000자만 읽으므로 그만큼만 기억한다.
  const copy = pageCopy(page.body);
  return { items, pages, homeCopy: { title: copy.title?.slice(0, 2000), description: copy.description?.slice(0, 2000) }, partial };
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
  if (!hit || Date.now() - hit.at >= hit.ttl) {
    let pending = inflight.get(key);
    if (!pending) {
      pending = crawl(key).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    const result = await pending;
    hit = cache.get(key);
    if (!hit || Date.now() - hit.at >= hit.ttl) {
      if ("unreachable" in result) ctx.log.info({ homepage }, "launch check: homepage unreachable");
      // 열지 못한 페이지·사이트맵이 있거나 사이트맵이 잠시 실패했으면(동시 점검이 몰려 시간이 모자랐을 수도 있다) 2분만 기억한다.
      const partial = !("unreachable" in result) && result.partial;
      // 결과의 글자들은 원본 페이지의 일부를 잘라 낸 것이라 원본 전체를 붙잡고 있을 수 있다. 새 문자열로 복사해 기억한다.
      hit = { at: Date.now(), ttl: partial ? INCOMPLETE_TTL_MS : TTL_MS, crawl: JSON.parse(JSON.stringify(result)) as Crawl };
      // 열지 못한 결과는 기억하지 않는다. 사이트가 돌아오면 바로 다시 점검한다.
      if (!("unreachable" in result)) {
        if (cache.size >= MAX_CACHE && !cache.has(key)) cache.delete(cache.keys().next().value!);
        cache.set(key, hit);
      }
    }
  }
  const { at, crawl: c } = hit;
  if ("unreachable" in c) return { homepage, items: [], unreachable: true, copy: copyCheck(ctx, ownerId, evidence, {}) };
  return { homepage, items: c.items, checkedAt: at, pages: c.pages, ...(c.partial ? { partial: true } : {}), copy: copyCheck(ctx, ownerId, evidence, c.homeCopy) };
}
