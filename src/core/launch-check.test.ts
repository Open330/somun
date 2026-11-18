import { describe, expect, it } from "vitest";
import { checkPage, checkRobots, checkSitemap, pageCopy, siteBase, sitemapPages, withinSite } from "./launch-check.js";

const level = (items: ReturnType<typeof checkPage>, id: string) => items.find((i) => i.id === id)?.level;

describe("checkPage", () => {
  it("passes a page that search engines and link previews can read", () => {
    const html = `<html><head><title>somun — release notes your users understand</title>
      <meta name="description" content="Turns GitHub releases and commits into posts for X, LinkedIn, and Show HN." />
      <meta property="og:title" content="somun" /><meta property="og:description" content="Drafts from your actual work." />
      <meta property="og:image" content="https://somun.jiun.dev/og.png" /><meta name="twitter:card" content="summary_large_image" />
      </head><body><div id="root"><h1>Built a lot, but hard to explain?</h1><p>somun drafts posts from your releases.</p></div></body></html>`;
    expect(checkPage(html).every((i) => i.level === "ok")).toBe(true);
  });

  it("flags an empty SPA shell with no description or share image", () => {
    const html = `<html><head><title>app</title><script>var x = "lots of text that is not visible content at all";</script></head><body><div id="root"></div><script src="/main.js"></script></body></html>`;
    const items = checkPage(html);
    expect(level(items, "title")).toBe("warn");
    expect(level(items, "description")).toBe("fail");
    expect(level(items, "og_image")).toBe("fail");
    expect(level(items, "text_without_js")).toBe("fail");
  });

  it("warns on a relative share image", () => {
    expect(level(checkPage(`<meta property="og:image" content="/og.png">`), "og_image")).toBe("warn");
  });
});

describe("robots and sitemap", () => {
  it("treats a missing robots.txt as allowed and an HTML fallback as broken", () => {
    expect(checkRobots({ status: 404, contentType: "text/html", body: "" }).level).toBe("ok");
    expect(checkRobots({ status: 200, contentType: "text/html", body: "<!doctype html>" })).toEqual({ id: "robots", level: "fail", value: "html" });
  });

  it("catches a site that blocks every crawler", () => {
    expect(checkRobots({ status: 200, contentType: "text/plain", body: "User-agent: *\nDisallow: /\n" }).value).toBe("disallow");
    expect(checkRobots({ status: 200, contentType: "text/plain", body: "User-agent: *\nDisallow: /api/\n" }).level).toBe("ok");
  });

  it("counts sitemap URLs and rejects HTML", () => {
    expect(checkSitemap({ status: 200, contentType: "application/xml", body: "<urlset><url><loc>a</loc></url><url><loc>b</loc></url></urlset>" })).toEqual({ id: "sitemap", level: "ok", value: "2" });
    expect(checkSitemap({ status: 200, contentType: "text/html", body: "<!doctype html>" }).level).toBe("fail");
    expect(checkSitemap(undefined).level).toBe("warn");
  });
});

const urlsetOf = (...locs: string[]) => `<urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join("")}</urlset>`;

describe("hostile pages", () => {
  it("parses malformed pages in linear time", () => {
    for (const html of ["<".repeat(200_000), "<script".repeat(28_000), "<title>".repeat(28_000), "<meta".repeat(40_000), "<!--".repeat(50_000), "<head".repeat(40_000)]) {
      const start = performance.now();
      checkPage(html);
      pageCopy(html);
      expect(performance.now() - start).toBeLessThan(300);
    }
  });

  it("reads quoted < in meta, keeps offsets with non-ASCII letters, and needs an exact closing tag", () => {
    expect(level(checkPage(`<meta name="description" content="Find items whose price is < $20 in seconds, every day.">`), "description")).toBe("ok");
    expect(pageCopy(`<head><meta name="author" content="İ"><title>Product launch notes</title></head>`).title).toBe("Product launch notes");
    expect(pageCopy(`<script>const x = "</scripture><title>Wrong title</title>";</script><title>Correct title</title>`).title).toBe("Correct title");
    const start = performance.now();
    for (const html of [`<meta "`.repeat(30_000), `<meta '`.repeat(30_000), `<meta content="${"a".repeat(100_000)}`]) checkPage(html);
    expect(performance.now() - start).toBeLessThan(300);
  });

  it("does not read a title from script text and ignores commented sitemap entries", () => {
    expect(pageCopy(`<script>const t = "<title>Uses MinIO</title>";</script><title>Product</title>`).title).toBe("Product");
    expect(sitemapPages(`<urlset><!-- <url><loc>https://a.example/old</loc></url> --><url><loc>https://a.example/new</loc></url></urlset>`, "https://a.example/", 10)).toEqual(["https://a.example/new"]);
  });
});

