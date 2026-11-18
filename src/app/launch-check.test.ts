import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { openDb, schema } from "../infra/db/index.js";
import type { AppContext } from "./context.js";

// 가짜 웹: 주소마다 [상태, 본문, content-type, 리다이렉트 끝 주소]. 연 주소를 모두 기록한다.
type Page = { status?: number; body?: string; type?: string; finalUrl?: string; delayMs?: number };
const web = new Map<string, Page>();
const opened: string[] = [];
vi.mock("../infra/net.js", () => ({
  publicFetch: async (url: string) => {
    opened.push(url);
    const page = web.get(url) ?? { status: 404, body: "not found", type: "text/html" };
    if (page.delayMs) await new Promise((r) => setTimeout(r, page.delayMs));
    const res = new Response(page.body ?? "", { status: page.status ?? 200, headers: { "content-type": page.type ?? "text/html" } });
    Object.defineProperty(res, "url", { value: page.finalUrl ?? url });
    return res;
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

describe("launchCheck copy", () => {
  it("reports no copy result when there is no README to compare with", async () => {
    const { ctx, id } = setup("https://github.com/o/p", { description: "Uses MinIO." });
    expect((await launchCheck(ctx, "o", id)).copy).toBeUndefined();
  });

  it("compares the description with the README even without a homepage", async () => {
    const { ctx, id } = setup("", { description: "Stores prompts in MinIO.", readmeForChecks: "# p\nStores prompts in SQLite.", readmeTruncated: false });
    expect((await launchCheck(ctx, "o", id)).copy).toEqual([{ kind: "not_in_readme", source: "description", term: "MinIO" }]);
  });
});
