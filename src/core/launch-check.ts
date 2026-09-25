/**
 * 링크를 올리기 전에 홈페이지가 검색엔진과 링크 미리보기(X·LinkedIn 카드)에 어떻게 보이는지 점검한다(순수 함수).
 * 남의 페이지를 정규식으로만 읽으므로 앞부분만 본다. 결과는 항목 id와 짧은 값만 담고, 문장은 화면이 만든다.
 */
export type CheckLevel = "ok" | "warn" | "fail";
export type CheckId = "title" | "description" | "og_text" | "og_image" | "twitter_card" | "text_without_js" | "robots" | "sitemap";
export type CheckItem = { id: CheckId; level: CheckLevel; value?: string };

const MAX_HTML = 200_000;

const attr = (tag: string, name: string): string | undefined => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return m ? (m[2] ?? m[3]) : undefined;
};

function metas(head: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (attr(tag, "property") ?? attr(tag, "name"))?.toLowerCase();
    const content = attr(tag, "content");
    if (key && content !== undefined && !out.has(key)) out.set(key, content.trim());
  }
  return out;
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function checkPage(rawHtml: string): CheckItem[] {
  const html = rawHtml.slice(0, MAX_HTML);
  const m = metas(html);
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "");
  const description = m.get("description") ?? "";
  const ogTitle = m.get("og:title"), ogDesc = m.get("og:description");
  const ogImage = m.get("og:image") ?? m.get("twitter:image");
  const card = m.get("twitter:card");
  const body = html.replace(/<head[\s\S]*?<\/head>/i, "").replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ");
  const text = decode(body).replace(/\s+/g, " ").trim();

  return [
    { id: "title", level: !title ? "fail" : title.length < 10 || title.length > 70 ? "warn" : "ok", value: title ? clip(title) : undefined },
    { id: "description", level: !description ? "fail" : description.length < 40 ? "warn" : "ok", value: description ? clip(description) : undefined },
    { id: "og_text", level: ogTitle && ogDesc ? "ok" : ogTitle || ogDesc ? "warn" : "fail", value: ogTitle ? clip(ogTitle) : undefined },
    // og:image는 절대 주소여야 카드에 뜬다. 상대 주소는 대부분의 미리보기가 무시한다.
    { id: "og_image", level: !ogImage ? "fail" : /^https?:\/\//i.test(ogImage) ? "ok" : "warn", value: ogImage ? clip(ogImage) : undefined },
    { id: "twitter_card", level: card ? "ok" : "warn", value: card },
    // JS를 돌리지 않는 크롤러(네이버 등)와 미리보기는 빈 SPA 껍데기만 본다.
    { id: "text_without_js", level: text.length >= 40 ? "ok" : "fail", value: text ? clip(text, 60) : undefined },
  ];
}

export type Fetched = { status: number; contentType: string; body: string } | undefined;

export function checkRobots(res: Fetched): CheckItem {
  if (!res || res.status === 404) return { id: "robots", level: "ok", value: "none" };
  if (res.status >= 400) return { id: "robots", level: "warn", value: String(res.status) };
  if (/html/i.test(res.contentType) || /^\s*</.test(res.body)) return { id: "robots", level: "fail", value: "html" };
  // User-agent: * 묶음에 Disallow: / 가 있으면 전부 막힌다.
  let star = false;
  for (const line of res.body.split(/\r?\n/)) {
    const [k, ...rest] = line.replace(/#.*/, "").split(":");
    const key = k?.trim().toLowerCase(), v = rest.join(":").trim();
    if (key === "user-agent") star = v === "*";
    else if (star && key === "disallow" && v === "/") return { id: "robots", level: "fail", value: "disallow" };
  }
  return { id: "robots", level: "ok" };
}

export function checkSitemap(res: Fetched): CheckItem {
  if (!res || res.status >= 400) return { id: "sitemap", level: "warn", value: res ? String(res.status) : "none" };
  const xml = /xml/i.test(res.contentType) || /^\s*(<\?xml|<urlset|<sitemapindex)/i.test(res.body);
  if (!xml) return { id: "sitemap", level: "fail", value: "html" };
  return { id: "sitemap", level: "ok", value: String((res.body.match(/<loc>/gi) ?? []).length) };
}
