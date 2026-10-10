import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, schema } from "../infra/db/index.js";
import type { AppContext } from "./context.js";
import { applyResult, buildPrompt, processNewCandidates, queueStep, requestedIntroduction, rubricTotal, SWEEP_BACKOFF_MS, SWEEP_MAX_FAILURES, windowFacts } from "./pipeline.js";
import { retryGeneration } from "./jobs.js";
import { setCandidateStatus } from "./candidates.js";
import { GenerationConflictError } from "./context.js";
import { saveDraftEdit } from "./review.js";
import { updateSettings } from "./settings.js";
import { registerPublication } from "./publications.js";
import { reserveSharedExecution } from "./shared-quota.js";

let ctx: AppContext;
let id: number;
beforeEach(() => {
  ctx = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: { record: vi.fn() } as unknown as AppContext["usage"] };
  id = Number(ctx.db.insert(schema.candidates).values({ ownerId: "test", repo: "vitejs/vite", title: "Dependency maintenance", type: "release", key: "test", evidence: { repo: "vitejs/vite", repoUrl: "https://github.com/vitejs/vite", highlights: [], highlightsAt: 1 }, status: "judged", createdAt: 1, updatedAt: 1 }).run().lastInsertRowid);
});
afterEach(() => { ctx.db.$client.close(); vi.resetAllMocks(); });

it.each(["gemini", "local-agent"] as const)("does not enqueue %s drafts when digest found no evidence", (provider) => {
  updateSettings(ctx, "test", { llm: { provider } });
  expect(() => queueStep(ctx, "test", "draft", id, "x", "en")).toThrow(GenerationConflictError);
  expect(ctx.db.select().from(schema.llmJobs).all()).toHaveLength(0);
});

it("builds a draft prompt from concrete evidence", () => {
  ctx.db.update(schema.candidates).set({ evidence: { repo: "vitejs/vite", repoUrl: "https://github.com/vitejs/vite", highlights: ["Handles CRLF code frame positions."], highlightsAt: 1 } }).run();
  const request = buildPrompt(ctx, "test", "draft", id, "x", "en");
  expect(request.user).toContain("Handles CRLF code frame positions.");
  expect(request.user).not.toContain("first person, past tense");
  expect(request.system).toContain("Factual grounding takes priority");
});

it("keeps digest highlights whose numbers are not in the raw material out of judge and draft", () => {
  ctx.db.update(schema.candidates).set({ status: "new", evidence: { repo: "vitejs/vite", repoUrl: "https://github.com/vitejs/vite", releaseNotes: "Adds --watch. Cold start is now 120 ms." } }).run();
  applyResult(ctx, "test", { kind: "digest", candidateId: id, model: "test", result: { highlights: ["Adds a --watch flag.", "Cold start is 3x faster.", "Cold start is 120 ms."], limitations: [] } });
  const ev = ctx.db.select().from(schema.candidates).get()!.evidence as { highlights: string[]; unverifiedHighlights: { text: string; numbers: string[] }[] };
  expect(ev.highlights).toEqual(["Adds a --watch flag.", "Cold start is 120 ms."]);
  expect(ev.unverifiedHighlights).toEqual([{ text: "Cold start is 3x faster.", numbers: ["3x"] }]);
  const judge = ctx.db.select().from(schema.llmJobs).get()!;
  expect(judge.kind).toBe("judge");
  expect(judge.user).not.toContain("3x");
});

it("does not queue automatic drafts from an empty digest even when the model gives high scores", () => {
  updateSettings(ctx, "test", { llm: { provider: "local-agent" } });
  const result = applyResult(ctx, "test", { kind: "judge", candidateId: id, model: "test", result: { scores: { runnable: 2, numbers: 2, lesson: 2, novelty: 2, audience: 2 }, reasoning: "Publish it", suggestedChannels: ["x"] } });
  expect(result.decision).toBe("ask");
  expect(ctx.db.select().from(schema.llmJobs).all()).toHaveLength(0);
  expect(ctx.db.select().from(schema.judgments).all()[0].reasoning).toContain("변경 근거");
});

