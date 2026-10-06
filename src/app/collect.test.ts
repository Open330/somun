import { EventEmitter } from "node:events";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, schema } from "../infra/db/index.js";
import { GitHubRateLimitError } from "../infra/github/client.js";
import { collectAll, collectGithubSource, closedPullsSince, commitBatch, COMMIT_BATCH_MIN, experimentalFrom, limitationsFrom, missingReads, pagedList } from "./collect.js";
import type { AppContext } from "./context.js";
import { upsertSource } from "./sources.js";

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

  it("normalizes saved URLs and also collects legacy URL targets without requesting a malformed API path", async () => {
    const saved = upsertSource(ctx, "me", { kind: "github", targets: ["https://github.com/me/tool/"], enabled: true });
    expect(saved.targets).toEqual(["me/tool"]);
    ctx.db.update(schema.sources).set({ targets: ["https://github.com/me/tool"] }).run();
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify({ full_name: "me/tool", fork: false, archived: false, pushed_at: "2000-01-01T00:00:00Z" })));
    vi.stubGlobal("fetch", fetchMock);
    await collectGithubSource(ctx, saved.id);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/me/tool");
    expect(() => upsertSource(ctx, "me", { kind: "github", targets: ["https://not-github.test/me/tool"], enabled: true })).toThrow(/GitHub/);
    expect(ctx.db.select().from(schema.sources).all()).toHaveLength(1);
  });

  it.each([403, 404])("records an inaccessible repository (%s) as a failure, not an empty successful collection", async (status) => {
    const saved = upsertSource(ctx, "me", { kind: "github", targets: ["me/missing"], enabled: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));
    expect(await collectAll(ctx, "me")).toMatchObject({ [saved.id]: { error: "GitHub repository unavailable: me/missing" } });
    expect(ctx.db.select().from(schema.sources).get()?.lastError).toContain("repository unavailable");
  });

  it("runs one collection per owner even when the cron and a manual check overlap", async () => {
    ctx.db.insert(schema.sources).values({ ownerId: "me", kind: "blog", targets: ["https://blog.example/feed.xml"], enabled: true }).run();
    const fetchMock = vi.fn(async () => { await new Promise((r) => setTimeout(r, 20)); return new Response("<rss><channel></channel></rss>", { status: 200 }); });
    vi.stubGlobal("fetch", fetchMock);
    await Promise.all([collectAll(ctx), collectAll(ctx, "me"), collectAll(ctx, "me")]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("takes the latest release by publish date, not by the API's list order", async () => {
    const id = Number(ctx.db.insert(schema.sources).values({ ownerId: "me", kind: "github", targets: ["me/tool"], enabled: true }).run().lastInsertRowid);
    const daysAgo = (n: number) => new Date(Date.now() - n * 86400e3).toISOString();
    const repo = { full_name: "me/tool", html_url: "https://github.com/me/tool", description: null, homepage: null, stargazers_count: 5496, forks_count: 0, language: null, license: null, created_at: "2020-01-01T00:00:00Z", pushed_at: daysAgo(1), fork: false, archived: false, private: false };
    // GitHub이 실제로 돌려준 순서처럼 오래된 릴리스가 맨 앞에 온다.
    const releases = [
      { tag_name: "v2026.01.18", name: null, body: "old", html_url: "u0", published_at: daysAgo(260) },
      { tag_name: "v2026.10.01.4", name: null, body: "newest", html_url: "u2", published_at: daysAgo(2) },
      { tag_name: "v2026.10.01.3", name: null, body: "mid", html_url: "u1", published_at: daysAgo(3) },
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/repos/me/tool")) return new Response(JSON.stringify(repo), { status: 200 });
      if (url.includes("/releases")) return new Response(JSON.stringify(releases), { status: 200 });
      if (url.includes("/pulls") || url.includes("/commits")) return new Response("[]", { status: 200 });
      return new Response("{}", { status: 404 });
    }));
    await collectGithubSource(ctx, id);
    const cand = ctx.db.select().from(schema.candidates).get();
    expect(cand?.title).toBe("me/tool v2026.10.01.4");
    expect((cand?.evidence as { version?: string; releaseNotes?: string }).version).toBe("v2026.10.01.4");
    expect((cand?.evidence as { releaseNotes?: string }).releaseNotes).toBe("newest");
    // 처음 연결한 저장소는 이미 넘은 스타 임계값을 마일스톤으로 만들지 않는다.
    expect(ctx.db.select().from(schema.signals).all().filter((s) => s.kind === "star_milestone")).toHaveLength(0);
  });

  it("turns direct pushes to main into one in-progress candidate and does not double-count polled PRs", async () => {
    const id = Number(ctx.db.insert(schema.sources).values({ ownerId: "me", kind: "github", targets: ["me/solo"], enabled: true }).run().lastInsertRowid);
    const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600e3).toISOString();
    const repo = { full_name: "me/solo", html_url: "https://github.com/me/solo", description: null, homepage: null, stargazers_count: 3, forks_count: 0, language: null, license: null, created_at: "2020-01-01T00:00:00Z", pushed_at: iso(1), fork: false, archived: false, private: false };
    const commit = (n: number, msg: string) => ({ sha: `sha${n}`, commit: { message: msg, committer: { date: iso(n) } } });
    let commits = [commit(1, "Add dark mode"), commit(2, "docs: typo"), commit(3, "Support CSV export"), commit(4, "chore: lint")];
    let pulls: { number: number; title: string; merged_at: string; html_url: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/repos/me/solo")) return new Response(JSON.stringify(repo), { status: 200 });
      if (url.includes("/commits")) return new Response(JSON.stringify(commits), { status: 200 });
      if (url.includes("/pulls")) return new Response(JSON.stringify(pulls), { status: 200 });
      if (url.includes("/releases")) return new Response("[]", { status: 200 });
      return new Response("{}", { status: 404 });
    }));
    // 의미 있는 커밋이 모자라면 글감이 아니다(문서·잡일 커밋은 세지 않는다).
    await collectGithubSource(ctx, id);
    expect(ctx.db.select().from(schema.candidates).all()).toHaveLength(0);
    commits = [...commits, commit(5, "Fix crash on empty file"), commit(6, "Add --watch flag"), commit(7, "Speed up parser")];
    await collectGithubSource(ctx, id);
    await collectGithubSource(ctx, id);
    const cands = ctx.db.select().from(schema.candidates).all();
    expect(cands).toHaveLength(1);
    expect(cands[0].type).toBe("in-progress");
    expect(ctx.db.select().from(schema.signals).all().filter((s) => s.kind === "commit_batch")).toHaveLength(1);

    // PR 두 개를 받은 뒤 다음 수집에 같은 두 개와 새 하나가 오면 3개로 센다. 앞서 받은 PR도 같은 글감에 묶인다.
    ctx.db.delete(schema.signals).run(); ctx.db.delete(schema.candidates).run();
    commits = [];
    const pr = (n: number) => ({ number: n, title: `PR ${n}`, merged_at: iso(n), html_url: `u${n}` });
    pulls = [pr(1), pr(2)];
    await collectGithubSource(ctx, id);
    expect(ctx.db.select().from(schema.candidates).all()).toHaveLength(0);
    pulls = [pr(1), pr(2), pr(3)];
    await collectGithubSource(ctx, id);
    const [cand] = ctx.db.select().from(schema.candidates).all();
    expect(cand?.type).toBe("in-progress");
    expect(ctx.db.select().from(schema.signals).all().filter((s) => s.kind === "pr_merged").every((s) => s.candidateId === cand.id)).toBe(true);
  });

  it("collects an explicitly listed fork or quiet repository and reports missing read permissions", async () => {
    const id = Number(ctx.db.insert(schema.sources).values({ ownerId: "me", kind: "github", targets: ["me/fork"], enabled: true }).run().lastInsertRowid);
    const repo = { full_name: "me/fork", html_url: "https://github.com/me/fork", description: null, homepage: null, stargazers_count: 1, forks_count: 0, language: null, license: null, created_at: "2020-01-01T00:00:00Z", pushed_at: "2020-01-01T00:00:00Z", fork: true, archived: false, private: false };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/repos/me/fork")) return new Response(JSON.stringify(repo), { status: 200 });
      if (url.includes("/pulls") || url.includes("/traffic/")) return new Response("{}", { status: 403 });
      if (url.includes("/releases") || url.includes("/commits")) return new Response("[]", { status: 200 });
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await collectGithubSource(ctx, id);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/repos/me/fork/releases"))).toBe(true);
    // 트래픽 403은 관리 권한 문제라 알리지 않는다. PR 403은 알린다.
    expect(ctx.db.select().from(schema.sources).get()?.lastError).toBe("GitHub permission missing: me/fork (pull requests)");
  });

  it("names the readable kinds a repository lacked", () => {
    expect(missingReads(["/repos/a/b/pulls?state=closed", "/repos/a/b/traffic/views", "/repos/a/b/readme", "/repos/a/c/releases"], "a/b")).toEqual(["pull requests", "contents"]);
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

it("finds README sections marked experimental or local-only", () => {
  const readme = "# somun\n## Run it\n## Local development\n## Preview\n### Short videos (experimental, local)\ntext\n## 짧은 영상 (실험)\n## Deploy\n";
  expect(experimentalFrom(readme)).toEqual(["Short videos (experimental, local)", "짧은 영상 (실험)"]);
});

it("counts only reader-visible commits inside the collection window", () => {
  const now = Date.now();
  const c = (sha: string, message: string, ago: number) => ({ sha, commit: { message, committer: { date: new Date(now - ago).toISOString() } } });
  const since = now - 14 * 86400e3;
  const visible = Array.from({ length: COMMIT_BATCH_MIN - 1 }, (_, i) => c(`v${i}`, `Add ${["search", "export", "themes", "sync", "alerts", "tags"][i]}`, (i + 2) * 3600e3));
  const noise = [c("d", "docs: readme", 1000), c("t", "test(api): cover x", 1000), c("m", "Merge branch main", 1000), c("old", "Add old thing", 20 * 86400e3)];
  expect(commitBatch([...visible, ...noise], since)).toBeNull();
  const batch = commitBatch([c("new", "Add webhooks\n\nbody", 3600e3), ...visible, ...noise], since);
  expect(batch?.head).toBe("new");
  expect(batch?.subjects[0]).toBe("Add webhooks");
  expect(batch?.subjects).toHaveLength(COMMIT_BATCH_MIN);
});

it("reads every page of a list instead of stopping at 100", async () => {
  const pages: Record<string, number[]> = { "1": Array.from({ length: 100 }, (_, i) => i), "2": [100, 101] };
  const gh = { get: async (path: string) => pages[/[?&]page=(\d+)/.exec(path)?.[1] ?? ""] ?? [] } as unknown as Parameters<typeof pagedList>[0];
  expect(await pagedList<number>(gh, "/repos/a/b/releases")).toHaveLength(102);
  const none = { get: async () => null } as unknown as Parameters<typeof pagedList>[0];
  expect(await pagedList(none, "/repos/a/b/releases")).toBeNull();
});

it("does not treat bot, deploy, or templated cron commits as reader-visible work", () => {
  const now = Date.now(), since = now - 14 * 86400e3;
  const c = (sha: string, message: string, author?: { login: string; type: string }) => ({ sha, author, commit: { message, committer: { date: new Date(now - 3600e3).toISOString() } } });
  const cron = Array.from({ length: 14 }, (_, i) => c(`h${i}`, `🔮 horoscope 2026-10-${String(i + 1).padStart(2, "0")}`));
  expect(commitBatch(cron, since)).toBeNull();
  expect(commitBatch(Array.from({ length: 10 }, (_, i) => c(`d${i}`, `deploy: Swiq gallery ${i}`)), since)).toBeNull();
  expect(commitBatch(Array.from({ length: 6 }, (_, i) => c(`b${i}`, `Add feature ${"abcdef"[i]}`, { login: "renovate[bot]", type: "Bot" })), since)).toBeNull();
  expect(commitBatch(["Add export", "Fix crash", "Support CSV", "Add --watch", "Speed up parser"].map((m, i) => c(`v${i}`, m)), since)).not.toBeNull();
});

it("does not read a repository name as a missing permission and skips squash-merge commits", () => {
  expect(missingReads(["/repos/acme/commits-lint/traffic/views"], "acme/commits-lint")).toEqual([]);
  expect(missingReads(["/repos/acme/commits-lint/pulls?state=closed"], "acme/commits-lint")).toEqual(["pull requests"]);
  const now = Date.now();
  const c = (sha: string, message: string) => ({ sha, commit: { message, committer: { date: new Date(now - 3600e3).toISOString() } } });
  expect(commitBatch(["feat: a (#1)", "fix: b (#2)", "Add c (#3)", "Add d (#4)", "Add e (#5)"].map((m, i) => c(`s${i}`, m)), now - 14 * 86400e3)).toBeNull();
});

it("reads closed PRs past the first page until the collection window and drops bot PRs", async () => {
  const now = Date.now(), since = now - 14 * 86400e3;
  const pr = (n: number, daysAgo: number, bot = false) => ({ number: n, title: `PR ${n}`, merged_at: new Date(now - daysAgo * 86400e3).toISOString(), html_url: `u${n}`, updated_at: new Date(now - daysAgo * 86400e3).toISOString(), user: bot ? { login: "dependabot[bot]", type: "Bot" } : { login: "me", type: "User" } });
  const page1 = Array.from({ length: 100 }, (_, i) => pr(i, 1, i % 2 === 0));
  const page2 = [pr(200, 3), pr(201, 20)];
  const calls: string[] = [];
  const gh = { get: async (path: string) => { calls.push(path); return /[?&]page=1\b/.test(path) ? page1 : /[?&]page=2\b/.test(path) ? page2 : []; } } as unknown as Parameters<typeof closedPullsSince>[0];
  const prs = await closedPullsSince(gh, "a/b", since);
  expect(prs?.some((p) => p.number === 200)).toBe(true);
  expect(prs?.some((p) => p.user?.type === "Bot")).toBe(false);
  expect(calls).toHaveLength(2);
});
