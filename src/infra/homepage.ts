import { publicFetch } from "./net.js";
import type { HomepageSource } from "../shared/types.js";

const MAX_BYTES = 256 * 1024, MAX_TEXT = 16_000, TIMEOUT_MS = 6_000;
const voidTags = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));
const excluded = new Set("head script style nav header footer svg template iframe".split(" "));
const blocks = new Set("main article section div p h1 h2 h3 h4 h5 h6 li ul ol dl dt dd table tr td th blockquote pre details summary br hr".split(" "));
const optionalEnd = new Set("p li dt dd option optgroup thead tbody tfoot tr td th colgroup rp rt".split(" "));
const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", middot: "·", copy: "©", reg: "®" };
function decode(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (all, name: string) => {
    if (!name.startsWith("#")) return entities[name] ?? all;
    const n = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "�";
  });
}
function clean(text: string): string {
  return decode(text).replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Conservative extraction, not a browser HTML repair engine. Ambiguous nesting is rejected. */
export function homepageText(html: string): { text: string; truncated: boolean; language?: string } | undefined {
  const stack: { tag: string; ignored: boolean; main: boolean }[] = [];
  const pieces: { text: string; main: boolean }[] = [];
  let at = 0, language: string | undefined, hasMain = false;
  const add = (text: string) => {
    const parent = stack.at(-1);
    if (!parent?.ignored) pieces.push({ text, main: parent?.main ?? false });
  };
  while (at < html.length) {
    const next = html.indexOf("<", at);
    if (next < 0) { add(html.slice(at)); break; }
    add(html.slice(at, next));
    if (html.startsWith("<!--", next)) {
      const end = html.indexOf("-->", next + 4);
      if (end < 0) return undefined;
      at = end + 3; continue;
    }
    if (/^<!doctype\b/i.test(html.slice(next, next + 12))) {
      const end = html.indexOf(">", next);
      if (end < 0) return undefined;
      at = end + 1; continue;
    }
    if (!/^<\/?[a-z]/i.test(html.slice(next, next + 3))) {
      // Literal less-than signs in prose are harmless; declarations are not understood.
      if (/^<[!?]/.test(html.slice(next, next + 2))) return undefined;
      add("<"); at = next + 1; continue;
    }
    let end = next + 1, quote = "";
    for (; end < html.length; end++) {
      const ch = html[end];
      if (quote) { if (ch === quote) quote = ""; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
      else if (ch === "<") return undefined;
    }
    if (end >= html.length) return undefined;
    const tagText = html.slice(next + 1, end), closing = tagText.startsWith("/");
    const match = /^\/?([a-z][\w:-]*)([\s\S]*)$/i.exec(tagText);
    if (!match) return undefined;
    const tag = match[1].toLowerCase(), tail = match[2];
    at = end + 1;
    if (closing) {
      if (tail.trim()) return undefined;
      let index = stack.length - 1;
      while (index >= 0 && stack[index].tag !== tag) index--;
      if (index < 0 || stack.slice(index + 1).some(x => !optionalEnd.has(x.tag))) return undefined;
      if (blocks.has(tag)) add("\n");
      stack.splice(index); continue;
    }
    const attrs = new Map<string, string>();
    const attrText = tail.replace(/\/\s*$/, "");
    const attr = /\s+([^\s=<>"'`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gy;
    let cursor = 0;
    while (cursor < attrText.length) {
      if (!attrText.slice(cursor).trim()) break;
      attr.lastIndex = cursor;
      const a = attr.exec(attrText);
      if (!a) return undefined;
      const key = a[1].toLowerCase();
      if (attrs.has(key)) return undefined;
      attrs.set(key, decode(a[2] ?? a[3] ?? a[4] ?? "")); cursor = attr.lastIndex;
    }
    if (tag === "html") language = attrs.get("lang")?.trim().slice(0, 64) || undefined;
    // HTML permits these common omitted end tags. Other malformed nesting is not repaired.
    const top = stack.at(-1)?.tag;
    if ((tag === "li" && top === "li") || (tag === "p" && top === "p") || ((tag === "dt" || tag === "dd") && (top === "dt" || top === "dd"))) stack.pop();
    const parent = stack.at(-1);
    const ignored = Boolean(parent?.ignored || excluded.has(tag) || attrs.has("hidden") || attrs.get("aria-hidden")?.trim().toLowerCase() === "true"
      || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test(attrs.get("style") ?? ""));
    const main = Boolean(parent?.main || tag === "main" || attrs.get("role")?.toLowerCase() === "main");
    if (main && !ignored) hasMain = true;
    if (blocks.has(tag) || attrs.has("lang")) add("\n");
    if (voidTags.has(tag)) continue;
    if (/\/\s*$/.test(tail) && (tag === "svg" || parent?.ignored)) continue;
    stack.push({ tag, ignored, main });
    if (tag === "script" || tag === "style") {
      const close = new RegExp(`</${tag}\\s*>`, "ig"); close.lastIndex = at;
      const found = close.exec(html);
      if (!found) return undefined;
      at = close.lastIndex; stack.pop();
    }
  }
  if (stack.some(x => !optionalEnd.has(x.tag) && x.tag !== "html" && x.tag !== "body")) return undefined;
  const text = clean(pieces.filter(x => !hasMain || x.main).map(x => x.text).join(""));
  return { text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT, language };
}

/** One public URL only. The deadline covers redirects and streaming the response body. */
export async function collectHomepage(url: string): Promise<HomepageSource> {
  const base = { url, collectedAt: Date.now(), truncated: false, text: undefined };
  if (url.length > 2048 || !/^https?:\/\//i.test(url)) return { ...base, status: "failed" };
  const controller = new AbortController();
  let finalUrl: string | undefined, cancel: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); cancel?.(); reject(new Error("homepage timeout")); }, TIMEOUT_MS);
  });
  try {
    return await Promise.race([deadline, (async (): Promise<HomepageSource> => {
      const response = await publicFetch(url, { headers: { Accept: "text/html, text/plain", "User-Agent": "somun (+https://github.com/Open330/somun)" }, signal: controller.signal });
      finalUrl = response.url || url;
      cancel = () => { void response.body?.cancel().catch(() => undefined); };
      const result = { ...base, finalUrl };
      if (!response.ok) { cancel(); return { ...result, status: "failed" }; }
      const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (type !== "text/html" && type !== "text/plain") { cancel(); return { ...result, status: "unsupported" }; }
      if (Number(response.headers.get("content-length")) > MAX_BYTES) { cancel(); return { ...result, status: "too_large", truncated: true }; }
      const reader = response.body?.getReader();
      if (!reader) return { ...result, status: "empty" };
      cancel = () => { void reader.cancel().catch(() => undefined); };
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BYTES) { cancel(); return { ...result, status: "too_large", truncated: true }; }
        chunks.push(part.value);
      }
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      const extracted = type === "text/html" ? homepageText(raw) : { text: raw.trim().slice(0, MAX_TEXT), truncated: raw.trim().length > MAX_TEXT };
      if (!extracted) return { ...result, status: "failed" };
      if (!extracted.text) return { ...result, status: "empty" };
      return { ...result, ...extracted, status: "ok" };
    })()]);
  } catch {
    cancel?.();
    return { ...base, finalUrl, status: "failed" };
  } finally { clearTimeout(timer); }
}
