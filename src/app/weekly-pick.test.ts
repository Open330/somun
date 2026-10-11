import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDb, schema } from "../infra/db/index.js";
import type { AppContext } from "./context.js";
import { awaitingPublication } from "./candidates.js";
import { getSettings, updateSettings } from "./settings.js";
import { pickWeek, pickWeekly, pickWeeklyAll, rankForPick, weeklyPickView } from "./weekly-pick.js";

const DAY = 86_400_000;
// 2026-10-12(월) 08:00 KST
const MONDAY = Date.UTC(2026, 9, 11, 23, 0);
let ctx: AppContext;

beforeEach(() => {
  ctx = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: { geminiKeys: JSON.stringify({ "free-1": "k" }) }, bus: new EventEmitter(), usage: { record: vi.fn() } as unknown as AppContext["usage"] };
  updateSettings(ctx, "me", { channelLangs: { x: ["en", "ko"], linkedin: ["ko"] }, ui: { locale: "ko" } });
});
afterEach(() => ctx.db.$client.close());

type Row = typeof schema.candidates.$inferInsert;
const add = (over: Partial<Row> & { title: string }, highlights?: string[]) =>
  Number(ctx.db.insert(schema.candidates).values({
    ownerId: "me", repo: "me/tool", type: "release", key: over.title, status: "new", createdAt: MONDAY - DAY, updatedAt: MONDAY - DAY,
    evidence: { repo: "me/tool", repoUrl: "https://github.com/me/tool", ...(highlights ? { highlights, highlightsAt: MONDAY - DAY } : {}) },
    ...over,
  }).run().lastInsertRowid);
const judge = (candidateId: number, total: number, suggestedChannels: string[] = []) => {
  const jid = Number(ctx.db.insert(schema.judgments).values({ ownerId: "me", candidateId, scores: { runnable: 1, numbers: 1, lesson: 1, novelty: 1, audience: 1 }, total, reasoning: `score ${total}`, decision: total >= 6 ? "draft" : total >= 4 ? "defer" : "ask", suggestedChannels, model: "t", createdAt: MONDAY - DAY }).run().lastInsertRowid);
  ctx.db.update(schema.candidates).set({ latestJudgmentId: jid, status: "judged" }).where(eq(schema.candidates.id, candidateId)).run();
  return jid;
};
const jobs = () => ctx.db.select().from(schema.llmJobs).all().map((j) => ({ kind: j.kind, candidateId: j.candidateId, channel: j.channel, lang: j.lang, continuation: j.continuation }));

it("uses Monday in Korea as the week", () => {
  expect(pickWeek(MONDAY)).toBe("2026-10-12");
  expect(pickWeek(MONDAY - 8 * 3600_000)).toBe("2026-10-12");
  expect(pickWeek(MONDAY - 9 * 3600_000 - 1)).toBe("2026-10-05");
});

it("ranks judged candidates by score, unjudged ones by type, and skips copied, posted, empty and stale ones", () => {
  const weak = add({ title: "release v1" });
  judge(weak, 2);
  const strong = add({ title: "release v2" });
  const milestone = add({ title: "100 stars", type: "milestone" });
  const empty = add({ title: "nothing new" }, []);
  const old = add({ title: "ancient", updatedAt: MONDAY - 40 * DAY });
  const copied = add({ title: "copied" });
  ctx.db.insert(schema.drafts).values({ ownerId: "me", candidateId: copied, channel: "x", lang: "ko", version: 1, body: "b", lint: [], status: "copied", model: "t", createdAt: 1, updatedAt: 1 }).run();
  const posted = add({ title: "posted" });
  ctx.db.insert(schema.publications).values({ ownerId: "me", candidateId: posted, channel: "x", url: "https://x.com/a/status/1", publishedAt: 1 }).run();
  expect(rankForPick(ctx, "me", MONDAY).map((r) => r.id)).toEqual([strong, milestone, weak]);
  void [empty, old, copied, posted];
});

it("keeps only the newest weekly in-progress candidate of a repo", () => {
  const older = add({ title: "me/tool (W40)", type: "in-progress", updatedAt: MONDAY - 8 * DAY });
  const newer = add({ title: "me/tool (W41)", type: "in-progress" });
  const ranked = rankForPick(ctx, "me", MONDAY).map((r) => r.id);
  expect(ranked).toContain(newer);
  expect(ranked).not.toContain(older);
});

