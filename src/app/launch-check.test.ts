import { EventEmitter } from "node:events";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { openDb, schema } from "../infra/db/index.js";
import type { AppContext } from "./context.js";

// 가짜 웹: 주소마다 [상태, 본문, content-type, 리다이렉트 끝 주소]. 연 주소를 모두 기록한다.
type Page = { status?: number; body?: string | Uint8Array; type?: string; finalUrl?: string; delayMs?: number };
const web = new Map<string, Page>();
const opened: string[] = [];
let inFlight = 0, peak = 0;
vi.mock("../infra/net.js", () => ({
  publicFetch: async (url: string, _init: unknown, _max: number, allowRedirect?: (u: URL) => boolean) => {
    opened.push(url);
    const sub = /^https:\/\/lim\d\.example\/p\d$/.test(url);
    if (sub) { inFlight++; peak = Math.max(peak, inFlight); }
    try {
    const page = web.get(url) ?? { status: 404, body: "not found", type: "text/html" };
    // 실제 publicFetch처럼 리다이렉트 대상은 요청하기 전에 거른다.
    if (page.finalUrl && allowRedirect && !allowRedirect(new URL(page.finalUrl))) throw new Error("redirect out of scope");
    if (page.delayMs) await new Promise((r) => setTimeout(r, page.delayMs));
    const res = new Response((page.body ?? "") as BodyInit, { status: page.status ?? 200, headers: { "content-type": page.type ?? "text/html" } });
    Object.defineProperty(res, "url", { value: page.finalUrl ?? url });
    return res;
    } finally { if (sub) inFlight--; }
  },
}));

const { launchCheck } = await import("./launch-check.js");

const GOOD = (title: string) => `<html><head><title>${title}</title><meta name="description" content="A page description that is long enough for search results.">
  <meta property="og:title" content="t"><meta property="og:description" content="d"><meta property="og:image" content="https://x.dev/og.png"><meta name="twitter:card" content="summary">
  </head><body><p>Plenty of visible text so that crawlers without JavaScript can read this page.</p></body></html>`;
const urlset = (...locs: string[]) => `<?xml version="1.0"?><urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join("")}</urlset>`;

function setup(homepage: string, evidence: Record<string, unknown> = {}) {
  const ctx: AppContext = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: { record() {} } as unknown as AppContext["usage"] };
  const now = Date.now();
  const id = Number(ctx.db.insert(schema.candidates).values({ ownerId: "o", type: "release", title: "t", repo: "o/p", key: `k:${homepage}`, evidence: { repo: "o/p", repoUrl: "https://github.com/o/p", homepage, ...evidence }, status: "new", createdAt: now, updatedAt: now }).run().lastInsertRowid);
  return { ctx, id };
}

