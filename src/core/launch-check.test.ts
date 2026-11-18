import { describe, expect, it } from "vitest";
import { checkPage, checkRobots, checkSitemap, pageCopy, siteBase, sitemapPages, trimSlashes, withinSite } from "./launch-check.js";

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
      expect(performance.now() - start).toBeLessThan(1000);
    }
  });

  it("reads quoted < in meta, keeps offsets with non-ASCII letters, and needs an exact closing tag", () => {
    expect(level(checkPage(`<meta name="description" content="Find items whose price is < $20 in seconds, every day.">`), "description")).toBe("ok");
    expect(pageCopy(`<head><meta name="author" content="İ"><title>Product launch notes</title></head>`).title).toBe("Product launch notes");
    expect(pageCopy(`<script>const x = "</scripture><title>Wrong title</title>";</script><title>Correct title</title>`).title).toBe("Correct title");
    const start = performance.now();
    for (const html of [`<meta "`.repeat(30_000), `<meta '`.repeat(30_000), `<meta content="${"a".repeat(100_000)}`]) checkPage(html);
    expect(performance.now() - start).toBeLessThan(1000);
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

  it("reads a quoted <script> in an attribute as text, not as a tag", () => {
    const html = `<head><meta name="description" content="Learn to use the <script> element on your page, step by step."><title>Script element guide</title></head><body><p>Visible text that is long enough to count as content.</p></body>`;
    const items = checkPage(html);
    expect(level(items, "description")).toBe("ok");
    expect(level(items, "text_without_js")).toBe("ok");
    expect(pageCopy(html).title).toBe("Script element guide");
  });

  it("finds the sitemap root element outside comments and trims long slash runs quickly", () => {
    expect(checkSitemap({ status: 200, contentType: "application/xml", body: "<html><!-- expected <urlset> --><p>Not found</p></html>" }).level).toBe("fail");
    expect(checkSitemap({ status: 200, contentType: "application/xml", body: `<?xml version="1.0"?><!-- c --><ns:urlset><url><loc>a</loc></url></ns:urlset>` }).level).toBe("ok");
    expect(trimSlashes("/a///")).toBe("/a");
    const start = performance.now();
    sitemapPages(urlsetOf(`https://a.example/${"/".repeat(90_000)}docs`, `https://a.example/x${"/".repeat(90_000)}`), "https://a.example/", 10);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("reads unquoted meta values and does not take content from data-content", () => {
    expect(level(checkPage(`<meta name=description content="Search and filter every document in your workspace.">`), "description")).toBe("ok");
    expect(pageCopy(`<meta data-content="Internal placeholder" name="description" content="Search and filter every document in your workspace.">`).description).toBe("Search and filter every document in your workspace.");
  });

  it("reads only the page location of each entry, not image or video locations", () => {
    const images = Array.from({ length: 25 }, (_, i) => `<image:image><image:loc>https://a.example/media/render?id=${i}</image:loc></image:image>`).join("");
    const xml = `<urlset><url><loc>https://a.example/</loc>${images}</url><url><loc>https://a.example/docs</loc></url></urlset>`;
    expect(sitemapPages(xml, "https://a.example/", 25)).toEqual(["https://a.example/docs"]);
    expect(checkSitemap({ status: 200, contentType: "application/xml", body: xml })).toEqual({ id: "sitemap", level: "ok", value: "2" });
  });

  it("keeps a dotted folder name as the base and counts slash variants once", () => {
    expect(siteBase("https://host.example/team.docs")).toBe("/team.docs");
    expect(siteBase("https://host.example/team/home.php")).toBe("/team");
    expect(sitemapPages(urlsetOf("https://host.example/team.docs/guide", "https://host.example/other/docs"), "https://host.example/team.docs", 10)).toEqual(["https://host.example/team.docs/guide"]);
    expect(sitemapPages(urlsetOf("https://a.example/p0", "https://a.example/p0/", "https://a.example/pricing"), "https://a.example/", 10)).toEqual(["https://a.example/p0", "https://a.example/pricing"]);
  });

  it("keeps body text when </head> is omitted", () => {
    const text = "Read the complete installation guide and learn how to configure the app for your team.";
    expect(level(checkPage(`<head><title>Product documentation</title><body><p>${text}</p></body>`), "text_without_js")).toBe("ok");
    expect(level(checkPage(`<title>Product documentation</title><p>${text}</p>`), "text_without_js")).toBe("ok");
    expect(level(checkPage(`<head><title>${text}</title></head><body></body>`), "text_without_js")).toBe("fail");
  });

  it("skips nested templates as one inert block", () => {
    const inner = `<meta name="description" content="A description that is long enough for search results."><p>Inert paragraph text that should never count as visible.</p>`;
    const html = `<head><title>Product documentation</title></head><body><template><template></template>${inner}</template></body>`;
    expect(level(checkPage(html), "description")).toBe("fail");
    expect(level(checkPage(html), "text_without_js")).toBe("fail");
    const visible = "Installation and configuration instructions for everyone on your team.";
    expect(level(checkPage(`<template><!-- </template> --><p>${visible}</p></template>`), "text_without_js")).toBe("fail");
    expect(level(checkPage(`<template><div data-example="<template>"></div></template><p>${visible}</p>`), "text_without_js")).toBe("ok");
    expect(level(checkPage(`<template><script>"</template>"</script></template><p>${visible}</p>`), "text_without_js")).toBe("ok");
    expect(sitemapPages(urlsetOf(`https://a.example/${"x".repeat(2100)}`, "https://a.example/ok"), "https://a.example/", 10)).toEqual(["https://a.example/ok"]);
    const start = performance.now();
    checkPage(`<template>${"<template>".repeat(20_000)}${"</template>".repeat(20_000)}`);
    checkPage("<template></template>".repeat(20_000));
    checkPage("<template><script>".repeat(20_000));
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("decodes numeric character references once", () => {
    expect(sitemapPages(`<urlset><url><loc>https://a.example/search?q=x&#38;show=all</loc></url><url><loc>https://a.example/b?x=1&#x26;y=2</loc></url></urlset>`, "https://a.example/", 10)).toEqual(["https://a.example/search?q=x&show=all", "https://a.example/b?x=1&y=2"]);
    expect(pageCopy(`<title>A &amp;lt; B &#8212; C</title>`).title).toBe("A &lt; B — C");
  });

  it("reads namespaced sitemap entries", () => {
    expect(sitemapPages(`<s:urlset xmlns:s="http://www.sitemaps.org/schemas/sitemap/0.9"><s:url><s:loc>https://a.example/docs</s:loc></s:url></s:urlset>`, "https://a.example/", 10)).toEqual(["https://a.example/docs"]);
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
