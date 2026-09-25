import { describe, expect, it } from "vitest";
import { checkPage, checkRobots, checkSitemap } from "./launch-check.js";

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