describe("launchCheck sub-pages", () => {
  it("does not credit a page whose redirect leaves the project path", async () => {
    const home = "https://a.example/project/";
    web.set(home, { body: GOOD("Project home page title") });
    web.set("https://a.example/sitemap.xml", { body: urlset("https://a.example/project/docs", "https://a.example/project/guide"), type: "application/xml" });
    web.set("https://a.example/project/docs", { body: GOOD("Other project"), finalUrl: "https://a.example/other/docs" });
    web.set("https://a.example/project/guide", { body: GOOD("x") });
    const { ctx, id } = setup(home);
    const res = await launchCheck(ctx, "o", id);
    expect(res.pages).toMatchObject({ total: 2, checked: 1, unreachable: 1 });
    expect(res.pages?.issues.map((p) => p.url)).toEqual(["https://a.example/project/guide"]);
  });

  it("falls back to the root sitemap when the project sitemap is an HTML error page", async () => {
    const home = "https://b.example/project/";
    web.set(home, { body: GOOD("Project home page title") });
    web.set("https://b.example/project/sitemap.xml", { status: 200, body: "<html>Page not found</html>", type: "text/html" });
    web.set("https://b.example/sitemap.xml", { body: urlset("https://b.example/project/docs"), type: "application/xml" });
    web.set("https://b.example/project/docs", { body: GOOD("Docs page title is fine") });
    const { ctx, id } = setup(home);
    expect((await launchCheck(ctx, "o", id)).pages).toMatchObject({ total: 1, checked: 1 });
  });

  it("reads each child sitemap separately so a long first child does not hide the second", async () => {
    const home = "https://c.example/project/";
    web.set(home, { body: GOOD("Project home page title") });
    web.set("https://c.example/sitemap.xml", { body: `<sitemapindex><sitemap><loc>https://c.example/s1.xml</loc></sitemap><sitemap><loc>https://c.example/s2.xml</loc></sitemap></sitemapindex>`, type: "application/xml" });
    web.set("https://c.example/s1.xml", { body: urlset(...Array.from({ length: 2700 }, (_, i) => `https://c.example/other/page-${i}-${"x".repeat(40)}`)), type: "application/xml" });
    web.set("https://c.example/s2.xml", { body: urlset("https://c.example/project/docs"), type: "application/xml" });
    web.set("https://c.example/project/docs", { body: GOOD("Docs page title is fine") });
    const { ctx, id } = setup(home);
    expect((await launchCheck(ctx, "o", id)).pages).toMatchObject({ total: 1, checked: 1 });
  });

  it("crawls once when the same homepage is checked concurrently", async () => {
    const home = "https://d.example/";
    web.set(home, { body: GOOD("Home page title is fine"), delayMs: 20 });
    web.set("https://d.example/sitemap.xml", { body: urlset(...Array.from({ length: 5 }, (_, i) => `https://d.example/p${i}`)), type: "application/xml" });
    for (let i = 0; i < 5; i++) web.set(`https://d.example/p${i}`, { body: GOOD("Sub page title is fine") });
    const { ctx, id } = setup(home);
    opened.length = 0;
    await Promise.all([launchCheck(ctx, "o", id), launchCheck(ctx, "o", id), launchCheck(ctx, "o", id)]);
    expect(opened.filter((u) => /\/p\d$/.test(u))).toHaveLength(5);
  });
});

describe("launchCheck discovery", () => {
  it("treats URLs that differ only by fragment as one crawl", async () => {
    web.set("https://e.example/", { body: GOOD("Home page title is fine"), delayMs: 20 });
    web.set("https://e.example/sitemap.xml", { body: urlset("https://e.example/a", "https://e.example/b"), type: "application/xml" });
    web.set("https://e.example/a", { body: GOOD("Sub page title is fine") });
    web.set("https://e.example/b", { body: GOOD("Sub page title is fine") });
    const one = setup("https://e.example/#one"), two = setup("https://e.example/#two");
    opened.length = 0;
    await Promise.all([launchCheck(one.ctx, "o", one.id), launchCheck(two.ctx, "o", two.id)]);
    expect(opened.filter((u) => u === "https://e.example/a")).toHaveLength(1);
  });

  it("follows a homepage redirect to another host for robots, sitemap and sub-pages", async () => {
    web.set("https://f.example/", { body: GOOD("Home page title is fine"), finalUrl: "https://www.f.example/" });
    web.set("https://f.example/sitemap.xml", { body: urlset("https://f.example/stale"), type: "application/xml" });
    web.set("https://www.f.example/sitemap.xml", { body: urlset("https://www.f.example/docs"), type: "application/xml" });
    web.set("https://www.f.example/docs", { body: GOOD("Docs page title is fine") });
    const { ctx, id } = setup("https://f.example/");
    opened.length = 0;
    expect((await launchCheck(ctx, "o", id)).pages).toMatchObject({ total: 1, checked: 1 });
    expect(opened).not.toContain("https://f.example/sitemap.xml");
  });

  it("rejects an XML-typed error page as the project sitemap and judges the sitemap item by the one used", async () => {
    const home = "https://g.example/project/";
    web.set(home, { body: GOOD("Project home page title") });
    web.set("https://g.example/project/sitemap.xml", { status: 200, body: "<html>Not found</html>", type: "application/xml" });
    web.set("https://g.example/sitemap.xml", { body: urlset("https://g.example/project/docs"), type: "application/xml" });
    web.set("https://g.example/project/docs", { body: GOOD("Docs page title is fine") });
    const { ctx, id } = setup(home);
    expect((await launchCheck(ctx, "o", id)).pages).toMatchObject({ total: 1, checked: 1 });

    const home2 = "https://h.example/project/";
    web.set(home2, { body: GOOD("Project home page title") });
    web.set("https://h.example/project/sitemap.xml", { body: urlset("https://h.example/project/docs"), type: "application/xml" });
    web.set("https://h.example/project/docs", { body: GOOD("Docs page title is fine") });
    const second = setup(home2);
    const res = await launchCheck(second.ctx, "o", second.id);
    expect(res.items.find((i) => i.id === "sitemap")?.level).toBe("ok");
    expect(res.pages).toMatchObject({ checked: 1 });
  });
});

