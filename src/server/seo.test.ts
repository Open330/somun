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
