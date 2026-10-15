import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, schema } from "../infra/db/index.js";
import type { AppContext } from "./context.js";
import { claimJob, completeJob, generationStatus, holdsClaim, JOB_LEASE_MS, MAX_JOB_ATTEMPTS, pendingJobs, retryGeneration, pruneFinishedJobs } from "./jobs.js";
import { updateSettings } from "./settings.js";
import { digestCurrent, enqueueJob } from "./pipeline.js";
import { DIGEST_REVISION, draftPrompt, instructionOf } from "../core/prompts.js";
import { digestSourceHash } from "./digest-cache.js";

describe("local worker job lifecycle", () => {
  let ctx: AppContext;
  let candidateId: number;
  let jobId: number;
  beforeEach(() => {
    vi.useFakeTimers();
    ctx = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: {} as AppContext["usage"] };
    updateSettings(ctx, "a", { llm: { provider: "local-agent" } });
    candidateId = Number(ctx.db.insert(schema.candidates).values({ ownerId: "a", type: "release", title: "t", repo: "a/x", key: "test", evidence: { repo: "a/x", repoUrl: "https://github.com/a/x" }, status: "new", createdAt: Date.now(), updatedAt: Date.now() }).run().lastInsertRowid);
    jobId = enqueueJob(ctx, "a", "draft", candidateId, "x", "en", { system: "s", user: "u", schema: {}, schemaName: "test" });
  });
  afterEach(() => { ctx.db.$client.close(); vi.useRealTimers(); vi.restoreAllMocks(); });
  const valid = JSON.stringify({ body: "A test draft with 1 limitation: beta. https://github.com/a/x" });
  const row = () => ctx.db.select().from(schema.llmJobs).where(eq(schema.llmJobs.id, jobId)).get()!;
  const claim = () => claimJob(ctx, "a", jobId, "worker").claimToken!;

  it.each([false, true])("preserves all editor paragraphs across failed draft retry, published=%s", (published) => {
    ctx.db.delete(schema.llmJobs).run();
    const instruction = "기능 하나만 설명하세요.\n\n## 예외와 원복\n- 운영자가 0으로 닫은 한도는 유지하세요.\n- 원복은 이전 필드 복원과 URL 제거를 함께 하세요.";
    const prompt = draftPrompt({ title: "t", type: "release", evidence: { repo: "a/x", repoUrl: "https://github.com/a/x" } }, "threads", "ko", [], undefined, { introduction: true, instruction });
    jobId = enqueueJob(ctx, "a", "draft", candidateId, "threads", "ko", prompt);
    expect(pendingJobs(ctx, "a")[0].editorInstruction).toBe(instruction);
    completeJob(ctx, "a", jobId, { claimToken: claim(), error: "failed" });
    if (published) {
      vi.advanceTimersByTime(1000);
      ctx.db.insert(schema.publications).values({ ownerId: "a", candidateId, channel: "threads", url: "https://example.com/post", publishedAt: Date.now() }).run();
    }
    const retry = retryGeneration(ctx, "a", jobId);
    const next = ctx.db.select().from(schema.llmJobs).where(eq(schema.llmJobs.id, retry)).get()!;
    expect(next.meta?.editorInstruction).toBe(instruction);
    expect(next.user).toContain(instruction);
    expect(next.meta?.draftPurpose).toBe(published ? "update" : "introduction");
    if (!published) expect(next.user).toBe(prompt.user);
    expect(generationStatus(ctx, "a", candidateId)[0]).not.toHaveProperty("editorInstruction");
  });

  it("uses explicit empty instruction metadata and falls back only for legacy jobs", () => {
    const user = "prefix\n## Editor instruction for this rewrite\nLegacy sentence\n\n## Facts\nsource";
    expect(instructionOf(user)).toBe("Legacy sentence");
    expect(instructionOf(user, { editorInstruction: "" })).toBe("");
    expect(instructionOf(user, { editorInstruction: "first\n\n## second\nkeep all" })).toBe("first\n\n## second\nkeep all");
  });

  it("prunes editor instructions with completed prompts while preserving unrelated metadata and failed jobs", () => {
    ctx.db.update(schema.llmJobs).set({ meta: { editorInstruction: "private", draftPurpose: "update" } }).where(eq(schema.llmJobs.id, jobId)).run();
    completeJob(ctx, "a", jobId, { claimToken: claim(), resultJson: valid });
    const failed = enqueueJob(ctx, "a", "draft", candidateId, "x", "en", { system: "s", user: "retry me", schema: {}, schemaName: "draft", editorInstruction: "keep private" });
    completeJob(ctx, "a", failed, { claimToken: claimJob(ctx, "a", failed, "worker").claimToken!, error: "failed" });
    vi.advanceTimersByTime(15 * 86_400_000);
    expect(pruneFinishedJobs(ctx)).toBe(1);
    expect(row()).toMatchObject({ system: "", user: "", resultJson: null, meta: { draftPurpose: "update" } });
    expect(row().meta).not.toHaveProperty("editorInstruction");
    expect(ctx.db.select().from(schema.llmJobs).where(eq(schema.llmJobs.id, failed)).get()?.meta?.editorInstruction).toBe("keep private");
  });

  it.each([undefined, "previous-contract", DIGEST_REVISION])("retains the actual digest job revision %s on completion", (digestRevision) => {
    const source = ctx.db.select().from(schema.candidates).get()!;
    ctx.db.update(schema.candidates).set({ evidence: { ...source.evidence, digestRevision: DIGEST_REVISION } }).run();
    const id = enqueueJob(ctx, "a", "digest", candidateId, undefined, undefined, { system: "frozen digest", user: "frozen source", schema: {}, schemaName: "digest", digestRevision });
    const job = ctx.db.select().from(schema.llmJobs).where(eq(schema.llmJobs.id, id)).get()!;
    expect(job.meta?.digestRevision).toBe(digestRevision);
    const claimToken = claimJob(ctx, "a", id, "worker").claimToken!;
    expect(completeJob(ctx, "a", id, { claimToken, resultJson: JSON.stringify({ highlights: ["A source-backed update."], limitations: [] }) }).applied).toBe(true);
    const candidate = ctx.db.select().from(schema.candidates).get()!;
    expect(candidate.evidence.digestRevision).toBe(digestRevision);
    expect(digestCurrent(candidate)).toBe(digestRevision === DIGEST_REVISION);
    expect(ctx.db.select().from(schema.llmJobs).where(eq(schema.llmJobs.id, id)).get()!.status).toBe(digestRevision === DIGEST_REVISION ? "done" : "failed");
  });

  it.each([false, true])("holds a late legacy digest and retries with current sources, continuation %s", (continueDraft) => {
    ctx.db.delete(schema.llmJobs).run();
    const continuation = continueDraft ? { targets: [{ channel: "threads" as const, lang: "ko" }], introduction: false } : undefined;
    const old = enqueueJob(ctx, "a", "digest", candidateId, undefined, undefined, { system: "legacy", user: "legacy source", schema: {}, schemaName: "digest" }, continuation);
    // 새 요청이 대기 중인 구 작업에 합쳐져도 구 작업을 새 계약으로 바꾸지 않는다.
    const merged = enqueueJob(ctx, "a", "digest", candidateId, undefined, undefined, { system: "new", user: "new source", schema: {}, schemaName: "digest", digestRevision: DIGEST_REVISION }, continuation);
    expect(merged).toBe(old);
    const claimToken = claimJob(ctx, "a", old, "worker").claimToken!;
    const raw = JSON.stringify({ highlights: ["Legacy summary retained for inspection."], limitations: [] });
    completeJob(ctx, "a", old, { claimToken, resultJson: raw });
    const oldRow = ctx.db.select().from(schema.llmJobs).where(eq(schema.llmJobs.id, old)).get()!;
    expect(oldRow).toMatchObject({ status: "failed", resultJson: raw });
    expect(oldRow.error).toContain("원자료");
    expect(pendingJobs(ctx, "a")).toEqual([]);
    expect(ctx.db.select().from(schema.drafts).all()).toEqual([]);
    expect(ctx.db.select().from(schema.candidates).get()!.evidence.highlights).toEqual(["Legacy summary retained for inspection."]);
    const retry = retryGeneration(ctx, "a", old);
    const retried = ctx.db.select().from(schema.llmJobs).where(eq(schema.llmJobs.id, retry)).get()!;
    expect(retried.meta?.digestRevision).toBe(DIGEST_REVISION);
    expect(retried.continuation).toEqual(continuation ?? null);
    completeJob(ctx, "a", retry, { claimToken: claimJob(ctx, "a", retry, "worker").claimToken!, resultJson: JSON.stringify({ highlights: ["Current source-backed summary."], limitations: [] }) });
    expect(digestCurrent(ctx.db.select().from(schema.candidates).get()!)).toBe(true);
    expect(pendingJobs(ctx, "a").map((j) => j.kind)).toEqual([continueDraft ? "draft" : "judge"]);
  });

  it.each([
    { jobRevision: undefined, evidenceRevision: DIGEST_REVISION, retryKind: "judge" },
    { jobRevision: DIGEST_REVISION, evidenceRevision: undefined, retryKind: "digest" },
  ])("holds a judge with stale summary input and retries through $retryKind", ({ jobRevision, evidenceRevision, retryKind }) => {
    ctx.db.delete(schema.llmJobs).run();
    const now = Date.now();
    ctx.db.update(schema.candidates).set({ evidence: { repo: "a/x", repoUrl: "https://github.com/a/x", highlights: ["A retained summary."], highlightsAt: now, digestRevision: evidenceRevision } }).run();
    const id = enqueueJob(ctx, "a", "judge", candidateId, undefined, undefined, { system: "frozen judge", user: "frozen summary", schema: {}, schemaName: "judgment", digestRevision: jobRevision });
    const raw = JSON.stringify({ scores: { runnable: 2, numbers: 2, lesson: 2, novelty: 2, audience: 2 }, reasoning: "An old recommendation", suggestedChannels: ["x"], angle: "Old summary angle" });
    completeJob(ctx, "a", id, { claimToken: claimJob(ctx, "a", id, "worker").claimToken!, resultJson: raw });
    expect(ctx.db.select().from(schema.llmJobs).where(eq(schema.llmJobs.id, id)).get()).toMatchObject({ status: "failed", resultJson: raw });
    expect(ctx.db.select().from(schema.judgments).all()).toEqual([]);
    expect(ctx.db.select().from(schema.drafts).all()).toEqual([]);
    expect(pendingJobs(ctx, "a")).toEqual([]);
    const retry = retryGeneration(ctx, "a", id);
    expect(ctx.db.select().from(schema.llmJobs).where(eq(schema.llmJobs.id, retry)).get()).toMatchObject({ kind: retryKind, meta: { digestRevision: DIGEST_REVISION } });
  });

  it("does not apply an old judge to a newer digest with the same contract", () => {
    ctx.db.delete(schema.llmJobs).run();
    const now = Date.now();
    const old = { repo: "a/x", repoUrl: "https://github.com/a/x", releaseNotes: "Original policy", highlights: ["Original summary"], highlightsAt: now, digestRevision: DIGEST_REVISION };
    ctx.db.update(schema.candidates).set({ evidence: { ...old, digestSourceHash: digestSourceHash(old) } }).run();
    const id = enqueueJob(ctx, "a", "judge", candidateId, undefined, undefined, { system: "judge", user: "original summary", schema: {}, schemaName: "judgment", digestRevision: DIGEST_REVISION, digestSourceHash: digestSourceHash(old) });
    const next = { ...old, releaseNotes: "Updated policy", highlights: ["Updated summary"] };
    ctx.db.update(schema.candidates).set({ evidence: { ...next, digestSourceHash: digestSourceHash(next) } }).run();
    const current = ctx.db.select().from(schema.candidates).get()!;
    expect(digestCurrent(current)).toBe(true);
    completeJob(ctx, "a", id, { claimToken: claimJob(ctx, "a", id, "worker").claimToken!, resultJson: JSON.stringify({ scores: { runnable: 2, numbers: 2, lesson: 2, novelty: 2, audience: 2 }, reasoning: "Old recommendation" }) });
    expect(ctx.db.select().from(schema.llmJobs).where(eq(schema.llmJobs.id, id)).get()!.status).toBe("failed");
    expect(ctx.db.select().from(schema.judgments).all()).toEqual([]);
    expect(pendingJobs(ctx, "a")).toEqual([]);
    expect(ctx.db.select().from(schema.candidates).get()).toEqual(current);
  });

  it("lets only the live claim report completion (so local usage is counted once)", () => {
    const token = claim();
    expect(holdsClaim(ctx, "a", jobId, token)).toBe(true);
    expect(holdsClaim(ctx, "a", jobId, "00000000-0000-4000-8000-000000000000")).toBe(false);
    completeJob(ctx, "a", jobId, { claimToken: token, resultJson: valid });
    expect(holdsClaim(ctx, "a", jobId, token)).toBe(false);
  });

  it("stops showing a failure once a newer draft for the same channel and language exists", () => {
    completeJob(ctx, "a", jobId, { claimToken: claim(), error: "claude exited 1: Not logged in" });
    expect(generationStatus(ctx, "a", candidateId).map((j) => j.status)).toEqual(["failed"]);
    vi.advanceTimersByTime(1000);
    const now = Date.now();
    // 다른 언어의 초안은 이 실패를 가리지 않는다.
    ctx.db.insert(schema.drafts).values({ ownerId: "a", candidateId, channel: "x", lang: "ko", version: 1, body: "b", lint: [], status: "proposed", model: "gemini", createdAt: now, updatedAt: now }).run();
    expect(generationStatus(ctx, "a", candidateId).map((j) => j.status)).toEqual(["failed"]);
    ctx.db.insert(schema.drafts).values({ ownerId: "a", candidateId, channel: "x", lang: "en", version: 2, body: "b", lint: [], status: "proposed", model: "gemini", createdAt: now, updatedAt: now }).run();
    expect(generationStatus(ctx, "a", candidateId)).toEqual([]);
  });

  it("keeps showing a failure when the only draft is older than the failure", () => {
    const now = Date.now();
    ctx.db.insert(schema.drafts).values({ ownerId: "a", candidateId, channel: "x", lang: "en", version: 1, body: "b", lint: [], status: "proposed", model: "gemini", createdAt: now - 60_000, updatedAt: now - 60_000 }).run();
    completeJob(ctx, "a", jobId, { claimToken: claim(), error: "boom" });
    expect(generationStatus(ctx, "a", candidateId).map((j) => j.status)).toEqual(["failed"]);
  });

  it("allows only one claimant and isolates owners", () => {
    expect(pendingJobs(ctx, "b")).toEqual([]);
    expect(claimJob(ctx, "b", jobId, "worker").claimed).toBe(false);
    expect(claim()).toBeTruthy();
    expect(claimJob(ctx, "a", jobId, "other").claimed).toBe(false);
    expect(() => completeJob(ctx, "b", jobId, { claimToken: row().claimToken!, resultJson: valid })).toThrow("job not found");
  });

  it("applies a repeated completion only once and ignores later failure reports", () => {
    const claimToken = claim();
    expect(completeJob(ctx, "a", jobId, { claimToken, resultJson: valid })).toEqual({ applied: true });
    expect(completeJob(ctx, "a", jobId, { claimToken, resultJson: valid })).toEqual({ applied: false });
    expect(completeJob(ctx, "a", jobId, { claimToken, error: "late error" })).toEqual({ applied: false });
    expect(ctx.db.select().from(schema.drafts).all()).toHaveLength(1);
    expect(row().status).toBe("done");
  });

  it.each(["{", "null", "{}", '{"body":42}', '{"body":" "}'])("rejects malformed results: %s", (resultJson) => {
    expect(completeJob(ctx, "a", jobId, { claimToken: claim(), resultJson })).toEqual({ applied: false });
    expect(row().status).toBe("failed");
    expect(ctx.db.select().from(schema.drafts).all()).toHaveLength(0);
  });

  it("recovers expired claims and fences out the previous worker", () => {
    const old = claim();
    vi.advanceTimersByTime(JOB_LEASE_MS);
    expect(completeJob(ctx, "a", jobId, { claimToken: old, resultJson: valid }).applied).toBe(false);
    expect(pendingJobs(ctx, "a").map((j) => j.id)).toContain(jobId);
    const current = claim();
    expect(current).not.toBe(old);
    expect(completeJob(ctx, "a", jobId, { claimToken: old, error: "late" }).applied).toBe(false);
    expect(completeJob(ctx, "a", jobId, { claimToken: current, resultJson: valid }).applied).toBe(true);
  });

  it("stops recovering a repeatedly abandoned job at the attempt limit", () => {
    for (let n = 0; n < MAX_JOB_ATTEMPTS; n++) {
      expect(claim()).toBeTruthy();
      vi.advanceTimersByTime(JOB_LEASE_MS);
    }
    expect(pendingJobs(ctx, "a")).toEqual([]);
    expect(row().status).toBe("failed");
    expect(row().attempts).toBe(MAX_JOB_ATTEMPTS);
  });

  it("rolls back partial application and emits no uncommitted changes", () => {
    const claimToken = claim();
    const events = vi.fn(); ctx.bus.on("change", events);
    ctx.db.$client.exec("CREATE TRIGGER fail_candidate BEFORE UPDATE ON candidates BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    expect(() => completeJob(ctx, "a", jobId, { claimToken, resultJson: valid })).toThrow("injected failure");
    expect(ctx.db.select().from(schema.drafts).all()).toHaveLength(0);
    expect(row().status).toBe("claimed");
    expect(events).not.toHaveBeenCalled();
    ctx.db.$client.exec("DROP TRIGGER fail_candidate");
    expect(completeJob(ctx, "a", jobId, { claimToken, resultJson: valid }).applied).toBe(true);
  });

  it("durably enqueues the next pipeline step before reporting completion", () => {
    ctx.db.update(schema.llmJobs).set({ kind: "digest", channel: null, lang: null, meta: { digestRevision: DIGEST_REVISION } }).where(eq(schema.llmJobs.id, jobId)).run();
    const input = { claimToken: claim(), resultJson: JSON.stringify({ highlights: ["Ships an API"], limitations: [] }) };
    expect(completeJob(ctx, "a", jobId, input).applied).toBe(true);
    expect(completeJob(ctx, "a", jobId, input).applied).toBe(false);
    const next = pendingJobs(ctx, "a");
    expect(next).toHaveLength(1);
    expect(next[0].kind).toBe("judge");
  });
});


