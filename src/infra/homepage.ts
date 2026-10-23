import { publicFetch } from "./net.js";
import type { HomepageCopyUnit, HomepageSource } from "../shared/types.js";

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

type CopyNode = {
  tag: string; ignored: boolean; main: boolean; language?: string; explicitLanguage?: boolean; closed: boolean;
  parent?: CopyNode; children: (CopyNode | string)[];
};
const copyHeadings = /^h[1-6]$/;
const copyScopes = new Set(["div", "article", "section", "details"]);
function copyLanguage(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(normalized) ? normalized : undefined;
}
function copyDescendants(node: CopyNode): CopyNode[] {
  return node.children.flatMap(child => typeof child === "string" || child.ignored ? [] : [child, ...copyDescendants(child)]);
}
function copyText(node: CopyNode, language: string): string {
  if (node.ignored) return "";
  return node.children.map(child => typeof child === "string" ? (node.language === language ? child : "")
    : child.tag === "br" ? "\n" : copyText(child, language)).join("");
}
function textLanguages(node: CopyNode): Set<string | undefined> {
  if (node.ignored) return new Set();
  const languages = new Set<string | undefined>();
  for (const child of node.children) {
    if (typeof child === "string") { if (clean(child)) languages.add(node.language); }
    else for (const language of textLanguages(child)) languages.add(language);
  }
  return languages;
}
function completeLanguage(node: CopyNode, language: string): boolean {
  const languages = textLanguages(node);
  if (languages.size === 1) return languages.has(language);
  // Parallel whole translated branches are supported; mixed inline-language conditions are not.
  const branches = node.children.filter(child => typeof child === "string" ? Boolean(clean(child)) : textLanguages(child).size > 0);
  const branchLanguages = new Set<string>();
  for (const branch of branches) {
    if (typeof branch === "string" || !branch.explicitLanguage || !branch.language || textLanguages(branch).size !== 1 || branchLanguages.has(branch.language)) return false;
    branchLanguages.add(branch.language);
  }
  return branchLanguages.has(language);
}
/** Whole closed heading/paragraph units only. This is not a certificate of all document conditions. */
function homepageCopyUnits(root: CopyNode, hasMain: boolean): HomepageCopyUnit[] {
  const nodes = copyDescendants(root).filter(node => !hasMain || node.main);
  if (nodes.length > 4_096) return [];
  const headings = nodes.filter(node => copyHeadings.test(node.tag));
  if (headings.length > 128) return [];
  const units: HomepageCopyUnit[] = [];
  const byHeading = new Map<CopyNode, HomepageCopyUnit[]>();
  for (const heading of headings) {
    if (!heading.closed) continue;
    let ancestor = heading.parent;
    while (ancestor && ancestor.tag !== "details") ancestor = ancestor.parent;
    // A summary can limit every descendant claim; do not drop it from an excerpt unit.
    if (ancestor) continue;
    const languages = new Set([heading, ...copyDescendants(heading)].map(node => node.language).filter((value): value is string => Boolean(value)));
    for (const language of languages) {
      const title = clean(copyText(heading, language));
      if (!title || title.length > 240 || !completeLanguage(heading, language)) continue;
      let scope = heading.parent;
      while (scope && !copyScopes.has(scope.tag)) scope = scope.parent;
      while (scope) {
        const content = copyDescendants(scope);
        const scopedHeadings = content.filter(node => copyHeadings.test(node.tag) && clean(copyText(node, language)));
        const paragraphs = content.filter(node => node.tag === "p" && clean(copyText(node, language)));
        if (scopedHeadings.length !== 1 || paragraphs.length > 1) break;
        if (paragraphs.length === 1) {
          const paragraph = paragraphs[0];
          const text = clean(copyText(paragraph, language));
          // Inline conditions stay in the paragraph; lists are separate, unasserted optional material.
          if (scope.closed && paragraph.closed && !copyDescendants(paragraph).some(node => blocks.has(node.tag) && node.tag !== "br") && completeLanguage(paragraph, language) && content.indexOf(paragraph) > content.indexOf(heading) && text.length <= 1_200) {
            const unit: HomepageCopyUnit = { id: `unit-${String(units.length + 1).padStart(3, "0")}`, language, heading: title, paragraph: text };
            units.push(unit);
            byHeading.set(heading, [...(byHeading.get(heading) ?? []), unit]);
          }
          break;
        }
        scope = scope.parent;
        while (scope && !copyScopes.has(scope.tag)) scope = scope.parent;
      }
    }
  }
  // Use the real section outline, never a heading from a preceding sibling section.
  const outlines = new Map<CopyNode, CopyNode[]>();
  for (const heading of headings) {
    let section = heading.parent;
    while (section && section.tag !== "section") section = section.parent;
    if (!section) continue;
    const outline = outlines.get(section) ?? [];
    const level = Number(heading.tag[1]);
    while (outline.length && Number(outline.at(-1)!.tag[1]) >= level) outline.pop();
    const parent = outline.at(-1);
    if (parent) for (const unit of byHeading.get(heading) ?? []) {
      const parentUnit = byHeading.get(parent)?.find(candidate => candidate.language === unit.language);
      if (parentUnit) unit.parentId = parentUnit.id;
    }
    outline.push(heading); outlines.set(section, outline);
  }
  // Bound metadata without truncating any source unit or retaining a dangling parent.
  const bounded = units.slice(0, 48), ids = new Set(bounded.map(unit => unit.id));
  for (const unit of bounded) if (unit.parentId && !ids.has(unit.parentId)) delete unit.parentId;
  return bounded;
}

