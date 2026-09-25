import { checkPage, checkRobots, checkSitemap, type CheckItem, type Fetched } from "../core/launch-check.js";
import { publicFetch } from "../infra/net.js";
import type { LaunchCheck } from "../shared/types.js";
import type { AppContext } from "./context.js";
import { getCandidateRow } from "./candidates.js";

/**
 * 글감의 홈페이지를 올리기 전에 점검한다. 공인 주소만(publicFetch), 크기 제한, 한 시간 기억.
 * GitHub 저장소 페이지는 미리보기가 이미 갖춰져 있어 점검하지 않는다.
 */
const TTL_MS = 3600_000, MAX_CACHE = 200, MAX_BYTES = 300_000;
const cache = new Map<string, { at: number; items: CheckItem[] }>();

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

export async function launchCheck(ctx: AppContext, ownerId: string, candidateId: number): Promise<LaunchCheck> {
  const homepage = (getCandidateRow(ctx, ownerId, candidateId).evidence as { homepage?: string }).homepage;
  if (!homepage || !/^https?:\/\//i.test(homepage) || homepage.length > 300) return { items: [] };
  if (/^https?:\/\/(www\.)?github\.com\//i.test(homepage)) return { homepage, items: [] };
  const hit = cache.get(homepage);
  if (hit && Date.now() - hit.at < TTL_MS) return { homepage, items: hit.items, checkedAt: hit.at };
  const origin = new URL(homepage).origin;
  const [page, robots, sitemap] = await Promise.all([get(homepage), get(`${origin}/robots.txt`), get(`${origin}/sitemap.xml`)]);
  if (!page || page.status >= 400) {
    ctx.log.info({ homepage, status: page?.status }, "launch check: homepage unreachable");
    return { homepage, items: [], unreachable: true };
  }
  const items = [...checkPage(page.body), checkRobots(robots), checkSitemap(sitemap)];
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
  const at = Date.now();
  cache.set(homepage, { at, items });
  return { homepage, items, checkedAt: at };
}
