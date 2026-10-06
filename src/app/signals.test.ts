import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import pino from "pino";
import { openDb, schema } from "../infra/db/index.js";
import type { Evidence } from "../shared/types.js";
import type { AppContext } from "./context.js";
import { migrateLegacyCandidates } from "./candidates.js";
import { ingestSignals } from "./signals.js";

const DAY = 86400e3;
function makeCtx(): AppContext {
  const db = openDb(":memory:");
  return { db, log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: { record() {} } as unknown as AppContext["usage"] };
}
const ev = (repo: string): Evidence => ({ repo, repoUrl: `https://github.com/${repo}`, stars: 30 });

describe("repo-window candidates", () => {
  it("folds release, milestones and PRs of one repo into a single candidate", () => {
    const ctx = makeCtx();
    const now = Date.now();
    ctx.db.insert(schema.sources).values({ ownerId: "o", kind: "github", targets: ["a/x"], enabled: true }).run();
    ingestSignals(ctx, "o", 1, [
      { kind: "star_milestone", repo: "a/x", ref: "gh:stars:a/x#25", title: "a/x stars 25", payload: { threshold: 25 }, occurredAt: now },
      { kind: "release", repo: "a/x", ref: "gh:release:a/x@v1.2.0", title: "a/x v1.2.0", payload: { tag: "v1.2.0" }, occurredAt: now },
      { kind: "download_milestone", repo: "a/x", ref: "npm:dl:x#100", title: "x 100", payload: { threshold: 100 }, occurredAt: now },
    ], {}, ev("a/x"));
    const rows = ctx.db.select().from(schema.candidates).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("release");
    expect(rows[0].title).toBe("a/x v1.2.0");
    expect(rows[0].key.startsWith("repo:a/x:")).toBe(true);
    const e = rows[0].evidence as Evidence;
    expect(e.milestones?.map((m) => `${m.metric}-${m.threshold}`)).toEqual(["stars-25", "downloads-100"]);
  });

  it("reopens a judged candidate for judgment when a newer release joins it, but keeps drafted ones", () => {
    const ctx = makeCtx();
    const now = Date.now();
    ctx.db.insert(schema.sources).values({ ownerId: "o", kind: "github", targets: ["a/x", "a/y"], enabled: true }).run();
    const rel = (repo: string, tag: string) => ({ kind: "release" as const, repo, ref: `r:${repo}@${tag}`, title: `${repo} ${tag}`, payload: { tag }, occurredAt: now });
    ingestSignals(ctx, "o", 1, [rel("a/x", "v1.0.0")], {}, ev("a/x"));
    ingestSignals(ctx, "o", 1, [rel("a/y", "v1.0.0")], {}, ev("a/y"));
    ctx.db.update(schema.candidates).set({ status: "judged" }).where(eq(schema.candidates.repo, "a/x")).run();
    ctx.db.update(schema.candidates).set({ status: "drafted" }).where(eq(schema.candidates.repo, "a/y")).run();
    ingestSignals(ctx, "o", 1, [{ kind: "star_milestone", repo: "a/x", ref: "s:a/x#25", title: "a/x stars 25", payload: { threshold: 25 }, occurredAt: now }], {}, ev("a/x"));
    expect(ctx.db.select().from(schema.candidates).where(eq(schema.candidates.repo, "a/x")).get()?.status).toBe("judged");
    ingestSignals(ctx, "o", 1, [rel("a/x", "v1.1.0")], {}, ev("a/x"));
    ingestSignals(ctx, "o", 1, [rel("a/y", "v1.1.0")], {}, ev("a/y"));
    const x = ctx.db.select().from(schema.candidates).where(eq(schema.candidates.repo, "a/x")).get();
    expect(x?.title).toBe("a/x v1.1.0");
    expect(x?.status).toBe("new");
    expect(ctx.db.select().from(schema.candidates).where(eq(schema.candidates.repo, "a/y")).get()?.status).toBe("drafted");
  });

  it("opens a new window after 10 days", () => {
    const ctx = makeCtx();
    const now = Date.now();
    ctx.db.insert(schema.sources).values({ ownerId: "o", kind: "github", targets: ["a/x"], enabled: true }).run();
    ingestSignals(ctx, "o", 1, [{ kind: "release", repo: "a/x", ref: "r1", title: "a/x v1", payload: { tag: "v1" }, occurredAt: now }], {}, ev("a/x"));
    ctx.db.update(schema.candidates).set({ createdAt: now - 11 * DAY }).run();
    ingestSignals(ctx, "o", 1, [{ kind: "release", repo: "a/x", ref: "r2", title: "a/x v2", payload: { tag: "v2" }, occurredAt: now }], {}, ev("a/x"));
    expect(ctx.db.select().from(schema.candidates).all()).toHaveLength(2);
  });
});

