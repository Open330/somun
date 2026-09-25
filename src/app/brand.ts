import { extractBrand, stylesheetLinks, type Brand } from "../core/brand.js";
import { publicFetch } from "../infra/net.js";
import type { AppContext } from "./context.js";

/**
 * 저장소 홈페이지에서 브랜드를 읽는다. 공인 주소만(publicFetch), 페이지·스타일시트는 크기를 제한하고, 하루 동안 기억한다.
 * 실패하면 브랜드 없이 영상을 만든다(영상 요청을 막지 않는다).
 */
const TTL_MS = 24 * 3600_000, FAIL_TTL_MS = 3600_000, MAX_CACHE = 500;
const MAX_BYTES = 400_000;
const cache = new Map<string, { at: number; brand?: Brand }>();

/** 본문과, 리다이렉트를 따라간 뒤의 최종 주소. */
async function fetchText(url: string, accept: string): Promise<{ body: string; url: string } | undefined> {
  const res = await publicFetch(url, { headers: { Accept: accept, "User-Agent": "somun (+https://github.com/Open330/somun)" }, signal: AbortSignal.timeout(6_000) });
  if (!res.ok) { await res.body?.cancel().catch(() => undefined); return undefined; }
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel().catch(() => undefined); break; }
    chunks.push(value);
  }
  return { body: Buffer.concat(chunks).toString("utf8"), url: res.url || url };
}

async function readBrand(ctx: AppContext, homepage: string): Promise<Brand | undefined> {
  try {
    const page = await fetchText(homepage, "text/html");
    if (!page) return undefined;
    // 스타일시트는 리다이렉트 뒤의 주소(apex → www, http → https)를 기준으로 찾는다.
    const css = (await Promise.all(stylesheetLinks(page.body, page.url).map((u) => fetchText(u, "text/css").then((r) => r?.body).catch(() => undefined)))).filter((x): x is string => Boolean(x));
    return extractBrand(page.body, css, page.url);
  } catch (err) {
    ctx.log.info({ err: (err as Error).message, homepage }, "brand fetch failed");
    return undefined;
  }
}

/** 같은 홈페이지를 동시에 여러 번 읽지 않는다. */
const inflight = new Map<string, Promise<Brand | undefined>>();

export async function brandFor(ctx: AppContext, homepage: string | undefined): Promise<Brand | undefined> {
  if (!homepage || homepage.length > 300 || !/^https?:\/\//i.test(homepage)) return undefined;
  const hit = cache.get(homepage);
  if (hit && Date.now() - hit.at < (hit.brand ? TTL_MS : FAIL_TTL_MS)) return hit.brand;
  let running = inflight.get(homepage);
  if (!running) {
    running = readBrand(ctx, homepage).then((brand) => {
      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
      cache.set(homepage, { at: Date.now(), brand });
      return brand;
    }).finally(() => inflight.delete(homepage));
    inflight.set(homepage, running);
  }
  return running;
}