it("picks once a week, prepares one draft for the primary target, and moves on when asked again", () => {
  const digested = add({ title: "release v2" }, ["Adds a flag."]);
  judge(digested, 7, ["linkedin"]);
  const raw = add({ title: "new repo", type: "new-repo" });
  const first = pickWeekly(ctx, "me", { now: MONDAY });
  expect(first).toMatchObject({ candidateId: digested, week: "2026-10-12", total: 7, preparing: true });
  // 요약이 있으면 판단 없이 기본 대상 하나의 초안만: 판단이 고른 채널, 화면 언어.
  expect(jobs()).toEqual([{ kind: "draft", candidateId: digested, channel: "linkedin", lang: "ko", continuation: null }]);
  // 같은 주에 다시 불러도 바뀌지 않는다.
  expect(pickWeekly(ctx, "me", { now: MONDAY + DAY })?.candidateId).toBe(digested);
  expect(jobs()).toHaveLength(1);
  // 다시 고르면 다음 후보. 요약이 없으면 요약 뒤에 그 대상의 초안을 잇는다.
  const second = pickWeekly(ctx, "me", { now: MONDAY + DAY, again: true });
  expect(second?.candidateId).toBe(raw);
  expect(jobs()[1]).toEqual({ kind: "digest", candidateId: raw, channel: null, lang: null, continuation: { targets: [{ channel: "x", lang: "ko" }] } });
  expect(getSettings(ctx, "me").weeklyPick?.history).toEqual([digested]);
  // 고를 것이 더 없으면 지금 것을 유지한다.
  expect(pickWeekly(ctx, "me", { now: MONDAY + DAY, again: true })?.candidateId).toBe(raw);
});

it("does not re-pick last week's pick and does not prepare a draft that already exists", () => {
  const a = add({ title: "release a" }, ["A."]);
  const b = add({ title: "release b" }, ["B."]);
  ctx.db.insert(schema.drafts).values({ ownerId: "me", candidateId: b, channel: "x", lang: "ko", version: 1, body: "b", lint: [], status: "proposed", model: "t", createdAt: 1, updatedAt: 1 }).run();
  expect(pickWeekly(ctx, "me", { now: MONDAY - 7 * DAY + DAY })?.candidateId).toBe(b);
  expect(jobs()).toHaveLength(0);
  const next = pickWeekly(ctx, "me", { now: MONDAY });
  expect(next?.candidateId).toBe(a);
  expect(next?.week).toBe("2026-10-12");
});

it("scheduled picks leave the user's share of the shared quota alone", () => {
  add({ title: "release" }, ["A."]);
  // 50회 중 29회 사용: 자동 작업 몫(30회)에 두 번(요약·초안)을 더 쓸 자리가 없다.
  ctx.db.insert(schema.appState).values({ key: `shared_quota:${createHash("sha256").update("me").digest("hex")}`, value: JSON.stringify({ day: new Date(MONDAY).toISOString().slice(0, 10), count: 29 }), updatedAt: MONDAY }).run();
  expect(pickWeeklyAll(ctx, MONDAY)).toBe(1);
  expect(weeklyPickView(ctx, "me")?.title).toBe("release");
  expect(jobs()).toHaveLength(0);
  // 사용자가 직접 고르면 사용자 몫으로 준비한다.
  ctx.db.update(schema.appState).set({ value: JSON.stringify({ day: "2000-01-01", count: 0 }) }).run();
  ctx.db.update(schema.settings).set({ data: { ...getSettings(ctx, "me"), weeklyPick: undefined } }).run();
  pickWeekly(ctx, "me", { now: MONDAY });
  expect(jobs()).toHaveLength(1);
});

it("lists copied drafts without a publication on that channel", () => {
  const c = add({ title: "release" });
  const d = Number(ctx.db.insert(schema.drafts).values({ ownerId: "me", candidateId: c, channel: "x", lang: "ko", version: 1, body: "b", lint: [], status: "copied", model: "t", copiedAt: 5, createdAt: 1, updatedAt: 5 }).run().lastInsertRowid);
  expect(awaitingPublication(ctx, "me")).toEqual([{ candidateId: c, draftId: d, channel: "x", lang: "ko", copiedAt: 5 }]);
  ctx.db.insert(schema.publications).values({ ownerId: "me", candidateId: c, channel: "x", url: "https://x.com/a/status/1", publishedAt: 6 }).run();
  expect(awaitingPublication(ctx, "me")).toEqual([]);
});