describe("launchCheck limits and coverage", () => {
  it("never opens more than 8 sub-pages at once across concurrent checks", async () => {
    const checks = [];
    for (let site = 0; site < 6; site++) {
      const home = `https://lim${site}.example/`;
      web.set(home, { body: GOOD("Home page title is fine") });
      web.set(`https://lim${site}.example/sitemap.xml`, { body: urlset(...Array.from({ length: 8 }, (_, i) => `https://lim${site}.example/p${i}`)), type: "application/xml" });
      for (let i = 0; i < 8; i++) web.set(`https://lim${site}.example/p${i}`, { body: GOOD("Sub page title is fine"), delayMs: 15 });
      const { ctx, id } = setup(home);
      checks.push(launchCheck(ctx, "o", id));
    }
    peak = 0;
    const results = await Promise.all(checks);
    expect(results.every((r) => r.pages?.checked === 8)).toBe(true);
    // 6곳 × 점검당 4개 = 24개가 한꺼번에 몰릴 수 있지만, 서버 전체 상한 8을 넘지 않아야 한다.
    expect(peak).toBe(8);
  });

  it("counts a child sitemap that could not be opened", async () => {
    const home = "https://m.example/";
    web.set(home, { body: GOOD("Home page title is fine") });
    web.set("https://m.example/sitemap.xml", { body: `<sitemapindex><sitemap><loc>https://m.example/s1.xml</loc></sitemap><sitemap><loc>https://m.example/s2.xml</loc></sitemap></sitemapindex>`, type: "application/xml" });
    web.set("https://m.example/s1.xml", { body: urlset("https://m.example/a"), type: "application/xml" });
    web.set("https://m.example/a", { body: GOOD("Sub page title is fine") });
    const { ctx, id } = setup(home);
    expect((await launchCheck(ctx, "o", id)).pages).toMatchObject({ total: 1, checked: 1, missedSitemaps: 1 });
  });

  it("does not treat a urlset as an index because a comment mentions sitemapindex", async () => {
    const home = "https://r.example/";
    web.set(home, { body: GOOD("Home page title is fine") });
    web.set("https://r.example/sitemap.xml", { body: `<urlset><!-- Replaced the old <sitemapindex> --><url><loc>https://r.example/docs</loc></url></urlset>`, type: "application/xml" });
    web.set("https://r.example/docs", { body: GOOD("Docs page title is fine") });
    const { ctx, id } = setup(home);
    expect((await launchCheck(ctx, "o", id)).pages).toMatchObject({ total: 1, checked: 1 });
  });

  it("counts slash variants across child sitemaps once", async () => {
    const home = "https://s.example/";
    web.set(home, { body: GOOD("Home page title is fine") });
    web.set("https://s.example/sitemap.xml", { body: `<sitemapindex><sitemap><loc>https://s.example/a.xml</loc></sitemap><sitemap><loc>https://s.example/b.xml</loc></sitemap></sitemapindex>`, type: "application/xml" });
    web.set("https://s.example/a.xml", { body: urlset(...Array.from({ length: 13 }, (_, i) => `https://s.example/p${i}`)), type: "application/xml" });
    web.set("https://s.example/b.xml", { body: urlset(...Array.from({ length: 13 }, (_, i) => `https://s.example/p${i}/`), "https://s.example/pricing"), type: "application/xml" });
    for (let i = 0; i < 13; i++) web.set(`https://s.example/p${i}`, { body: GOOD("Sub page title is fine") });
    web.set("https://s.example/pricing", { body: GOOD("Pricing page title fine") });
    const { ctx, id } = setup(home);
    const pages = (await launchCheck(ctx, "o", id)).pages;
    expect(pages).toMatchObject({ total: 14, checked: 14, unreachable: 0 });
  });

  it("reads a gzip child sitemap", async () => {
    const home = "https://t.example/";
    web.set(home, { body: GOOD("Home page title is fine") });
    web.set("https://t.example/sitemap.xml", { body: `<sitemapindex><sitemap><loc>https://t.example/pages.xml.gz</loc></sitemap></sitemapindex>`, type: "application/xml" });
    web.set("https://t.example/pages.xml.gz", { body: gzipSync(urlset("https://t.example/docs")), type: "application/gzip" });
    web.set("https://t.example/docs", { body: GOOD("Docs page title is fine") });
    const { ctx, id } = setup(home);
    expect((await launchCheck(ctx, "o", id)).pages).toMatchObject({ total: 1, checked: 1 });
  });

  it("re-crawls after two minutes when the sitemap failed transiently", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const home = "https://v.example/";
      web.set(home, { body: GOOD("Home page title is fine") });
      web.set("https://v.example/sitemap.xml", { status: 503, body: "busy" });
      const { ctx, id } = setup(home);
      expect((await launchCheck(ctx, "o", id)).pages).toBeUndefined();
      web.set("https://v.example/sitemap.xml", { body: urlset("https://v.example/docs"), type: "application/xml" });
      web.set("https://v.example/docs", { body: GOOD("Docs page title is fine") });
      vi.setSystemTime(Date.now() + 121_000);
      expect((await launchCheck(ctx, "o", id)).pages).toMatchObject({ checked: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-crawls after two minutes when the project sitemap failed transiently and the root one was used", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const home = "https://x.example/project/";
      web.set(home, { body: GOOD("Project home page title") });
      web.set("https://x.example/project/sitemap.xml", { status: 429, body: "slow down" });
      web.set("https://x.example/sitemap.xml", { body: urlset("https://x.example/other/docs"), type: "application/xml" });
      const { ctx, id } = setup(home);
      const first = await launchCheck(ctx, "o", id);
      expect(first.pages).toBeUndefined();
      expect(first.partial).toBe(true);
      web.set("https://x.example/project/sitemap.xml", { body: urlset("https://x.example/project/docs"), type: "application/xml" });
      web.set("https://x.example/project/docs", { body: GOOD("Docs page title is fine") });
      vi.setSystemTime(Date.now() + 121_000);
      expect((await launchCheck(ctx, "o", id)).pages).toMatchObject({ checked: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps only the first 2000 characters of homepage copy", async () => {
    const home = "https://z.example/";
    web.set(home, { body: `<title>Home page title is fine</title><meta name="description" content="한${"x".repeat(199_000)}"><p>Visible text that is long enough to count as content here.</p>` });
    const { ctx, id } = setup(home, { readmeForChecks: "# z", readmeTruncated: false });
    const res = await launchCheck(ctx, "o", id);
    expect(res.items.find((i) => i.id === "description")?.level).toBe("ok");
  });

  it("does not decompress a gzip homepage body", async () => {
    const home = "https://y.example/";
    web.set(home, { body: gzipSync(GOOD("Home page title is fine")), type: "application/gzip" });
    const { ctx, id } = setup(home);
    const res = await launchCheck(ctx, "o", id);
    expect(res.items.find((i) => i.id === "title")?.level).toBe("fail");
  });

  it("reads a gzip child sitemap that starts with a comment", async () => {
    const home = "https://w.example/";
    web.set(home, { body: GOOD("Home page title is fine") });
    web.set("https://w.example/sitemap.xml", { body: `<sitemapindex><sitemap><loc>https://w.example/pages.xml.gz</loc></sitemap></sitemapindex>`, type: "application/xml" });
    web.set("https://w.example/pages.xml.gz", { body: gzipSync(`<!-- generated --><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://w.example/docs</loc></url></urlset>`), type: "application/gzip" });
    web.set("https://w.example/docs", { body: GOOD("Docs page title is fine") });
    const { ctx, id } = setup(home);
    expect((await launchCheck(ctx, "o", id)).pages).toMatchObject({ total: 1, checked: 1 });
  });

  it("re-crawls an incomplete result after two minutes instead of an hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const home = "https://u.example/";
      web.set(home, { body: GOOD("Home page title is fine") });
      web.set("https://u.example/sitemap.xml", { body: urlset("https://u.example/a"), type: "application/xml" });
      web.delete("https://u.example/a");
      const { ctx, id } = setup(home);
      expect((await launchCheck(ctx, "o", id)).pages).toMatchObject({ checked: 0, unreachable: 1 });
      web.set("https://u.example/a", { body: GOOD("Sub page title is fine") });
      vi.setSystemTime(Date.now() + 121_000);
      expect((await launchCheck(ctx, "o", id)).pages).toMatchObject({ checked: 1, unreachable: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads up to five child sitemaps and counts the rest as missed", async () => {
    const home = "https://q.example/";
    web.set(home, { body: GOOD("Home page title is fine") });
    const kids = Array.from({ length: 7 }, (_, i) => `https://q.example/s${i}.xml`);
    web.set("https://q.example/sitemap.xml", { body: `<sitemapindex>${kids.map((k) => `<sitemap><loc>${k}</loc></sitemap>`).join("")}</sitemapindex>`, type: "application/xml" });
    kids.forEach((k, i) => { web.set(k, { body: urlset(`https://q.example/p${i}`), type: "application/xml" }); web.set(`https://q.example/p${i}`, { body: GOOD("Sub page title is fine") }); });
    const { ctx, id } = setup(home);
    expect((await launchCheck(ctx, "o", id)).pages).toMatchObject({ total: 5, checked: 5, missedSitemaps: 2 });
  });

  it("keeps the project folder when the homepage redirects to index.html, and counts every eligible page", async () => {
    const home = "https://n.example/project/";
    web.set(home, { body: GOOD("Project home page title"), finalUrl: "https://n.example/project/index.html" });
    web.set("https://n.example/sitemap.xml", { body: urlset(...Array.from({ length: 101 }, (_, i) => `https://n.example/project/p${i}`)), type: "application/xml" });
    for (let i = 0; i < 25; i++) web.set(`https://n.example/project/p${i}`, { body: GOOD("Sub page title is fine") });
    const { ctx, id } = setup(home);
    expect((await launchCheck(ctx, "o", id)).pages).toMatchObject({ total: 101, checked: 25 });
  });
});

describe("launchCheck copy", () => {
  it("reports no copy result when there is no README to compare with", async () => {
    const { ctx, id } = setup("https://github.com/o/p", { description: "Uses MinIO." });
    expect((await launchCheck(ctx, "o", id)).copy).toBeUndefined();
  });

  it("reports no copy result when there is no copy to compare", async () => {
    const { ctx, id } = setup("", { readmeForChecks: "# p\nA README.", readmeTruncated: false });
    expect((await launchCheck(ctx, "o", id)).copy).toBeUndefined();
  });

  it("compares the description with the README even without a homepage", async () => {
    const { ctx, id } = setup("", { description: "Stores prompts in MinIO.", readmeForChecks: "# p\nStores prompts in SQLite.", readmeTruncated: false });
    expect((await launchCheck(ctx, "o", id)).copy).toEqual([{ kind: "not_in_readme", source: "description", term: "MinIO" }]);
  });
});