describe("migrateLegacyCandidates", () => {
  it("merges same-repo legacy candidates within 10 days and keeps drafts", () => {
    const ctx = makeCtx();
    const now = Date.now();
    const ins = (type: string, key: string, createdAt: number, hl?: string[]) => Number(ctx.db.insert(schema.candidates).values({ ownerId: "o", type, title: key, repo: "a/x", key, evidence: { ...ev("a/x"), highlights: hl, highlightsAt: hl ? now : undefined } as Record<string, unknown>, status: "judged", createdAt, updatedAt: createdAt }).run().lastInsertRowid);
    const rel = ins("release", "release:a/x@v1", now - DAY, ["Adds RAG"]);
    const ms = ins("milestone", "milestone:a/x#stars-25", now, ["Adds RAG again"]);
    const old = ins("milestone", "milestone:a/x#stars-10", now - 20 * DAY);
    ctx.db.insert(schema.drafts).values({ ownerId: "o", candidateId: ms, channel: "x", lang: "ko", version: 1, body: "b", lint: [], status: "proposed", model: "m", createdAt: now, updatedAt: now }).run();
    const r = migrateLegacyCandidates(ctx);
    expect(r.merged).toBe(1);
    const rows = ctx.db.select().from(schema.candidates).all();
    expect(rows).toHaveLength(2);
    const keeper = rows.find((c) => c.id !== old)!;
    expect(keeper.id).toBe(ms); // 초안이 있는 쪽이 남는다
    expect(keeper.type).toBe("release"); // 가장 강한 종류로
    expect((keeper.evidence as Evidence).milestones?.[0]).toMatchObject({ metric: "stars", threshold: 25 });
    expect(ctx.db.select().from(schema.drafts).all()[0].candidateId).toBe(ms);
    expect(rows.every((c) => c.key.startsWith("repo:"))).toBe(true);
    expect(ctx.db.select().from(schema.candidates).where(undefined).all().find((c) => c.id === rel)).toBeUndefined();
    // 두 번째 실행은 아무것도 하지 않는다
    expect(migrateLegacyCandidates(ctx)).toEqual({ merged: 0, renamed: 0 });
  });
});

it("keeps PRs that shipped in the latest release out of a later in-progress candidate", () => {
  const ctx = makeCtx();
  const now = Date.now();
  ctx.db.insert(schema.sources).values({ ownerId: "o", kind: "github", targets: ["a/x"], enabled: true }).run();
  const releaseAt = now - DAY;
  // 릴리스 직전 PR들: 릴리스 신호가 다른 창에 있어 고아로 남는다.
  const pr = (n: number, at: number) => ({ kind: "pr_merged" as const, repo: "a/x", ref: `pr${n}`, title: `PR ${n}`, payload: {}, occurredAt: at });
  ingestSignals(ctx, "o", 1, [pr(1, releaseAt - 3600e3), pr(2, releaseAt - 7200e3)], { latestReleaseAt: releaseAt, recentPrCount: 2 }, ev("a/x"));
  ingestSignals(ctx, "o", 1, [{ kind: "commit_batch", repo: "a/x", ref: "c1", title: "a/x: 5 commits", payload: {}, occurredAt: now }, pr(3, now - 600e3)], { latestReleaseAt: releaseAt, recentPrCount: 1 }, ev("a/x"));
  const cand = ctx.db.select().from(schema.candidates).get();
  expect(cand?.type).toBe("in-progress");
  const attached = ctx.db.select().from(schema.signals).all().filter((s) => s.kind === "pr_merged" && s.candidateId === cand?.id).map((s) => s.ref);
  expect(attached).toEqual(["pr3"]);
});