/** Conservative extraction, not a browser HTML repair engine. Ambiguous nesting is rejected. */
export function homepageText(html: string): { text: string; truncated: boolean; language?: string; siteName?: string; copyUnits?: HomepageCopyUnit[] } | undefined {
  const root: CopyNode = { tag: "root", ignored: false, main: false, closed: true, children: [] };
  const stack: CopyNode[] = [];
  const siteNames = new Set<string>();
  const pieces: { text: string; main: boolean }[] = [];
  let at = 0, language: string | undefined, hasMain = false, copyDepthSupported = true;
  const add = (text: string) => {
    const parent = stack.at(-1);
    if (!parent?.ignored) pieces.push({ text, main: parent?.main ?? false });
  };
  const addRaw = (text: string) => { add(text); (stack.at(-1) ?? root).children.push(text); };
  while (at < html.length) {
    const next = html.indexOf("<", at);
    if (next < 0) { addRaw(html.slice(at)); break; }
    addRaw(html.slice(at, next));
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
      addRaw("<"); at = next + 1; continue;
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
      stack[index].closed = true;
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
    if (tag === "meta" && attrs.get("property")?.toLowerCase() === "og:site_name") {
      const name = attrs.get("content")?.trim();
      if (name) siteNames.add(name);
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
    const node: CopyNode = { tag, ignored, main, language: attrs.has("lang") ? copyLanguage(attrs.get("lang")) : parent?.language, explicitLanguage: attrs.has("lang"), closed: voidTags.has(tag), parent: parent ?? root, children: [] };
    (parent ?? root).children.push(node);
    if (voidTags.has(tag)) continue;
    if (/\/\s*$/.test(tail) && (tag === "svg" || parent?.ignored)) continue;
    stack.push(node);
    if (stack.length > 128) copyDepthSupported = false;
    if (tag === "script" || tag === "style") {
      const close = new RegExp(`</${tag}\\s*>`, "ig"); close.lastIndex = at;
      const found = close.exec(html);
      if (!found) return undefined;
      at = close.lastIndex; stack.pop();
    }
  }
  if (stack.some(x => !optionalEnd.has(x.tag) && x.tag !== "html" && x.tag !== "body")) return undefined;
  const text = clean(pieces.filter(x => !hasMain || x.main).map(x => x.text).join(""));
  const truncated = text.length > MAX_TEXT;
  const siteName = siteNames.size === 1 ? [...siteNames][0] : undefined;
  const copyUnits = !truncated && copyDepthSupported && siteNames.size <= 1 && (!siteName || siteName.length <= 240) ? homepageCopyUnits(root, hasMain) : [];
  return { text: text.slice(0, MAX_TEXT), truncated, language, ...(siteName && siteName.length <= 240 ? { siteName } : {}), ...(copyUnits.length ? { copyUnits } : {}) };
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
