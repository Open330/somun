import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, schema } from "../infra/db/index.js";
import type { AppContext } from "./context.js";
import { claimJob, completeJob, generationStatus, JOB_LEASE_MS, MAX_JOB_ATTEMPTS, pendingJobs } from "./jobs.js";
import { updateSettings } from "./settings.js";
import { enqueueJob } from "./pipeline.js";

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
    ctx.db.update(schema.llmJobs).set({ kind: "digest", channel: null, lang: null }).where(eq(schema.llmJobs.id, jobId)).run();
    const input = { claimToken: claim(), resultJson: JSON.stringify({ highlights: ["Ships an API"], limitations: [] }) };
    expect(completeJob(ctx, "a", jobId, input).applied).toBe(true);
    expect(completeJob(ctx, "a", jobId, input).applied).toBe(false);
    const next = pendingJobs(ctx, "a");
    expect(next).toHaveLength(1);
    expect(next[0].kind).toBe("judge");
  });
});