it("titles a multi-release window by the most recently published release and keeps every release note", () => {
  const ctx = makeCtx();
  const now = Date.now();
  ctx.db.insert(schema.sources).values({ ownerId: "o", kind: "github", targets: ["a/mono"], enabled: true }).run();
  const rel = (tag: string, at: number, body: string) => ({ kind: "release" as const, repo: "a/mono", ref: `r:${tag}`, title: `a/mono ${tag}`, payload: { tag, body }, occurredAt: at });
  ingestSignals(ctx, "o", 1, [rel("pkg-a@1.2.0", now - 3600e3, "A notes")], {}, ev("a/mono"));
  ingestSignals(ctx, "o", 1, [rel("pkg-b@0.1.0", now - 7200e3, "B notes")], {}, ev("a/mono"));
  let cand = ctx.db.select().from(schema.candidates).get();
  expect(cand?.title).toBe("a/mono pkg-a@1.2.0");
  ingestSignals(ctx, "o", 1, [rel("pkg-c@0.0.1", now, "C notes")], {}, ev("a/mono"));
  cand = ctx.db.select().from(schema.candidates).get();
  expect(cand?.title).toBe("a/mono pkg-c@0.0.1");
  expect((cand?.evidence as Evidence).windowReleaseNotes?.map((n) => n.tag)).toEqual(["pkg-b@0.1.0", "pkg-a@1.2.0", "pkg-c@0.0.1"]);
});

it("keeps the newest release notes when a window has more than ten releases", () => {
  const ctx = makeCtx();
  const now = Date.now();
  ctx.db.insert(schema.sources).values({ ownerId: "o", kind: "github", targets: ["a/many"], enabled: true }).run();
  // 수집기처럼 최신 릴리스부터 보낸다.
  const releases = Array.from({ length: 11 }, (_, i) => ({ kind: "release" as const, repo: "a/many", ref: `r${i}`, title: `a/many v0.${i}.0`, payload: { tag: `v0.${i}.0`, body: `notes ${i}` }, occurredAt: now - (11 - i) * 3600e3 })).reverse();
  ingestSignals(ctx, "o", 1, releases, {}, ev("a/many"));
  const notes = (ctx.db.select().from(schema.candidates).get()?.evidence as Evidence).windowReleaseNotes?.map((n) => n.tag);
  expect(notes).toHaveLength(10);
  expect(notes?.at(-1)).toBe("v0.10.0");
  expect(notes).not.toContain("v0.0.0");
});

it("does not let a late backport of an older line take the title, but lets a final release replace its rc", () => {
  const ctx = makeCtx();
  const now = Date.now();
  ctx.db.insert(schema.sources).values({ ownerId: "o", kind: "github", targets: ["a/v"], enabled: true }).run();
  const rel = (tag: string, at: number) => ({ kind: "release" as const, repo: "a/v", ref: `r:${tag}`, title: `a/v ${tag}`, payload: { tag, body: tag }, occurredAt: at });
  ingestSignals(ctx, "o", 1, [rel("v8.3.3", now - 3 * 3600e3)], {}, ev("a/v"));
  ingestSignals(ctx, "o", 1, [rel("v6.4.4", now - 3600e3)], {}, ev("a/v"));
  expect(ctx.db.select().from(schema.candidates).get()?.title).toBe("a/v v8.3.3");
  ingestSignals(ctx, "o", 1, [rel("v9.0.0-rc.1", now - 1800e3)], {}, ev("a/v"));
  expect(ctx.db.select().from(schema.candidates).get()?.title).toBe("a/v v8.3.3");
  ingestSignals(ctx, "o", 1, [rel("v8.4.0", now)], {}, ev("a/v"));
  expect(ctx.db.select().from(schema.candidates).get()?.title).toBe("a/v v8.4.0");
});