it("keeps existing drafts in the review queue after a new judgment", () => {
  ctx.db.update(schema.candidates).set({ status: "drafted" }).run();
  applyResult(ctx, "test", { kind: "judge", candidateId: id, model: "test", result: { scores: {}, reasoning: "Needs evidence" } });
  expect(ctx.db.select().from(schema.candidates).get()?.status).toBe("drafted");
  expect(ctx.db.select().from(schema.judgments).get()?.decision).toBe("ask");
});

it.each(["x", "threads", "linkedin", "show_hn", "show_gn", "blog"] as const)("retains evidence warnings when a %s draft is saved", (channel) => {
  const result = applyResult(ctx, "test", { kind: "draft", candidateId: id, channel, lang: "en", model: "fixture", result: { title: "Tool update", body: "Runs 99% faster; API may change. https://github.com/vitejs/vite" } });
  const generated = ctx.db.select().from(schema.drafts).get()!;
  expect(generated.lint.find((r) => r.rule === "numbers_need_review")?.ok).toBe(false);
  expect(generated.lint.find((r) => r.rule === "no_invented_limit")?.ok).toBe(false);
  const saved = saveDraftEdit(ctx, "test", result.draftId!, { title: generated.title ?? undefined, body: generated.body, markCopied: false });
  expect(saved.lint).toEqual(generated.lint);
});

describe("hourly sweep", () => {
  const job = (kind: string, status: string, finishedAt?: number) => ctx.db.insert(schema.llmJobs).values({ ownerId: "test", kind, candidateId: id, system: "s", user: "u", schemaJson: "{}", status, executor: "server", createdAt: 1, finishedAt: finishedAt ?? null }).run();
  beforeEach(() => {
    updateSettings(ctx, "test", { watch: { mode: "auto", recentDays: 30 } });
    ctx.db.update(schema.candidates).set({ status: "new", createdAt: Date.now(), updatedAt: Date.now(), evidence: { repo: "vitejs/vite", repoUrl: "https://github.com/vitejs/vite" } }).run();
  });
  const queued = () => ctx.db.select().from(schema.llmJobs).all().filter((j) => j.status === "pending").map((j) => j.kind);

  it("does not spend model calls when all draft targets are disabled", async () => {
    updateSettings(ctx, "test", { channelLangs: { x: [], linkedin: [], show_hn: [], show_gn: [] } });
    expect(await processNewCandidates(ctx)).toBe(0);
    expect(queued()).toEqual([]);
  });

  it("continues with judge instead of digesting again once a digest exists", async () => {
    const at = Date.now();
    ctx.db.update(schema.candidates).set({ updatedAt: at, evidence: { repo: "vitejs/vite", repoUrl: "https://github.com/vitejs/vite", highlights: ["Adds a flag."], highlightsAt: at } }).run();
    expect(await processNewCandidates(ctx)).toBe(1);
    expect(queued()).toEqual(["judge"]);
  });

  it("digests again when new signals were merged after the last digest", async () => {
    const at = Date.now();
    ctx.db.update(schema.candidates).set({ updatedAt: at, evidence: { repo: "vitejs/vite", repoUrl: "https://github.com/vitejs/vite", highlights: ["Adds a flag."], highlightsAt: at - 60_000 } }).run();
    expect(await processNewCandidates(ctx)).toBe(1);
    expect(queued()).toEqual(["digest"]);
  });

  it("backs off after a recent failure and stops after repeated failures", async () => {
    job("digest", "failed", Date.now() - 60_000);
    expect(await processNewCandidates(ctx)).toBe(0);
    ctx.db.delete(schema.llmJobs).run();
    for (let i = 0; i < SWEEP_MAX_FAILURES; i++) job("digest", "failed", Date.now() - SWEEP_BACKOFF_MS - 60_000);
    expect(await processNewCandidates(ctx)).toBe(0);
    ctx.db.delete(schema.llmJobs).run();
    job("digest", "failed", Date.now() - SWEEP_BACKOFF_MS - 60_000);
    expect(await processNewCandidates(ctx)).toBe(1);
  });

  it("does not queue twice while a job is in flight", async () => {
    job("digest", "pending");
    expect(await processNewCandidates(ctx)).toBe(0);
  });

  it.each(["daily", "pending"])("continues with other owners when one owner's %s capacity is exhausted", async (limit) => {
    ctx.env.geminiKeys = JSON.stringify({ "free-1": "fixture" });
    ctx.env.sharedModelDailyLimit = 1;
    ctx.env.sharedModelPendingLimit = 1;
    if (limit === "daily") reserveSharedExecution(ctx, "test");
    else job("lesson", "pending");
    updateSettings(ctx, "other", { watch: { mode: "auto", recentDays: 30 } });
    const source = ctx.db.select().from(schema.candidates).get()!;
    ctx.db.insert(schema.candidates).values({ ...source, id: undefined, ownerId: "other", key: "other" }).run();
    expect(await processNewCandidates(ctx)).toBe(1);
    const digests = ctx.db.select().from(schema.llmJobs).all().filter((j) => j.kind === "digest");
    expect(digests.map((j) => j.ownerId)).toEqual(["other"]);
    expect(await processNewCandidates(ctx, "test")).toBe(0);
  });
});