describe("side job retry after changing model provider", () => {
  it.each([
    ["lesson", "local", "gemini", "server"],
    ["lesson", "server", "local-agent", "local"],
    ["profile", "local", "gemini", "server"],
    ["profile", "server", "local-agent", "local"],
  ] as const)("retries %s from %s with current %s executor %s", (kind, oldExecutor, provider, expected) => {
    const ctx: AppContext = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: {} as AppContext["usage"] };
    try {
      const meta = kind === "profile" ? { repo: "a/x" } : { draftId: 42 };
      const id = Number(ctx.db.insert(schema.llmJobs).values({ ownerId: "a", kind, candidateId: 0, executor: oldExecutor, system: "original system", user: "original input", schemaJson: "{}", meta, status: "failed", attempts: 3, error: "offline", createdAt: 1 }).run().lastInsertRowid);
      updateSettings(ctx, "a", { llm: { provider } });
      const retriedId = retryGeneration(ctx, "a", id);
      const retried = ctx.db.select().from(schema.llmJobs).where(eq(schema.llmJobs.id, retriedId)).get()!;
      expect(retried).toMatchObject({ executor: expected, status: "pending", attempts: 0, system: "original system", user: "original input", meta });
      expect(retriedId).not.toBe(id);
      expect(ctx.db.select().from(schema.llmJobs).where(eq(schema.llmJobs.id, id)).get()!.status).toBe("failed");
    } finally { ctx.db.$client.close(); }
  });
});