describe("sitemap pages and page copy", () => {
  it("lists same-origin pages in order, without the homepage, files or duplicates", () => {
    const xml = `<urlset><url><loc>https://barshelf.jiun.dev/</loc></url><url><loc>https://barshelf.jiun.dev/widgets/weather</loc></url>
      <url><loc>https://other.dev/x</loc></url><url><loc>https://barshelf.jiun.dev/og.png</loc></url>
      <url><loc>https://barshelf.jiun.dev/widgets/weather#top</loc></url><url><loc>https://barshelf.jiun.dev/widgets/battery</loc></url></urlset>`;
    expect(sitemapPages(xml, "https://barshelf.jiun.dev", 10)).toEqual(["https://barshelf.jiun.dev/widgets/weather", "https://barshelf.jiun.dev/widgets/battery"]);
    expect(sitemapPages(xml, "https://barshelf.jiun.dev/", 1)).toEqual(["https://barshelf.jiun.dev/widgets/weather"]);
  });

  it("rejects an XML document that is not a sitemap", () => {
    expect(checkSitemap({ status: 200, contentType: "application/xml", body: "<error>Not found</error>" })).toEqual({ id: "sitemap", level: "fail", value: "invalid" });
  });

  it("uses the folder of an index document as the site base and keeps query pages", () => {
    expect(siteBase("https://a.example/project/index.html")).toBe("/project");
    expect(siteBase("https://a.example/project/")).toBe("/project");
    expect(siteBase("https://a.example/")).toBe("");
    expect(withinSite("https://a.example/project/docs", "https://a.example/project/index.html")).toBe(true);
    expect(sitemapPages(urlsetOf("https://example.org/", "https://example.org/?page=2"), "https://example.org/", 10)).toEqual(["https://example.org/?page=2"]);
  });

  it("tells whether a URL stays under the homepage path", () => {
    expect(withinSite("https://open330.github.io/tend/docs/", "https://open330.github.io/tend/")).toBe(true);
    expect(withinSite("https://open330.github.io/tend", "https://open330.github.io/tend/")).toBe(true);
    expect(withinSite("https://open330.github.io/tendency/", "https://open330.github.io/tend/")).toBe(false);
    expect(withinSite("https://docs.example/x", "https://open330.github.io/tend/")).toBe(false);
    expect(withinSite("https://barshelf.jiun.dev/widgets/a", "https://barshelf.jiun.dev")).toBe(true);
  });

  it("keeps only pages under a project site's path", () => {
    const xml = `<urlset><url><loc>https://open330.github.io/</loc></url><url><loc>https://open330.github.io/kiwimu/</loc></url>
      <url><loc>https://open330.github.io/tend/</loc></url><url><loc>https://open330.github.io/tend/docs/</loc></url><url><loc>https://open330.github.io/tendency/</loc></url></urlset>`;
    expect(sitemapPages(xml, "https://open330.github.io/tend/", 10)).toEqual(["https://open330.github.io/tend/docs/"]);
  });

  it("reads the full title and description", () => {
    expect(pageCopy(`<title>BarShelf &amp; widgets</title><meta name="description" content="One icon for your menu bar.">`)).toEqual({ title: "BarShelf & widgets", description: "One icon for your menu bar." });
    expect(pageCopy("<p>no head</p>")).toEqual({ title: undefined, description: undefined });
    expect(pageCopy(`<!-- <title>Uses MinIO</title> --><title>Product</title>`).title).toBe("Product");
  });
});