it("filters unverified highlights before keeping eight, and checks against the text the digest actually saw", () => {
  ctx.db.update(schema.candidates).set({ status: "new", evidence: { repo: "vitejs/vite", repoUrl: "https://github.com/vitejs/vite", releaseNotes: "New notes after a later collect." } }).run();
  const bad = Array.from({ length: 3 }, (_, i) => `Claim ${i} is 3x faster.`);
  const good = [..."abcdefg"].map((c) => `Change ${c} without numbers.`);
  applyResult(ctx, "test", { kind: "digest", candidateId: id, model: "t", promptText: "## Release notes\nCold start went from 800ms to 200ms.", result: { highlights: [...bad, ...good, "Cold start went from 800 ms to 200 ms."], limitations: [] } });
  const ev = ctx.db.select().from(schema.candidates).get()!.evidence as { highlights: string[]; unverifiedHighlights: unknown[] };
  expect(ev.highlights).toHaveLength(8);
  expect(ev.highlights).toContain("Cold start went from 800 ms to 200 ms.");
  expect(ev.unverifiedHighlights).toHaveLength(3);
});

it("stores the judge's angle separately from its reasoning", () => {
  ctx.db.update(schema.candidates).set({ evidence: { repo: "vitejs/vite", repoUrl: "https://github.com/vitejs/vite", highlights: ["Adds a flag."], highlightsAt: 1 } }).run();
  applyResult(ctx, "test", { kind: "judge", candidateId: id, model: "t", result: { scores: {}, reasoning: "Plain verdict.", angle: "The flag nobody asked for" } });
  expect(ctx.db.select().from(schema.judgments).get()).toMatchObject({ reasoning: "Plain verdict.", angle: "The flag nobody asked for" });
  expect(buildPrompt(ctx, "test", "draft", id, "x", "en").user).toContain("The flag nobody asked for");
});

it("joins a pending judge instead of failing when only the account language changed", () => {
  ctx.db.update(schema.candidates).set({ evidence: { repo: "vitejs/vite", repoUrl: "https://github.com/vitejs/vite", highlights: ["Adds a flag."], highlightsAt: 1 } }).run();
  const first = queueStep(ctx, "test", "judge", id);
  updateSettings(ctx, "test", { ui: { locale: "en" } });
  expect(queueStep(ctx, "test", "judge", id)).toBe(first);
});

