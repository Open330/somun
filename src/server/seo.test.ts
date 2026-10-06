import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../app/context.js";
import { openDb } from "../infra/db/index.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const INDEX = `<html><head><title>somun</title></head><body><div id="root"><!--landing:start--><h1>만든 건 많은데</h1><!--landing:end--></div></body></html>`;

describe("search and link previews", () => {
  let ctx: AppContext;
  let webDir: string;
  const make = (env: Record<string, string> = {}) =>
    createApp(ctx, loadConfig({ SOMUN_TOKEN: "test-token", WEB_DIST: relative(process.cwd(), webDir), ...env }));

  beforeEach(() => {
    webDir = mkdtempSync(join(tmpdir(), "somun-web-"));
    writeFileSync(join(webDir, "index.html"), INDEX);
    ctx = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: {} as AppContext["usage"] };
  });

  afterEach(() => {
    ctx.db.$client.close();
    rmSync(webDir, { recursive: true, force: true });
  });

  it("lets crawlers index only the landing page of a public deployment", async () => {
    const app = make({ SOMUN_PUBLIC_URL: "https://somun.example/" });
    const robots = await app.request("/robots.txt");
    expect(robots.headers.get("content-type")).toContain("text/plain");
    expect(await robots.text()).toContain("Sitemap: https://somun.example/sitemap.xml");
    const sitemap = await app.request("/sitemap.xml");
    expect(sitemap.headers.get("content-type")).toContain("application/xml");
    expect(await sitemap.text()).toContain("<loc>https://somun.example/</loc>");
  });

  it("keeps a private deployment out of search", async () => {
    const app = make();
    expect(await (await app.request("/robots.txt")).text()).toBe("User-agent: *\nDisallow: /\n");
    expect((await app.request("/sitemap.xml")).status).toBe(404);
  });

  it("serves the landing text, canonical URL, and verification tags only on the first page", async () => {
    const app = make({ SOMUN_PUBLIC_URL: "https://somun.example", SOMUN_GOOGLE_SITE_VERIFICATION: "g-token", SOMUN_NAVER_SITE_VERIFICATION: "n\"token" });
    const home = await (await app.request("/")).text();
    expect(home).toContain("만든 건 많은데");
    expect(home).toContain(`<link rel="canonical" href="https://somun.example/" />`);
    expect(home).toContain(`<meta property="og:image" content="https://somun.example/og.png" />`);
    expect(home).toContain(`<meta name="google-site-verification" content="g-token" />`);
    expect(home).toContain(`<meta name="naver-site-verification" content="n&quot;token" />`);
    expect(home).not.toContain("noindex");

    const inner = await (await app.request("/c/12")).text();
    expect(inner).not.toContain("만든 건 많은데");
    expect(inner).toContain(`<meta name="robots" content="noindex" />`);
    expect(inner).not.toContain("canonical");
    expect(inner).not.toContain("site-verification");
  });

  it("serves a rebuilt index.html without a restart and 404s when the web build is missing", async () => {
    const app = make();
    writeFileSync(join(webDir, "index.html"), INDEX.replace("somun", "rebuilt"));
    expect(await (await app.request("/")).text()).toContain("rebuilt");
    rmSync(join(webDir, "index.html"));
    expect((await app.request("/")).status).toBe(404);
    expect((await app.request("/settings")).status).toBe(404);
  });
});

describe("English link previews", () => {
  it("serves an English title, description, and locale when the browser has no Korean", async () => {
    const webDir = mkdtempSync(join(tmpdir(), "somun-web-"));
    writeFileSync(join(webDir, "index.html"), `<html lang="ko"><head><title>소문 — 알릴 내용만</title><meta name="description" content="한국어 설명" /><meta property="og:site_name" content="소문 somun" /><meta property="og:locale" content="ko_KR" /><meta property="og:title" content="한국어 제목" /><meta property="og:description" content="한국어" /></head><body></body></html>`);
    const ctx = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: {} as AppContext["usage"] } as AppContext;
    const app = createApp(ctx, loadConfig({ SOMUN_TOKEN: "t", WEB_DIST: relative(process.cwd(), webDir), SOMUN_PUBLIC_URL: "https://somun.test" }));
    try {
      const en = await app.request("/", { headers: { "Accept-Language": "en-US,en;q=0.9" } });
      const body = await en.text();
      expect(en.headers.get("vary")).toContain("Accept-Language");
      expect(body).toContain('<html lang="en">');
      expect(body).toContain("<title>somun — Say what matters. Make it easy to read.</title>");
      expect(body).toContain('content="en_US"');
      expect(body).not.toContain("한국어 설명");
      expect(body).toContain('content="https://somun.test/og-en.png"');
      const ko = await (await app.request("/", { headers: { "Accept-Language": "en-US,ko;q=0.8" } })).text();
      expect(ko).toContain("<title>소문 — 알릴 내용만</title>");
      expect(await (await app.request("/")).text()).toContain('<html lang="ko">');
    } finally {
      ctx.db.$client.close();
      rmSync(webDir, { recursive: true, force: true });
    }
  });
});
