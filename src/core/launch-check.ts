/**
 * 링크를 올리기 전에 홈페이지가 검색엔진과 링크 미리보기(X·LinkedIn 카드)에 어떻게 보이는지 점검한다(순수 함수).
 * 남의 페이지를 정규식으로만 읽으므로 앞부분만 본다. 결과는 항목 id와 짧은 값만 담고, 문장은 화면이 만든다.
 */
export type CheckLevel = "ok" | "warn" | "fail";
export type CheckId = "title" | "description" | "og_text" | "og_image" | "twitter_card" | "text_without_js" | "robots" | "sitemap";
export type CheckItem = { id: CheckId; level: CheckLevel; value?: string };

const MAX_HTML = 200_000;
/** 사이트맵은 수천 항목이라 페이지보다 길다. 한 번에 서버를 오래 붙잡지 않게 500KB까지 읽는다(넘으면 가져올 때 잘렸다고 표시한다). */
export const MAX_SITEMAP = 500_000;

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
/** HTML·XML 문자 참조를 한 번에 푼다(&amp; &#38; &#x26;). 한 번만 풀어야 &amp;lt;가 <로 두 번 풀리지 않는다. */
const decode = (s: string) =>
  s.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|lt|gt|quot|apos));/gi, (whole, dec?: string, hex?: string, name?: string) => {
    if (name) return NAMED[name.toLowerCase()] ?? whole;
    const code = dec ? Number(dec) : parseInt(hex!, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 대문자 A–Z만 소문자로. toLowerCase는 İ 같은 글자를 두 글자로 늘려 원문과 위치가 어긋난다. */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** 끝의 / 를 뗀다. 정규식(/\/+$/)은 / 가 수만 개 이어지면 제곱 시간이 걸린다. */
export function trimSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end--;
  return path.slice(0, end);
}

/** lower에서 from 이후 처음 나오는 </tag(뒤가 이름 글자가 아닌 것)의 위치. </scripture는 </script가 아니다. */
function closeAt(lower: string, tag: string, from: number): number {
  const prefix = `</${tag}`;
  for (let i = lower.indexOf(prefix, from); i >= 0; i = lower.indexOf(prefix, i + 1)) {
    if (!/[a-z0-9-]/.test(lower[i + prefix.length] ?? "")) return i;
  }
  return -1;
}

type Tag = { name: string; closing: boolean; start: number; end: number };

/** 안의 글자를 태그로 읽지 않는 요소(브라우저의 원자료·RCDATA 요소). */
const RAW = new Set(["script", "style", "textarea", "title", "xmp"]);

/**
 * from 이후의 다음 실제 태그(또는 주석, name "!--"). 남의 페이지를 정규식 없이 앞에서 뒤로 한 번만 읽는다.
 * 따옴표로 묶은 속성값 안의 < > 는 값의 일부다(content="<script> 요소"). 닫히지 않은 태그를 만나면 undefined.
 */
function nextTag(html: string, lower: string, from: number): Tag | undefined {
  for (let i = html.indexOf("<", from); i >= 0; i = html.indexOf("<", i + 1)) {
    if (lower.startsWith("<!--", i)) {
      const close = lower.indexOf("-->", i + 4);
      return { name: "!--", closing: false, start: i, end: close < 0 ? html.length : close + 3 };
    }
    const closing = html[i + 1] === "/";
    let j = i + (closing ? 2 : 1);
    if (!/[a-z]/.test(lower[j] ?? "")) continue;
    const nameStart = j;
    while (j < html.length && /[a-z0-9:-]/.test(lower[j]!)) j++;
    const name = lower.slice(nameStart, j);
    // 속성값의 따옴표는 = 바로 뒤에서만 연다(따옴표 없는 값 don't의 ' 는 글자다).
    let quote = "", last = "";
    for (; j < html.length; j++) {
      const ch = html[j]!;
      if (quote) { if (ch === quote) quote = ""; continue; }
      if ((ch === "\"" || ch === "'") && last === "=") quote = ch;
      else if (ch === ">") break;
      if (!/\s/.test(ch)) last = ch;
    }
    if (j >= html.length) return undefined;
    return { name, closing, start: i, end: j + 1 };
  }
  return undefined;
}

/**
 * 태그들을 차례로 돈다. visit가 숫자를 돌려주면 거기서부터 다시 읽는다(블록을 건너뛸 때).
 * 원자료 요소(<title>·<textarea>·<script> 등) 안의 글자는 태그가 아니므로, visit가 건너뛰지 않으면 닫는 태그 앞으로 바로 간다.
 */
function eachTag(html: string, lower: string, visit: (tag: Tag) => number | void, from = 0): void {
  for (let at = from, tag = nextTag(html, lower, from); tag; tag = nextTag(html, lower, at)) {
    const skip = visit(tag);
    if (typeof skip === "number") at = skip;
    else if (!tag.closing && RAW.has(tag.name)) {
      const close = closeAt(lower, tag.name, tag.end);
      at = close < 0 ? html.length : close;
    } else at = tag.end;
  }
}

/** 원자료처럼 읽는 블록(<script>·<style>·<textarea>)의 끝. 안의 글자는 태그가 아니다. 닫는 태그가 없으면 문서 끝까지다. */
function rawEnd(lower: string, tag: Tag): number {
  const close = closeAt(lower, tag.name, tag.end);
  const gt = close < 0 ? -1 : lower.indexOf(">", close);
  return gt < 0 ? lower.length : gt + 1;
}

// 위로 옮김: eachTag가 쓴다.

/**
 * 블록의 끝. <template> 안은 HTML로 읽히므로 같은 토크나이저로 깊이를 센다(주석·속성값 속 <template>은 세지 않는다).
 * 안의 <script> 같은 원자료 블록은 통째로 건너뛴다. 앞으로만 읽으므로 한 번만 훑는다.
 */
function blockEnd(html: string, lower: string, tag: Tag): number {
  if (tag.name !== "template") return rawEnd(lower, tag);
  let depth = 1, end = html.length;
  eachTag(html, lower, (t) => {
    if (t.name === "!--") return;
    if (!t.closing && RAW.has(t.name)) return rawEnd(lower, t);
    if (t.name !== "template") return;
    depth += t.closing ? -1 : 1;
    if (depth === 0) { end = t.end; return html.length; }
  }, tag.end);
  return end;
}

/** 주석과 지정한 태그 블록(<script>…</script> 등)을 지운다. 따옴표 안의 <script>는 태그가 아니다. */
function removeBlocks(html: string, blocks: string[]): string {
  const lower = asciiLower(html);
  const set = new Set(blocks);
  let out = "", copied = 0;
  eachTag(html, lower, (tag) => {
    if (tag.name !== "!--" && (tag.closing || !set.has(tag.name))) return;
    out += `${html.slice(copied, tag.start)} `;
    copied = tag.name === "!--" ? tag.end : blockEnd(html, lower, tag);
    return copied;
  });
  return out + html.slice(copied);
}

/** 태그를 모두 빼고 글자만 남긴다(닫히지 않은 마지막 태그 뒤는 버린다). */
function textOnly(html: string): string {
  const lower = asciiLower(html);
  let out = "", copied = 0;
  eachTag(html, lower, (tag) => {
    out += `${html.slice(copied, tag.start)} `;
    copied = tag.end;
  });
  const rest = html.slice(copied);
  return out + (rest.includes("<") ? rest.slice(0, rest.indexOf("<")) : rest);
}

/**
 * 태그의 속성들(이름은 소문자, 처음 나온 값). 따옴표 없는 값(name=description)도 읽고,
 * data-content 같은 다른 속성의 끝부분을 content로 착각하지 않는다. 앞에서 뒤로 한 번만 걷는다.
 */
function attrs(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 1;
  while (i < raw.length && !/[\s/>]/.test(raw[i]!)) i++;
  const space = (c: string | undefined) => c !== undefined && /\s/.test(c);
  while (i < raw.length) {
    while (i < raw.length && (space(raw[i]) || raw[i] === "/")) i++;
    if (i >= raw.length || raw[i] === ">") break;
    const nameStart = i;
    while (i < raw.length && !/[\s=/>]/.test(raw[i]!)) i++;
    const name = asciiLower(raw.slice(nameStart, i));
    while (space(raw[i])) i++;
    let value = "";
    if (raw[i] === "=") {
      i++;
      while (space(raw[i])) i++;
      const q = raw[i];
      if (q === "\"" || q === "'") {
        const close = raw.indexOf(q, i + 1);
        value = raw.slice(i + 1, close < 0 ? raw.length : close);
        i = close < 0 ? raw.length : close + 1;
      } else {
        const start = i;
        while (i < raw.length && !space(raw[i]) && raw[i] !== ">") i++;
        value = raw.slice(start, i);
      }
    }
    if (name && !out.has(name)) out.set(name, value);
  }
  return out;
}

/** <meta> 태그의 name·property → content. 태그 경계는 nextTag가 따옴표를 보며 정한다. */
function metas(html: string): Map<string, string> {
  const lower = asciiLower(html);
  const out = new Map<string, string>();
  eachTag(html, lower, (tag) => {
    if (tag.name !== "meta" || tag.closing) return;
    const a = attrs(html.slice(tag.start, tag.end));
    const key = (a.get("property") ?? a.get("name"))?.toLowerCase();
    const content = a.get("content");
    if (key && content !== undefined && !out.has(key)) out.set(key, content.trim());
  });
  return out;
}

/**
 * 방문자에게 보이는 본문 글자. <body>가 있으면 그 뒤를, 없으면 </head> 뒤를 읽는다.
 * 둘 다 없으면(생략 가능한 태그) 제목만 빼고 읽는다. </head>가 없다고 문서 끝까지 지우지 않는다.
 */
function bodyText(html: string): string {
  const lower = asciiLower(html);
  let bodyAt = -1;
  eachTag(html, lower, (tag) => {
    if (tag.name !== "body" || tag.closing) return;
    bodyAt = tag.end;
    return html.length;
  });
  if (bodyAt >= 0) return textOnly(html.slice(bodyAt));
  const headClose = closeAt(lower, "head", 0);
  const gt = headClose < 0 ? -1 : lower.indexOf(">", headClose);
  return gt >= 0 ? textOnly(html.slice(gt + 1)) : textOnly(removeBlocks(html, ["title"]));
}

/** 사이트맵 주소를 같은 페이지끼리 묶는 열쇠: 끝 / 와 # 차이는 같은 페이지, 쿼리가 다르면 다른 페이지. */
export function pageKey(url: string): string {
  const u = new URL(url);
  return `${u.origin}${trimSlashes(u.pathname)}${u.search}`;
}

/** 첫 <title>의 글자. 주석·스크립트를 지운 뒤에 찾고, 속성값 속 <title>은 태그로 보지 않는다. */
function titleOf(clean: string): string {
  const lower = asciiLower(clean);
  let title = "";
  eachTag(clean, lower, (tag) => {
    if (tag.name !== "title" || tag.closing) return;
    const close = closeAt(lower, "title", tag.end);
    title = close < 0 ? "" : decode(clean.slice(tag.end, close).trim());
    return clean.length;
  });
  return title;
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
  const body = bodyText(html);
  const text = decode(body).replace(/\s+/g, " ").trim();

  return [
    { id: "title", level: !title ? "fail" : title.length < 10 || title.length > 70 ? "warn" : "ok", value: title ? clip(title) : undefined },
    { id: "description", level: !description ? "fail" : description.length < 40 ? "warn" : "ok", value: description ? clip(description) : undefined },
    { id: "og_text", level: ogTitle && ogDesc ? "ok" : ogTitle || ogDesc ? "warn" : "fail", value: ogTitle ? clip(ogTitle) : undefined },
    // og:image는 절대 주소여야 카드에 뜬다. 상대 주소는 대부분의 미리보기가 무시한다.
    { id: "og_image", level: !ogImage ? "fail" : /^https?:\/\//i.test(ogImage) ? "ok" : "warn", value: ogImage ? clip(ogImage) : undefined },
    { id: "twitter_card", level: card ? "ok" : "warn", value: card ? clip(card) : undefined },
    // JS를 돌리지 않는 크롤러(네이버 등)와 미리보기는 빈 SPA 껍데기만 본다.
    { id: "text_without_js", level: text.length >= 40 ? "ok" : "fail", value: text ? clip(text, 60) : undefined },
  ];
}

/** url은 리다이렉트를 따라간 뒤 실제로 연 주소다. truncated면 크기 한도에서 잘려 뒷부분을 못 읽었다. */
export type Fetched = { status: number; contentType: string; body: string; url?: string; truncated?: boolean } | undefined;

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
  // content-type이 아니라 첫 요소로 판정한다. 압축 사이트맵(application/gzip)이나 주석으로 시작하는 문서도 사이트맵일 수 있고,
  // xml로 온 오류 문서나 주석 속 <urlset>은 사이트맵이 아니다.
  const root = sitemapRoot(res.body);
  if (root === "urlset" || root === "sitemapindex") return { id: "sitemap", level: "ok", value: String(sitemapLocs(res.body).length) };
  return { id: "sitemap", level: "fail", value: root === "html" || /html/i.test(res.contentType) ? "html" : "invalid" };
}

/** 홈페이지의 검색 제목과 설명 원문(자르지 않음). 문구 일관성 점검(core/consistency)에 쓴다. */
export function pageCopy(rawHtml: string): { title?: string; description?: string } {
  const html = visible(rawHtml);
  const title = titleOf(html);
  const description = decode(metas(html).get("description") ?? "");
  return { title: title || undefined, description: description || undefined };
}

/** XML 글자: 문자 참조는 풀고, CDATA 구간(<![CDATA[…]]>)은 그대로 이어 붙인다. 섞여 있어도 앞에서 뒤로 한 번만 읽는다. */
function xmlText(raw: string): string {
  let out = "", at = 0;
  for (;;) {
    const open = raw.indexOf("<![CDATA[", at);
    if (open < 0) return out + decode(raw.slice(at));
    const close = raw.indexOf("]]>", open + 9);
    out += decode(raw.slice(at, open)) + raw.slice(open + 9, close < 0 ? raw.length : close);
    if (close < 0) return out;
    at = close + 3;
  }
}

/** 사이트맵 문서의 첫 요소 이름(<?xml …?>과 주석은 건너뛴다). 이름공간 접두어(ns:urlset)는 뗀다. */
export function sitemapRoot(xml: string): string | undefined {
  const head = xml.slice(0, MAX_SITEMAP);
  const lower = asciiLower(head);
  let root: string | undefined;
  eachTag(head, lower, (tag) => {
    if (tag.name === "!--" || tag.closing) return;
    root = tag.name.split(":").at(-1);
    return head.length;
  });
  return root;
}

/** 사이트의 기준 경로. 마지막 마디가 문서 파일(index.html, home.php)이면 그 폴더다. /team.docs처럼 점이 든 경로는 폴더 이름이다. 루트는 빈 문자열. */
export function siteBase(homepage: string): string {
  const path = new URL(homepage).pathname;
  const lastSlash = path.lastIndexOf("/");
  const dir = /\.(?:html?|xhtml|php|aspx?|jsp)$/i.test(path.slice(lastSlash + 1)) ? path.slice(0, lastSlash) : path;
  return trimSlashes(dir);
}

/** url이 홈페이지와 같은 출처이고 홈페이지 경로 아래(또는 그 폴더 자신)인가. GitHub Pages 프로젝트 사이트는 출처를 다른 프로젝트와 나눠 쓴다. */
export function withinSite(url: string, homepage: string): boolean {
  let u: URL, home: URL;
  try { u = new URL(url); home = new URL(homepage); } catch { return false; }
  const base = siteBase(homepage);
  return u.origin === home.origin && (!base || u.pathname === base || u.pathname.startsWith(`${base}/`));
}

/**
 * 사이트맵의 페이지(또는 하위 사이트맵) 주소들. 각 <url>·<sitemap> 안에서 같은 이름공간 접두어의 첫 <loc>만 읽는다.
 * <image:loc>·<video:loc> 같은 첨부 주소는 페이지가 아니다. 주석으로 막은 항목은 사이트맵에 없는 것이다.
 */
export function sitemapLocs(xml: string): string[] {
  const doc = xml.slice(0, MAX_SITEMAP);
  const lower = asciiLower(doc);
  const out: string[] = [];
  let entryPrefix: string | undefined;
  eachTag(doc, lower, (tag) => {
    if (tag.name === "!--") return;
    const [prefix, local] = tag.name.includes(":") ? [tag.name.slice(0, tag.name.lastIndexOf(":")), tag.name.slice(tag.name.lastIndexOf(":") + 1)] : ["", tag.name];
    if (local === "url" || local === "sitemap") { entryPrefix = tag.closing ? undefined : prefix; return; }
    if (local !== "loc" || tag.closing || entryPrefix !== prefix) return;
    const close = closeAt(lower, tag.name, tag.end);
    if (close < 0) return doc.length;
    const value = xmlText(doc.slice(tag.end, close)).trim();
    if (value && !/\s/.test(value)) out.push(value);
    entryPrefix = undefined;
    return close;
  });
  return out;
}

/**
 * sitemap.xml에서 홈페이지 경로 아래의 페이지 주소를 순서대로 limit개까지(홈페이지 자신은 뺀다).
 * 생성기로 만든 하위 페이지(BarShelf 위젯 25개 등)가 검색 노출 대부분을 받으므로 홈페이지만 보면 모자라다.
 */
export function sitemapPages(xml: string, homepage: string, limit: number): string[] {
  // 쿼리가 다르면 다른 페이지다(/?page=2). 끝 / 차이와 #만 같은 것으로 본다.
  const home = pageKey(homepage);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const loc of sitemapLocs(xml)) {
    let url: URL;
    // 사이트맵 규약의 주소 길이 상한(2048자)을 넘는 항목은 건너뛴다. 결과와 기억에 아주 긴 주소가 쌓이지 않게.
    try { url = new URL(loc); } catch { continue; }
    if (url.href.length > 2048) continue;
    if (!withinSite(url.href, homepage) || pageKey(url.href) === home || /\.(xml|png|jpe?g|gif|webp|svg|pdf|zip)$/i.test(url.pathname)) continue;
    url.hash = "";
    // /p0와 /p0/는 같은 페이지로 본다(한쪽이 다른 쪽으로 넘어가는 경우가 대부분이라 자리를 두 번 쓰지 않게).
    const key = pageKey(url.href);
    if (!seen.has(key)) { seen.add(key); out.push(url.href); }
    if (out.length >= limit) break;
  }
  return out;
}