it("keeps a first introduction until the repository is published on that channel", () => {
  expect(buildPrompt(ctx, "test", "draft", id, "linkedin", "ko").user).toContain("## First introduction");
  ctx.db.insert(schema.publications).values({ ownerId: "test", candidateId: id, channel: "x", url: "https://x.com/a/status/1", publishedAt: 1 }).run();
  expect(buildPrompt(ctx, "test", "draft", id, "linkedin", "ko").user).toContain("## First introduction");
  expect(buildPrompt(ctx, "test", "draft", id, "x", "ko").draftPurpose).toBe("update");
});

it("keeps copies separate from confirmed publications", () => {
  ctx.db.update(schema.candidates).set({ evidence: { repo: "vitejs/vite", repoUrl: "https://github.com/vitejs/vite", highlights: ["Adds a flag."], highlightsAt: 1 } }).run();
  expect(buildPrompt(ctx, "test", "judge", id).user).toContain("## Introducing the project to new readers");
  applyResult(ctx, "test", { kind: "draft", candidateId: id, channel: "x", lang: "en", model: "t", result: { body: "Draft body" } });
  expect(buildPrompt(ctx, "test", "draft", id, "linkedin", "ko").user).toContain("## First introduction");
  ctx.db.update(schema.drafts).set({ copiedAt: 2 }).run();
  expect(buildPrompt(ctx, "test", "judge", id).user).toContain("## Introducing the project to new readers");
  expect(buildPrompt(ctx, "test", "draft", id, "linkedin", "ko").user).toContain("## First introduction");
  registerPublication(ctx, "test", { candidateId: id, channel: "x" });
  expect(buildPrompt(ctx, "test", "draft", id, "x", "ko").draftPurpose).toBe("update");
  expect(buildPrompt(ctx, "test", "draft", id, "linkedin", "ko").draftPurpose).toBe("introduction");
});

it("uses confirmed posting even when the corrected posting time predates the linked introduction", () => {
  ctx.db.update(schema.candidates).set({ evidence: { repo: "vitejs/vite", repoUrl: "https://github.com/vitejs/vite", highlights: ["Adds a flag."], highlightsAt: 1 } }).run();
  applyResult(ctx, "test", { kind: "judge", candidateId: id, model: "t", result: { scores: {}, angle: "Introduce vite for the first time", reasoning: "Intro" } });
  applyResult(ctx, "test", { kind: "draft", candidateId: id, channel: "x", lang: "ko", draftPurpose: "introduction", model: "t", result: { body: "Intro" } });
  const draftId = ctx.db.select().from(schema.drafts).get()!.id;
  registerPublication(ctx, "test", { candidateId: id, draftId, channel: "x", publishedAt: Date.now() - 86400e3 });
  const prompt = buildPrompt(ctx, "test", "draft", id, "x", "ko");
  expect(prompt.draftPurpose).toBe("update");
  expect(prompt.user).not.toContain("Introduce vite for the first time");
  expect(buildPrompt(ctx, "test", "draft", id, "linkedin", "ko").draftPurpose).toBe("introduction");
});

it("does not use the new-channel introduction angle for an already announced channel's update", () => {
  updateSettings(ctx, "test", { channelLangs: { x: ["ko"], linkedin: ["ko"] } });
  ctx.db.update(schema.candidates).set({ evidence: { repo: "vitejs/vite", repoUrl: "https://github.com/vitejs/vite", highlights: ["Adds a flag."], highlightsAt: 1 } }).run();
  registerPublication(ctx, "test", { candidateId: id, channel: "x", publishedAt: Date.now() - 86400e3 });
  applyResult(ctx, "test", { kind: "judge", candidateId: id, model: "t", result: { scores: {}, reasoning: "Introduce", angle: "Introduce vite to a new audience" } });
  const update = buildPrompt(ctx, "test", "draft", id, "x", "ko");
  expect(update.draftPurpose).toBe("update");
  expect(update.user).not.toContain("Introduce vite to a new audience");
  expect(buildPrompt(ctx, "test", "draft", id, "linkedin", "ko").draftPurpose).toBe("introduction");
});

