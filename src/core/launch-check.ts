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
  // 따옴표 안의 < 는 값의 일부다(content="price < $20"). 세 갈래의 첫 글자가 서로 달라 되돌아가지 않는다.
  for (const tag of head.match(/<meta\b(?:[^<>"']|"[^"]*"|'[^']*')*>/gi) ?? []) {
    const key = (attr(tag, "property") ?? attr(tag, "name"))?.toLowerCase();
    const content = attr(tag, "content");
    if (key && content !== undefined && !out.has(key)) out.set(key, content.trim());
  }
  return out;
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 대문자 A–Z만 소문자로. toLowerCase는 İ 같은 글자를 두 글자로 늘려 원문과 위치가 어긋난다. */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** lower에서 from 이후 처음 나오는 <tag 또는 </tag(뒤가 이름 글자가 아닌 것)의 위치. </scripture는 </script가 아니다. */
function tagAt(lower: string, prefix: string, from: number): number {
  for (let i = lower.indexOf(prefix, from); i >= 0; i = lower.indexOf(prefix, i + 1)) {
    if (!/[a-z0-9-]/.test(lower[i + prefix.length] ?? "")) return i;
  }
  return -1;
}

/** lower에서 from 이후 처음 나오는 <tag(뒤가 글자가 아닌 것)의 위치. */
function openAt(lower: string, tag: string, from: number): number {
  return tagAt(lower, `<${tag}`, from);
}

/**
 * 주석과 지정한 태그 블록(<script>…</script> 등)을 지운다. 남의 페이지는 닫히지 않은 태그가 수만 개일 수 있어,
 * 정규식 대신 indexOf로 앞에서 뒤로 한 번만 훑는다. 닫히지 않은 블록은 끝까지 지운다.
 */
function removeBlocks(html: string, tags: string[]): string {
  const lower = asciiLower(html);
  const next = new Map<string, number>();
  const find = (key: string, from: number) => {
    let at = next.get(key);
    if (at === undefined || (at >= 0 && at < from)) {
      at = key === "!--" ? lower.indexOf("<!--", from) : openAt(lower, key, from);
      next.set(key, at);
    }
    return at;
  };
  let out = "", i = 0;
  for (;;) {
    let start = -1, tag = "";
    for (const key of ["!--", ...tags]) {
      const at = find(key, i);
      if (at >= 0 && (start < 0 || at < start)) { start = at; tag = key; }
    }
    if (start < 0) return out + html.slice(i);
    out += `${html.slice(i, start)} `;
    if (tag === "!--") {
      const close = lower.indexOf("-->", start + 4);
      i = close < 0 ? html.length : close + 3;
    } else {
      const close = tagAt(lower, `</${tag}`, start + tag.length + 1);
      const gt = close < 0 ? -1 : lower.indexOf(">", close);
      i = gt < 0 ? html.length : gt + 1;
    }
  }
}

/** 첫 <title>의 글자. 주석·스크립트를 지운 뒤에 찾으므로 스크립트 문자열 속 <title>은 읽지 않는다. */
function titleOf(clean: string): string {
  const lower = asciiLower(clean);
  const open = openAt(lower, "title", 0);
  if (open < 0) return "";
  const gt = lower.indexOf(">", open);
  const close = gt < 0 ? -1 : tagAt(lower, "</title", gt);
  return close < 0 ? "" : decode(clean.slice(gt + 1, close).trim());
}

/** 검색엔진과 방문자가 보는 부분만 남긴다: 주석, 스크립트, 스타일, 템플릿을 뺀다. */
const visible = (rawHtml: string) => removeBlocks(rawHtml.slice(0, MAX_HTML), ["script", "style", "noscript", "template"]);

export function checkPage(rawHtml: string): CheckItem[] {
  const html = visible(rawHtml);
  const m = metas(html);
  const title = titleOf(html);
  const description = m.get("description") ?? "";
  const ogTitle = m.get("og:title"), ogDesc = m.get("og:description");
  const ogImage = m.get("og:image") ?? m.get("twitter:image");
  const card = m.get("twitter:card");
  // [^<>]: 닫히지 않은 < 가 많아도 선형으로 지운다.
  const body = removeBlocks(html, ["head"]).replace(/<[^<>]*>/g, " ");
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

/** url은 리다이렉트를 따라간 뒤 실제로 연 주소다. */
export type Fetched = { status: number; contentType: string; body: string; url?: string } | undefined;

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
  // xml로 와도 urlset·sitemapindex가 없으면 사이트맵이 아니다(200으로 온 오류 문서).
  if (!/<(?:urlset|sitemapindex)\b/i.test(res.body)) return { id: "sitemap", level: "fail", value: /<html\b/i.test(res.body) ? "html" : "invalid" };
  return { id: "sitemap", level: "ok", value: String(sitemapLocs(res.body).length) };
}

/** 홈페이지의 검색 제목과 설명 원문(자르지 않음). 문구 일관성 점검(core/consistency)에 쓴다. */
export function pageCopy(rawHtml: string): { title?: string; description?: string } {
  const html = visible(rawHtml);
  const title = titleOf(html);
  const description = decode(metas(html).get("description") ?? "");
  return { title: title || undefined, description: description || undefined };
}

/** 사이트의 기준 경로. 마지막 마디가 파일(index.html)이면 그 폴더다. 루트는 빈 문자열. */
export function siteBase(homepage: string): string {
  const path = new URL(homepage).pathname;
  const dir = /\/[^/]*\.[^/]*$/.test(path) ? path.replace(/\/[^/]*$/, "") : path;
  return dir.replace(/\/+$/, "");
}

/** url이 홈페이지와 같은 출처이고 홈페이지 경로 아래(또는 그 폴더 자신)인가. GitHub Pages 프로젝트 사이트는 출처를 다른 프로젝트와 나눠 쓴다. */
export function withinSite(url: string, homepage: string): boolean {
  let u: URL, home: URL;
  try { u = new URL(url); home = new URL(homepage); } catch { return false; }
  const base = siteBase(homepage);
  return u.origin === home.origin && (!base || u.pathname === base || u.pathname.startsWith(`${base}/`));
}

/** 사이트맵의 <loc> 주소들. 주석으로 막은 항목(<!-- <url>…</url> -->)은 사이트맵에 없는 것이다. */
export function sitemapLocs(xml: string): string[] {
  return [...removeBlocks(xml.slice(0, MAX_HTML), []).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decode(m[1]!));
}

/**
 * sitemap.xml에서 홈페이지 경로 아래의 페이지 주소를 순서대로 limit개까지(홈페이지 자신은 뺀다).
 * 생성기로 만든 하위 페이지(BarShelf 위젯 25개 등)가 검색 노출 대부분을 받으므로 홈페이지만 보면 모자라다.
 */
export function sitemapPages(xml: string, homepage: string, limit: number): string[] {
  // 쿼리가 다르면 다른 페이지다(/?page=2). 끝 / 차이와 #만 같은 것으로 본다.
  const norm = (u: URL) => `${u.origin}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  const home = norm(new URL(homepage));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const loc of sitemapLocs(xml)) {
    let url: URL;
    try { url = new URL(loc); } catch { continue; }
    if (!withinSite(url.href, homepage) || norm(url) === home || /\.(xml|png|jpe?g|gif|webp|svg|pdf|zip)$/i.test(url.pathname)) continue;
    url.hash = "";
    if (!seen.has(url.href)) { seen.add(url.href); out.push(url.href); }
    if (out.length >= limit) break;
  }
  return out;
}
