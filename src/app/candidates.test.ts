import { EventEmitter } from "node:events";
import pino from "pino";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDb, schema } from "../infra/db/index.js";
import type { AppContext } from "./context.js";
import { listInbox, refreshEvidence } from "./candidates.js";
import type { CandidateStatus } from "../shared/types.js";

let ctx: AppContext;
beforeEach(() => {
  ctx = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: {} as AppContext["usage"] };
});
afterEach(() => { vi.restoreAllMocks(); ctx.db.$client.close(); });
let sequence = 0;
function candidate(status: CandidateStatus, updatedAt: number, ownerId = "a") {
  return Number(ctx.db.insert(schema.candidates).values({ ownerId, repo: "a/repo", type: "release", title: "Candidate", key: String(++sequence), evidence: { repo: "a/repo", repoUrl: "https://example.test" }, status, createdAt: 1, updatedAt }).run().lastInsertRowid);
}
function draft(candidateId: number, version = 1, status = "proposed") {
  return Number(ctx.db.insert(schema.drafts).values({ ownerId: "a", candidateId, channel: "x", lang: "en", version, body: "Draft", status, lint: [], model: "test", createdAt: 1, updatedAt: 1 }).run().lastInsertRowid);
}
function publish(candidateId: number, draftId: number) {
  ctx.db.insert(schema.publications).values({ ownerId: "a", candidateId, draftId, channel: "x", lang: "en", url: "https://example.test/post", publishedAt: 1 }).run();
}

it("keeps old actionable candidates behind 200 newer completed items and caps only completed items", () => {
  const active = [candidate("new", 1), candidate("judged", 2), candidate("drafted", 3)];
  const judgmentId = Number(ctx.db.insert(schema.judgments).values({ ownerId: "a", candidateId: active[1], scores: { runnable: 1, numbers: 1, lesson: 1, novelty: 1, audience: 1 }, total: 5, reasoning: "Needs review", decision: "draft", suggestedChannels: ["x"], model: "test", createdAt: 1 }).run().lastInsertRowid);
  ctx.db.$client.prepare("UPDATE candidates SET latest_judgment_id = ? WHERE id = ?").run(judgmentId, active[1]);
  const republished = candidate("published", 4);
  publish(republished, draft(republished));
  draft(republished, 2);
  active.push(republished);
  const excluded = [candidate("dropped", 5), candidate("deferred", 6), candidate("published", 7)];
  draft(excluded[0]); draft(excluded[1]); // 명시적으로 보류·보관한 글감은 미게시 초안이 있어도 제한 대상.
  publish(excluded[2], draft(excluded[2]));
  const completed = Array.from({ length: 200 }, (_, i) => candidate((["published", "dropped", "deferred"] as const)[i % 3], 100 + i));
  const otherOwner = candidate("new", 1000, "b");
  const rows = listInbox(ctx, "a");
  expect(rows).toHaveLength(204);
  expect(rows.find((r) => r.id === active[1])?.judgment).toMatchObject({ id: judgmentId, reasoning: "Needs review" });
  expect(rows.map((r) => r.id)).toEqual([...completed].reverse().concat([...active].reverse()));
  expect(rows.some((r) => excluded.includes(r.id) || r.id === otherOwner)).toBe(false);
  expect(rows.find((r) => r.id === republished)?.unpublishedDraftCount).toBe(1);
});

it("uses the latest non-dropped version to distinguish completed and actionable published candidates", () => {
  const completed = candidate("published", 1);
  draft(completed); publish(completed, draft(completed, 2));
  const review = candidate("published", 2);
  publish(review, draft(review)); draft(review, 2); draft(review, 3, "dropped");
  for (let i = 0; i < 200; i++) candidate("published", i + 10);
  const rows = listInbox(ctx, "a");
  expect(rows.find((r) => r.id === completed)).toBeUndefined();
  expect(rows.find((r) => r.id === review)?.unpublishedDraftCount).toBe(1);
});

it("returns over 200 actionable candidates with a constant number of database queries", () => {
  const initial = candidate("drafted", 1); draft(initial);
  const prepare = vi.spyOn(ctx.db.$client, "prepare");
  listInbox(ctx, "a");
  const smallCount = prepare.mock.calls.length;
  prepare.mockClear();
  for (let i = 0; i < 220; i++) draft(candidate("drafted", i + 2));
  prepare.mockClear();
  expect(listInbox(ctx, "a")).toHaveLength(221);
  expect(prepare.mock.calls.length).toBe(smallCount);
  expect(smallCount).toBe(4);
});

it("returns an empty array for an owner without candidates", () => {
  candidate("new", 1, "b");
  expect(listInbox(ctx, "a")).toEqual([]);
});

it("refreshes the current window's version but keeps a past window's own release", () => {
  const now = Date.now();
  const insert = (key: string, createdAt: number, version: string) => Number(ctx.db.insert(schema.candidates).values({ ownerId: "a", repo: "a/repo", type: "release", title: `a/repo ${version}`, key, evidence: { repo: "a/repo", repoUrl: "u", version, releaseNotes: `${version} notes` }, status: "judged", createdAt, updatedAt: createdAt }).run().lastInsertRowid);
  const old = insert("old", now - 20 * 86400e3, "v1.0");
  const cur = insert("cur", now - 86400e3, "v1.0");
  refreshEvidence(ctx, "a", "a/repo", { repo: "a/repo", repoUrl: "u", version: "v1.1", releaseNotes: "v1.1 notes", stars: 9 });
  const ev = (id: number) => ctx.db.select().from(schema.candidates).all().find((c) => c.id === id)?.evidence as { version?: string; releaseNotes?: string; stars?: number };
  expect(ev(old)).toMatchObject({ version: "v1.0", releaseNotes: "v1.0 notes", stars: 9 });
  expect(ev(cur)).toMatchObject({ version: "v1.1", releaseNotes: "v1.1 notes" });
});