it("redrafts the same channel as an update once publication is confirmed, and retries stale introductions as updates", () => {
  ctx.db.update(schema.candidates).set({ evidence: { repo: "vitejs/vite", repoUrl: "https://github.com/vitejs/vite", highlights: ["Adds a flag."], highlightsAt: 1 } }).run();
  applyResult(ctx, "test", { kind: "draft", candidateId: id, channel: "x", lang: "en", model: "t", result: { body: "Intro" }, draftPurpose: "introduction" });
  expect(requestedIntroduction(ctx, "test", id, "x", "en")).toBe(true);
  // 같은 채널의 다시 쓰기가 실패한 뒤 실제 게시를 확인한다.
  const failed = queueStep(ctx, "test", "draft", id, "x", "en", { introduction: true, instruction: "Make it shorter" });
  const linkedin = queueStep(ctx, "test", "draft", id, "linkedin", "ko", { introduction: true });
  ctx.db.update(schema.llmJobs).set({ status: "failed", finishedAt: Date.now(), createdAt: Date.now() - 1000 }).run();
  registerPublication(ctx, "test", { candidateId: id, channel: "x" });
  expect(requestedIntroduction(ctx, "test", id, "x", "en")).toBe(false);
  expect(buildPrompt(ctx, "test", "draft", id, "x", "en").user).not.toContain("## First introduction");
  const retried = retryGeneration(ctx, "test", failed);
  const job = ctx.db.select().from(schema.llmJobs).where(eq(schema.llmJobs.id, retried)).get();
  expect(job?.meta?.draftPurpose).toBe("update");
  expect(job?.user).not.toContain("## First introduction");
  // 편집 지시는 다시 만든 프롬프트에도 남는다.
  expect(job?.user).toContain("Make it shorter");
  // 다른 채널(LinkedIn)은 X에서 알린 것으로 소개된 것이 아니다. 첫 소개 그대로 다시 시도한다.
  const linkedinRetry = ctx.db.select().from(schema.llmJobs).where(eq(schema.llmJobs.id, retryGeneration(ctx, "test", linkedin))).get();
  expect(linkedinRetry?.meta?.draftPurpose).toBe("introduction");
  // 명시한 첫 소개는 그대로 따른다.
  expect(requestedIntroduction(ctx, "test", id, "x", "en", true)).toBe(true);
});

it("tells the introduction judge not to call an established project a first release", () => {
  ctx.db.update(schema.candidates).set({ evidence: { repo: "vitejs/vite", repoUrl: "https://github.com/vitejs/vite", highlights: ["Adds a flag."], highlightsAt: 1 } }).run();
  expect(buildPrompt(ctx, "test", "judge", id).user).toContain("never call it a first release");
});


it("honors an explicit introduction despite publication history and an old change angle", () => {
  applyResult(ctx, "test", { kind: "judge", candidateId: id, model: "t", result: { scores: {}, reasoning: "Update", angle: "Only discuss the latest patch" } });
  ctx.db.insert(schema.publications).values({ ownerId: "test", candidateId: id, channel: "x", url: "https://x.com/a/status/1", publishedAt: 1 }).run();
  applyResult(ctx, "test", { kind: "draft", candidateId: id, channel: "x", lang: "en", model: "t", result: { body: "Previous update draft" } });
  const prompt = buildPrompt(ctx, "test", "draft", id, "x", "en", { introduction: true, instruction: "Keep it short" });
  expect(prompt.user).toContain("## First introduction");
  expect(prompt.user).toContain("Keep it short");
  expect(prompt.user).not.toContain("Only discuss the latest patch");
  expect(prompt.user).not.toContain("Previous update draft");
  expect(prompt.system).toContain("open with what the project is and who it is for");
});

