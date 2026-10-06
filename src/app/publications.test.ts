import { EventEmitter } from "node:events";
import pino from "pino";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDb, schema } from "../infra/db/index.js";
import type { AppContext } from "./context.js";
import { registerPublication, removePublication, snapshotMetrics, updatePublicationUrl } from "./publications.js";
import { learningStats } from "./learning-stats.js";
import { saveDraftEdit } from "./review.js";

let ctx: AppContext, candidateId: number;
const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify({ tweet: { likes: 7, retweets: 1, replies: 2 } }), { status: 200 }));
beforeEach(() => {
  ctx = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: { record: vi.fn() } as unknown as AppContext["usage"] };
  vi.stubGlobal("fetch", fetchMock);
  const now = Date.now();
  candidateId = Number(ctx.db.insert(schema.candidates).values({ ownerId: "me", type: "release", title: "t", repo: "me/tool", key: "k", evidence: { repo: "me/tool", repoUrl: "https://github.com/me/tool" }, status: "drafted", createdAt: now, updatedAt: now }).run().lastInsertRowid);
  ctx.db.insert(schema.changeLedger).values({ ownerId: "me", repo: "me/tool", text: "Adds --watch.", normalized: "adds watch", candidateId, firstSeenAt: now }).run();
});
afterEach(() => { ctx.db.$client.close(); vi.unstubAllGlobals(); fetchMock.mockClear(); });
const ledger = () => ctx.db.select().from(schema.changeLedger).get()!;

it("undoes the ledger's 'already announced' mark when the only publication is removed", () => {
  ctx.db.insert(schema.drafts).values({ ownerId: "me", candidateId, channel: "x", lang: "en", version: 1, body: "b", lint: [], status: "copied", model: "m", createdAt: 1, updatedAt: 1 }).run();
  const id = registerPublication(ctx, "me", { candidateId, channel: "x", url: "https://x.com/me/status/1" });
  expect(ledger().publishedChannel).toBe("x");
  removePublication(ctx, "me", id);
  expect(ledger()).toMatchObject({ publishedAt: null, publishedChannel: null });
  expect(ctx.db.select().from(schema.candidates).get()?.status).toBe("drafted");
});

it("keeps the ledger pointing at a remaining publication", () => {
  registerPublication(ctx, "me", { candidateId, channel: "show_hn", url: "https://news.ycombinator.com/item?id=1" });
  const second = registerPublication(ctx, "me", { candidateId, channel: "x", url: "https://x.com/me/status/1" });
  removePublication(ctx, "me", second);
  expect(ledger().publishedChannel).toBe("show_hn");
  expect(ctx.db.select().from(schema.candidates).get()?.status).toBe("published");
});

it("refetches reactions for the corrected URL even on an old publication", async () => {
  const id = Number(ctx.db.insert(schema.publications).values({ ownerId: "me", candidateId, channel: "x", url: "https://x.com/me/status/1", publishedAt: Date.now() - 90 * 86_400_000, autoStats: { likes: 1, source: "fxtwitter" } }).run().lastInsertRowid);
  updatePublicationUrl(ctx, "me", id, "https://x.com/me/status/2");
  await vi.waitFor(() => expect(ctx.db.select().from(schema.publications).get()?.autoStats).toMatchObject({ likes: 7 }));
  expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("/status/2");
});

it("returns a candidate without drafts to its judged or new stage when its only publication is removed", () => {
  const id = registerPublication(ctx, "me", { candidateId, channel: "x", url: "https://x.com/me/status/1" });
  removePublication(ctx, "me", id);
  expect(ctx.db.select().from(schema.candidates).get()?.status).toBe("new");
});

function purposeDraft(purpose: "introduction" | "update", version = 1) {
  return Number(ctx.db.insert(schema.drafts).values({ ownerId: "me", candidateId, channel: "x", lang: "en", version, purpose, body: purpose === "introduction" ? "A tool for developers." : "Adds --watch.", lint: [], status: "proposed", model: "m", createdAt: 1, updatedAt: 1 }).run().lastInsertRowid);
}

it("rejects another channel's URL before writing a publication or changing the candidate", () => {
  const draftId = purposeDraft("introduction");
  expect(() => registerPublication(ctx, "me", { candidateId, draftId, channel: "x", url: "https://www.linkedin.com/posts/example" })).toThrow(/LinkedIn/);
  expect(ctx.db.select().from(schema.publications).all()).toHaveLength(0);
  expect(ctx.db.select().from(schema.candidates).get()?.status).toBe("drafted");
  const id = registerPublication(ctx, "me", { candidateId, draftId, channel: "x", url: "https://x.com/me/status/1" });
  expect(() => updatePublicationUrl(ctx, "me", id, "https://threads.net/@me/post/1")).toThrow(/Threads/);
  expect(ctx.db.select().from(schema.publications).get()?.url).toBe("https://x.com/me/status/1");
});

it("does not infer a copy from a publication, even if a legacy row was marked copied", () => {
  const draftId = purposeDraft("introduction");
  registerPublication(ctx, "me", { candidateId, draftId, channel: "x", url: "https://x.com/me/status/1" });
  expect(ctx.db.select().from(schema.drafts).get()).toMatchObject({ status: "proposed", copiedAt: null });
  ctx.db.update(schema.drafts).set({ status: "copied", editRatio: 0 }).run();
  expect(learningStats(ctx, "me").copied).toBe(0);
  saveDraftEdit(ctx, "me", draftId, { body: "A tool for developers.", markCopied: true });
  expect(learningStats(ctx, "me")).toMatchObject({ copied: 1, unchangedRate: 1 });
  expect(ctx.db.select().from(schema.drafts).get()?.copiedAt).toBeGreaterThan(0);
  saveDraftEdit(ctx, "me", draftId, { body: "An unsaved-for-copy revision.", markCopied: false });
  expect(learningStats(ctx, "me")).toMatchObject({ copied: 1, unchangedRate: 1 });
});

