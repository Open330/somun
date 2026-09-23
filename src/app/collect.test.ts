import { EventEmitter } from "node:events";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, schema } from "../infra/db/index.js";
import { GitHubRateLimitError } from "../infra/github/client.js";
import { collectAll, collectGithubSource, limitationsFrom } from "./collect.js";
import type { AppContext } from "./context.js";

describe("limitationsFrom", () => {
  it("skips an operational note in an IMPORTANT block", () => {
    const readme = "# x\n\n> [!IMPORTANT]\n> After changing `bootstrap.sh`, run `scripts/sync-gh-pages.sh --push`. The copy once went stale.\n\n## Usage\n";
    expect(limitationsFrom(readme)).toEqual([]);
  });
  it("keeps an IMPORTANT block that states a limitation", () => {
    const readme = "# x\n\n> [!WARNING]\n> Windows is not supported yet.\n\n## Usage\n";
    expect(limitationsFrom(readme)).toEqual(["Windows is not supported yet."]);
  });
  it("reads a Limitations section", () => {
    const readme = "# x\n\n## Limitations\n- Requires tmux 3.x\n- No Windows build\n\n## License\nMIT";
    expect(limitationsFrom(readme)).toEqual(["Requires tmux 3.x", "No Windows build"]);
  });
});

describe("collection guards", () => {
  let ctx: AppContext;
  beforeEach(() => { ctx = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: { githubToken: "pat" }, bus: new EventEmitter(), usage: { record: vi.fn() } as unknown as AppContext["usage"] }; });
  afterEach(() => { ctx.db.$client.close(); vi.unstubAllGlobals(); });

  it("runs one collection per owner even when the cron and a manual check overlap", async () => {
    ctx.db.insert(schema.sources).values({ ownerId: "me", kind: "blog", targets: ["https://blog.example/feed.xml"], enabled: true }).run();
    const fetchMock = vi.fn(async () => { await new Promise((r) => setTimeout(r, 20)); return new Response("<rss><channel></channel></rss>", { status: 200 }); });
    vi.stubGlobal("fetch", fetchMock);
    await Promise.all([collectAll(ctx), collectAll(ctx, "me"), collectAll(ctx, "me")]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops at a GitHub rate limit instead of failing every remaining repository", async () => {
    const id = Number(ctx.db.insert(schema.sources).values({ ownerId: "me", kind: "github", targets: ["me/a", "me/b"], enabled: true }).run().lastInsertRowid);
    const repo = (name: string) => ({ full_name: name, html_url: `https://github.com/${name}`, description: null, homepage: null, stargazers_count: 1, forks_count: 0, language: null, license: null, created_at: "2020-01-01T00:00:00Z", pushed_at: new Date().toISOString(), fork: false, archived: false, private: false });
    const fetchMock = vi.fn(async (url: string) => {
      const m = /\/repos\/(me\/[ab])$/.exec(url);
      if (m) return new Response(JSON.stringify(repo(m[1])), { status: 200 });
      return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(collectGithubSource(ctx, id)).rejects.toBeInstanceOf(GitHubRateLimitError);
    // 첫 저장소에서 멈춘다. 두 번째 저장소의 세부 조회는 보내지 않는다.
    const touched = new Set(fetchMock.mock.calls.map(([u]) => /\/repos\/(me\/[ab])\//.exec(String(u))?.[1]).filter(Boolean));
    expect(touched.size).toBe(1);
    expect(ctx.db.select().from(schema.sources).get()?.lastError).toContain("rate limit");
  });
});

it("stops reading a feed body past the byte cap even without Content-Length", async () => {
  const { readCapped } = await import("./collect-blog.js");
  const stream = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(1024)); } });
  expect(await readCapped(new Response(stream), 10_000)).toBeNull();
  expect(await readCapped(new Response("<rss/>"), 10_000)).toBe("<rss/>");
});