it("scales the weighted rubric to 10 so raising a weight does not lower the bar", () => {
  const scores = { runnable: 2, numbers: 0, lesson: 0, novelty: 2, audience: 2 };
  const ones = { runnable: 1, numbers: 1, lesson: 1, novelty: 1, audience: 1 };
  expect(rubricTotal(scores, ones)).toBe(6);
  // 예전 방식이면 2배 가중치로 합이 12가 되어 근거 없는 글감도 초안 기준을 넘었다.
  expect(rubricTotal(scores, { ...ones, runnable: 2, novelty: 2, audience: 2, numbers: 2, lesson: 2 })).toBe(6);
  expect(rubricTotal(scores, { ...ones, numbers: 3 })).toBe(4.3);
  expect(rubricTotal(scores, { runnable: 0, numbers: 0, lesson: 0, novelty: 0, audience: 0 })).toBe(0);
});

it("tells drafts which releases a window spans and which PRs are not released yet", () => {
  const sig = (kind: string, ref: string, title: string, at: number, payload: Record<string, unknown> = {}) =>
    ctx.db.insert(schema.signals).values({ ownerId: "test", sourceId: 1, kind, repo: "vitejs/vite", ref, title, payload, occurredAt: at, candidateId: id }).run();
  sig("release", "r1", "vite v0.8.55", 1000, { tag: "v0.8.55" });
  sig("release", "r2", "vite v0.8.56", 2000, { tag: "v0.8.56" });
  sig("pr_merged", "p1", "Add dashboard rail", 1500);
  sig("pr_merged", "p2", "Native app tab dragging", 3000);
  ctx.db.update(schema.candidates).set({ evidence: { repo: "vitejs/vite", repoUrl: "https://github.com/vitejs/vite", version: "v0.8.56", highlights: ["Adds a flag."], highlightsAt: 1 } }).run();
  const user = buildPrompt(ctx, "test", "draft", id, "x", "en", { introduction: false }).user;
  expect(user).toContain("releases in this window: v0.8.55, v0.8.56");
  expect(user).toContain("merged after v0.8.56, not in any release yet");
  expect(user).toContain("- Native app tab dragging");
  expect(user).not.toContain("- Add dashboard rail");
});

it("drops an introduction-era angle from update drafts and marks unreleased highlights", () => {
  ctx.db.update(schema.candidates).set({ evidence: { repo: "vitejs/vite", repoUrl: "https://github.com/vitejs/vite", highlights: ["Adds a flag.", "(unreleased) Mac app tab dragging."], highlightsAt: 1 } }).run();
  applyResult(ctx, "test", { kind: "judge", candidateId: id, model: "t", result: { scores: {}, reasoning: "r", angle: "Introduce vite to new readers" } });
  expect(buildPrompt(ctx, "test", "draft", id, "x", "en").user).toContain("Introduce vite to new readers");
  applyResult(ctx, "test", { kind: "draft", candidateId: id, channel: "x", lang: "en", model: "t", result: { body: "Intro" }, draftPurpose: "introduction" });
  registerPublication(ctx, "test", { candidateId: id, channel: "x" });
  const update = buildPrompt(ctx, "test", "draft", id, "x", "en").user;
  expect(update).not.toContain("Introduce vite to new readers");
  expect(update).toContain("Items marked (unreleased) are on the main branch");
});

it("shows the judge what the editor overrode, including deferring a draft verdict", () => {
  ctx.db.update(schema.candidates).set({ evidence: { repo: "vitejs/vite", repoUrl: "https://github.com/vitejs/vite", highlights: ["Adds a flag."], highlightsAt: 1 } }).run();
  applyResult(ctx, "test", { kind: "judge", candidateId: id, model: "t", result: { scores: { runnable: 2, numbers: 1, lesson: 1, novelty: 1, audience: 2 }, reasoning: "r" } });
  ctx.db.update(schema.candidates).set({ status: "judged" }).run();
  setCandidateStatus(ctx, "test", id, "deferred");
  const user = buildPrompt(ctx, "test", "judge", id).user;
  expect(user).toContain("The editor overrode these past judgments");
  expect(user).toContain('"Dependency maintenance": you said draft (7/10; runnable 2, numbers 1, lesson 1, novelty 1, audience 2) → editor chose defer (deferred by editor)');
  // 보류를 풀면 번복이 아니다.
  setCandidateStatus(ctx, "test", id, "judged");
  expect(buildPrompt(ctx, "test", "judge", id).user).not.toContain("The editor overrode");
  expect(ctx.db.select().from(schema.feedback).all()).toHaveLength(0);
  // 초안이 있는 글감을 미루는 것은 번복으로 남기지 않는다.
  ctx.db.update(schema.candidates).set({ status: "drafted" }).run();
  setCandidateStatus(ctx, "test", id, "deferred");
  expect(buildPrompt(ctx, "test", "judge", id).user).not.toContain("The editor overrode");
});