it("does not announce changes when an introduction is posted", () => {
  registerPublication(ctx, "me", { candidateId, draftId: purposeDraft("introduction"), channel: "x", url: "https://x.com/me/status/1" });
  expect(ledger().publishedAt).toBeNull();
  expect(ctx.db.select().from(schema.candidates).get()?.status).toBe("published");
});

it("clears change marks if only an introduction remains after deleting an update", () => {
  const introduction = registerPublication(ctx, "me", { candidateId, draftId: purposeDraft("introduction"), channel: "x", url: "https://x.com/me/status/1" });
  const update = registerPublication(ctx, "me", { candidateId, draftId: purposeDraft("update", 2), channel: "linkedin", url: "https://example.test/post" });
  expect(ledger().publishedChannel).toBe("linkedin");
  removePublication(ctx, "me", update);
  expect(ledger().publishedAt).toBeNull();
  expect(ctx.db.select().from(schema.candidates).get()?.status).toBe("published");
  removePublication(ctx, "me", introduction);
  expect(ctx.db.select().from(schema.candidates).get()?.status).toBe("drafted");
});

it("keeps the update's change marks when an introduction is posted and removed", () => {
  registerPublication(ctx, "me", { candidateId, draftId: purposeDraft("update"), channel: "linkedin", url: "https://example.test/post" });
  const introduction = registerPublication(ctx, "me", { candidateId, draftId: purposeDraft("introduction", 2), channel: "x", url: "https://x.com/me/status/1" });
  expect(ledger().publishedChannel).toBe("linkedin");
  removePublication(ctx, "me", introduction);
  expect(ledger().publishedChannel).toBe("linkedin");
});

it("does not mark introductions as changes when rebuilding an empty ledger", async () => {
  const { backfillLedger } = await import("./ledger.js");
  ctx.db.delete(schema.changeLedger).run();
  ctx.db.update(schema.candidates).set({ evidence: { repo: "me/tool", repoUrl: "https://github.com/me/tool", highlights: ["Adds --watch."] } }).run();
  registerPublication(ctx, "me", { candidateId, draftId: purposeDraft("introduction"), channel: "x", url: "https://x.com/me/status/1" });
  expect(backfillLedger(ctx)).toBe(1);
  expect(ledger().publishedAt).toBeNull();
});

it("counts only latest live drafts without an exact publication, across channels and languages", async () => {
  const { listInbox, getCandidateDetail } = await import("./candidates.js");
  const count = () => listInbox(ctx, "me").find((c) => c.id === candidateId)!.unpublishedDraftCount;
  const first = purposeDraft("introduction");
  registerPublication(ctx, "me", { candidateId, draftId: first, channel: "x", lang: "en", url: "https://example.test/first" });
  expect(count()).toBe(0);
  const second = purposeDraft("introduction", 2);
  expect(count()).toBe(1);
  const korean = Number(ctx.db.insert(schema.drafts).values({ ownerId: "me", candidateId, channel: "x", lang: "ko", version: 1, body: "Korean", lint: [], status: "copied", model: "m", createdAt: 1, updatedAt: 1 }).run().lastInsertRowid);
  expect(count()).toBe(2); // Copying is not publishing.
  const secondPost = registerPublication(ctx, "me", { candidateId, draftId: second, channel: "x", lang: "en", url: "https://example.test/second" });
  expect(count()).toBe(1);
  registerPublication(ctx, "me", { candidateId, draftId: korean, channel: "x", lang: "ko", url: "https://example.test/korean" });
  expect(count()).toBe(0);
  const dropped = purposeDraft("update", 3);
  ctx.db.$client.prepare("UPDATE drafts SET status = 'dropped' WHERE id = ?").run(dropped);
  expect(count()).toBe(0);
  removePublication(ctx, "me", secondPost);
  expect(count()).toBe(1);
  expect(getCandidateDetail(ctx, "me", candidateId).unpublishedDraftCount).toBe(1);
  expect(listInbox(ctx, "other")).toEqual([]);
  expect(ctx.db.select().from(schema.candidates).get()?.status).toBe("published");
});

it("keeps the pre-post snapshot when stars arrive after a post instead of overwriting it", () => {
  const t0 = Date.now() - 3 * 3600e3;
  const snap = (stars: number, at: number) => snapshotMetrics(ctx, "me", { repo: "me/tool", stars, forks: 0 }, at);
  snap(100, t0);
  snap(101, t0 + 3600e3); // 같은 날 다시 수집: 덮어쓴다
  expect(ctx.db.select().from(schema.metricSnapshots).all().map((r) => r.stars)).toEqual([101]);
  registerPublication(ctx, "me", { candidateId, channel: "x", url: "https://x.com/me/status/1" });
  snap(130, Date.now() + 1000); // 발행 뒤 star webhook으로 다시 수집
  snap(140, Date.now() + 2000);
  const rows = ctx.db.select().from(schema.metricSnapshots).all().sort((a, b) => a.at - b.at);
  expect(rows.map((r) => r.stars)).toEqual([101, 140]);
  expect(rows[0].at).toBe(t0);
});