it("adds one under-posted everyday channel to the judge's picks, never launch channels", () => {
  updateSettings(ctx, "test", { channelLangs: { x: ["en"], linkedin: ["ko"], threads: ["ko"], show_hn: ["en"], show_gn: ["ko"] } });
  ctx.db.update(schema.candidates).set({ evidence: { repo: "vitejs/vite", repoUrl: "https://github.com/vitejs/vite", highlights: ["Adds a flag."], highlightsAt: 1 } }).run();
  const judge = () => applyResult(ctx, "test", { kind: "judge", candidateId: id, model: "t", result: { scores: { runnable: 2, numbers: 2, lesson: 2, novelty: 2, audience: 2 }, reasoning: "r", suggestedChannels: ["x"] } });
  const drafted = () => ctx.db.select().from(schema.llmJobs).all().filter((j) => j.kind === "draft").map((j) => j.channel).sort();
  // LinkedIn에는 이미 한 번 올렸다. Threads가 더 적게 올린 채널이라 그쪽을 탐색한다.
  ctx.db.insert(schema.publications).values({ ownerId: "test", candidateId: id, channel: "linkedin", url: "https://www.linkedin.com/posts/a-1", publishedAt: 1 }).run();
  judge();
  expect(drafted()).toEqual(["threads", "x"]);
  // 일상 채널 모두 두 번 이상 올렸으면 판단의 추천만 따른다.
  ctx.db.delete(schema.llmJobs).run();
  for (const ch of ["linkedin", "threads", "threads"]) ctx.db.insert(schema.publications).values({ ownerId: "test", candidateId: id, channel: ch, url: `https://example.test/${ch}/${Math.random()}`, publishedAt: 2 }).run();
  judge();
  expect(drafted()).toEqual(["x"]);
});

it("does not call release housekeeping PRs unreleased work", () => {
  const sig = (kind: string, ref: string, title: string, at: number, payload: Record<string, unknown> = {}) =>
    ctx.db.insert(schema.signals).values({ ownerId: "test", sourceId: 1, kind, repo: "vitejs/vite", ref, title, payload, occurredAt: at, candidateId: id }).run();
  sig("release", "r1", "vite v0.6.0", 1000, { tag: "v0.6.0" });
  sig("pr_merged", "p1", "chore(release): 0.6.0 is out", 1200);
  sig("pr_merged", "p2", "Add grouped session views", 3000);
  ctx.db.update(schema.candidates).set({ title: "vitejs/vite v0.6.0" }).run();
  expect(windowFacts(ctx, "test", id).unreleasedPrTitles).toEqual(["Add grouped session views"]);
  // 정리 PR이 아닌 일반 PR은 이름에 release·build가 있어도 미릴리스 작업이다.
  sig("pr_merged", "p3", "fix: release file handles on shutdown", 3100);
  sig("pr_merged", "p4", "build: drop Node 18 support", 3200);
  expect(windowFacts(ctx, "test", id).unreleasedPrTitles).toEqual(["Add grouped session views", "fix: release file handles on shutdown", "build: drop Node 18 support"]);
});

it("keeps an editor-deferred candidate deferred when running drafts finish, but sends drafts of a judge-deferred one to review", () => {
  ctx.db.update(schema.candidates).set({ evidence: { repo: "vitejs/vite", repoUrl: "https://github.com/vitejs/vite", highlights: ["Adds a flag."], highlightsAt: 1 } }).run();
  applyResult(ctx, "test", { kind: "judge", candidateId: id, model: "t", result: { scores: { runnable: 2, numbers: 2, lesson: 2, novelty: 2, audience: 2 }, reasoning: "r" } });
  setCandidateStatus(ctx, "test", id, "deferred");
  applyResult(ctx, "test", { kind: "draft", candidateId: id, channel: "x", lang: "en", model: "t", result: { body: "Draft" } });
  expect(ctx.db.select().from(schema.candidates).get()?.status).toBe("deferred");
  // 판단이 보류한 글감에 사용자가 초안을 요청하면 검수 대기로 간다.
  applyResult(ctx, "test", { kind: "judge", candidateId: id, model: "t", result: { scores: { runnable: 2, numbers: 1, lesson: 0, novelty: 1, audience: 1 }, reasoning: "r" } });
  ctx.db.update(schema.candidates).set({ status: "deferred" }).run();
  applyResult(ctx, "test", { kind: "draft", candidateId: id, channel: "x", lang: "en", model: "t", result: { body: "Draft 2" } });
  expect(ctx.db.select().from(schema.candidates).get()?.status).toBe("drafted");
});

it("marks jobs queued by the automatic sweep as background work", async () => {
  updateSettings(ctx, "test", { watch: { mode: "auto", recentDays: 30 } });
  ctx.db.update(schema.candidates).set({ status: "new", updatedAt: Date.now() }).run();
  await processNewCandidates(ctx, "test");
  const job = ctx.db.select().from(schema.llmJobs).get();
  expect(job?.meta?.background).toBe(true);
});

it("marks PRs after the repo's latest release as unreleased even when that release sits on another candidate", () => {
  const sig = (kind: string, ref: string, title: string, at: number, cand: number | null, payload: Record<string, unknown> = {}) =>
    ctx.db.insert(schema.signals).values({ ownerId: "test", sourceId: 1, kind, repo: "vitejs/vite", ref, title, payload, occurredAt: at, candidateId: cand }).run();
  const other = Number(ctx.db.insert(schema.candidates).values({ ownerId: "test", repo: "vitejs/vite", title: "vitejs/vite v0.6.0", type: "release", key: "old", evidence: { repo: "vitejs/vite", repoUrl: "u" }, status: "dropped", createdAt: 1, updatedAt: 1 }).run().lastInsertRowid);
  sig("release", "r", "vitejs/vite v0.6.0", 1000, other, { tag: "v0.6.0" });
  sig("pr_merged", "p1", "Add grouped session views", 2000, id);
  sig("pr_merged", "p0", "Old fix", 500, id);
  ctx.db.update(schema.candidates).set({ title: "vitejs/vite (2026-W40)" }).where(eq(schema.candidates.id, id)).run();
  expect(windowFacts(ctx, "test", id).unreleasedPrTitles).toEqual(["Add grouped session views"]);
});

it("does not let a late backport on an older line become the unreleased cutoff", () => {
  const sig = (kind: string, ref: string, title: string, at: number, cand: number | null, payload: Record<string, unknown> = {}) =>
    ctx.db.insert(schema.signals).values({ ownerId: "test", sourceId: 1, kind, repo: "vitejs/vite", ref, title, payload, occurredAt: at, candidateId: cand }).run();
  sig("release", "r8", "vitejs/vite v8.4.0", 1000, null, { tag: "v8.4.0" });
  sig("release", "r7", "vitejs/vite v7.3.5", 3000, null, { tag: "v7.3.5" });
  sig("pr_merged", "p1", "Main work", 2000, id);
  ctx.db.update(schema.candidates).set({ title: "vitejs/vite (2026-W40)" }).where(eq(schema.candidates.id, id)).run();
  expect(windowFacts(ctx, "test", id).unreleasedPrTitles).toEqual(["Main work"]);
});
