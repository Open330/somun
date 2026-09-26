import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDb, schema } from "../infra/db/index.js";
import { LlmError, runLlm, type LlmResult } from "../infra/llm/providers.js";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import type { AppContext } from "./context.js";
import { processServerJob } from "./generation-worker.js";
import { generationStatus, pendingJobs, claimJob, JOB_LEASE_MS, completeJob } from "./jobs.js";
import { processNewCandidates, queueStep } from "./pipeline.js";
import { updateSettings } from "./settings.js";

vi.mock("../infra/llm/providers.js", async (original) => ({ ...await original<typeof import("../infra/llm/providers.js")>(), runLlm: vi.fn() }));
let ctx: AppContext, app: ReturnType<typeof createApp>, cid: number;
const headers = { Authorization: "Bearer test", "Content-Type": "application/json" };
const output = (json: unknown): LlmResult => ({ json, provider: "gemini", model: "test", latencyMs: 1 });
const draft = { title: "", body: "v1 fixes CRLF positions. https://github.com/a/b" };
const request = (path: string, body: unknown = {}) => app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
const row = (id: number) => ctx.db.select().from(schema.llmJobs).where(eq(schema.llmJobs.id, id)).get()!;
const params = { targets: [{ channel: "x", lang: "en" }] };
beforeEach(() => {
  ctx = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: { record: vi.fn() } as unknown as AppContext["usage"] };
  app = createApp(ctx, loadConfig({ SOMUN_TOKEN: "test" }));
  cid = Number(ctx.db.insert(schema.candidates).values({ ownerId: "local", repo: "a/b", title: "Fix", type: "release", key: "test", evidence: { repo: "a/b", repoUrl: "https://github.com/a/b", highlights: ["Fixes CRLF positions."], highlightsAt: 1 }, status: "judged", createdAt: 1, updatedAt: 1 }).run().lastInsertRowid);
  vi.mocked(runLlm).mockResolvedValue(output(draft));
});
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); ctx.db.$client.close(); });

it("acknowledges without calling the model and persists claimed/done states without exposing prompts", async () => {
  const response = await request(`/api/candidates/${cid}/redraft`, params);
  expect(response.status).toBe(202); expect(response.headers.get("Location")).toContain("/api/jobs/status");
  const { jobs } = await response.json();
  expect(runLlm).not.toHaveBeenCalled(); expect(pendingJobs(ctx, "local")).toEqual([]);
  expect(claimJob(ctx, "local", jobs[0], "external").claimed).toBe(false);
  let resolve!: (result: LlmResult) => void;
  vi.mocked(runLlm).mockImplementation(() => new Promise((done) => { resolve = done; }));
  const running = processServerJob(ctx);
  expect(row(jobs[0]).status).toBe("claimed");
  const status = await (await app.request(`/api/jobs/status?candidateId=${cid}`, { headers })).json();
  expect(status[0].status).toBe("claimed");
  for (const field of ["system", "user", "schemaJson", "resultJson", "claimToken"]) expect(status[0]).not.toHaveProperty(field);
  expect(JSON.stringify(status)).not.toContain("claimToken");
  const duplicate = await (await request(`/api/candidates/${cid}/redraft`, params)).json();
  expect(duplicate.jobs).toEqual(jobs);
  resolve(output(draft)); await running;
  expect(row(jobs[0]).status).toBe("done"); expect(ctx.db.select().from(schema.drafts).all()).toHaveLength(1);
  expect(await processServerJob(ctx)).toBe(false);
});

it("isolates status and retry by owner and rejects foreign candidates atomically", async () => {
  queueStep(ctx, "local", "draft", cid, "x", "en");
  expect(generationStatus(ctx, "other")).toEqual([]);
  expect(() => generationStatus(ctx, "other", cid)).toThrow("not found");
  const otherApp = createApp(ctx, loadConfig({ SOMUN_TOKEN: "other", SOMUN_TOKEN_OWNER_ID: "other" }));
  const response = await otherApp.request("/api/jobs/1/retry", { method: "POST", headers: { Authorization: "Bearer other" } });
  expect(response.status).toBe(404);
  expect((await request("/api/candidates/judge", { ids: [cid, 999] })).status).toBe(404);
  expect(ctx.db.select().from(schema.llmJobs).all()).toHaveLength(1);
});

it("persists safe failure text and retries with the original instruction", async () => {
  const response = await request(`/api/candidates/${cid}/redraft`, { ...params, instruction: "Make it shorter" });
  const id = (await response.json()).jobs[0];
  vi.mocked(runLlm).mockRejectedValueOnce(new LlmError("upstream leaked-key", 429, true, "leaked-key"));
  await processServerJob(ctx);
  expect(row(id).status).toBe("failed");
  expect(row(id).error).toContain("429"); expect(row(id).error).not.toContain("leaked-key");
  const retry = await request(`/api/jobs/${id}/retry`); expect(retry.status).toBe(202);
  const next = (await retry.json()).jobs[0]; expect(row(next).user).toContain("Make it shorter");
  await processServerJob(ctx); expect(row(next).status).toBe("done");
  expect(generationStatus(ctx, "local", cid)).toHaveLength(1);
});

it("waits for fresh digest then queues only explicitly requested targets with rewrite instructions", async () => {
  ctx.db.update(schema.candidates).set({ evidence: { repo: "a/b", repoUrl: "https://github.com/a/b" } }).run();
  const response = await request(`/api/candidates/${cid}/redraft`, { ...params, instruction: "One sentence only" });
  expect(response.status).toBe(202);
  vi.mocked(runLlm).mockResolvedValueOnce(output({ highlights: ["CRLF is supported."], limitations: [] }));
  await processServerJob(ctx);
  const pending = pendingJobs(ctx, "local", "server");
  expect(pending).toHaveLength(1); expect(pending[0].kind).toBe("draft");
  expect(pending[0].user).toContain("One sentence only"); expect(pending[0].user).toContain("CRLF is supported.");
  await processServerJob(ctx); expect(ctx.db.select().from(schema.drafts).all()).toHaveLength(1);
  expect(ctx.db.select().from(schema.judgments).all()).toHaveLength(0);
});

it("records no-evidence and malformed-result failures without producing drafts", async () => {
  ctx.db.update(schema.candidates).set({ evidence: { repo: "a/b", repoUrl: "https://github.com/a/b" } }).run();
  const response = await request(`/api/candidates/${cid}/redraft`, params);
  const id = (await response.json()).jobs[0];
  vi.mocked(runLlm).mockResolvedValueOnce(output({ highlights: [], limitations: [] }));
  await processServerJob(ctx); expect(row(id).status).toBe("failed");
  expect(row(id).error).toContain("변경 근거"); expect(pendingJobs(ctx, "local", "server")).toHaveLength(0);
  await request(`/api/jobs/${id}/retry`);
  vi.mocked(runLlm).mockResolvedValueOnce(output({ wrong: "shape" }));
  await processServerJob(ctx);
  expect(generationStatus(ctx, "local", cid)[0].status).toBe("failed");
  expect(ctx.db.select().from(schema.drafts).all()).toHaveLength(0);
});

it("recovers expired server leases and rejects stale completion", async () => {
  vi.useFakeTimers(); const id = queueStep(ctx, "local", "draft", cid, "x", "en");
  const old = claimJob(ctx, "local", id, "server", "server").claimToken!;
  vi.advanceTimersByTime(JOB_LEASE_MS);
  await processServerJob(ctx);
  expect(row(id).status).toBe("done"); expect(row(id).attempts).toBe(2);
  expect(completeJob(ctx, "local", id, { claimToken: old, resultJson: JSON.stringify(draft) }, "server").applied).toBe(false);
  expect(ctx.db.select().from(schema.drafts).all()).toHaveLength(1);
});

it("rejects a different rewrite while one is running instead of silently losing its instruction", async () => {
  await request(`/api/candidates/${cid}/redraft`, { ...params, instruction: "short" });
  expect((await request(`/api/candidates/${cid}/redraft`, { ...params, instruction: "long" })).status).toBe(409);
});

it("keeps local worker tasks out of the server executor", async () => {
  updateSettings(ctx, "local", { llm: { provider: "local-agent" } });
  const id = queueStep(ctx, "local", "draft", cid, "x", "en");
  expect(await processServerJob(ctx)).toBe(false); expect(runLlm).not.toHaveBeenCalled();
  expect(pendingJobs(ctx, "local").map((job) => job.id)).toEqual([id]);
  expect(claimJob(ctx, "local", id, "cli").claimed).toBe(true);
});

it("resumes persisted pending jobs after the database is reopened", async () => {
  const directory = mkdtempSync(join(tmpdir(), "somun-queue-restart-"));
  const candidate = ctx.db.select().from(schema.candidates).get()!;
  ctx.db.$client.close();
  ctx.db = openDb(join(directory, "queue.db"));
  try {
    ctx.db.insert(schema.candidates).values(candidate).run();
    const id = queueStep(ctx, "local", "draft", cid, "x", "en");
    ctx.db.$client.close(); ctx.db = openDb(join(directory, "queue.db"));
    await processServerJob(ctx);
    expect(row(id).status).toBe("done"); expect(ctx.db.select().from(schema.drafts).all()).toHaveLength(1);
  } finally {
    ctx.db.$client.close(); ctx.db = openDb(":memory:"); rmSync(directory, { recursive: true, force: true });
  }
});

it("does not restore an archived candidate when an in-flight generation completes", async () => {
  const id = queueStep(ctx, "local", "draft", cid, "x", "en");
  let resolve!: (result: LlmResult) => void;
  vi.mocked(runLlm).mockImplementation(() => new Promise((done) => { resolve = done; }));
  const running = processServerJob(ctx);
  ctx.db.update(schema.candidates).set({ status: "dropped" }).run();
  resolve(output(draft)); await running;
  expect(row(id).status).toBe("failed");
  expect(ctx.db.select().from(schema.drafts).all()).toHaveLength(0);
  expect(ctx.db.select().from(schema.candidates).get()?.status).toBe("dropped");
  expect((await request(`/api/candidates/${cid}/redraft`, params)).status).toBe(409);
});

it("keeps an automatic sweep moving when a changed candidate already has a queued digest", async () => {
  updateSettings(ctx, "local", { watch: { mode: "auto", recentDays: 30 } });
  ctx.db.update(schema.candidates).set({ status: "new", updatedAt: Date.now() }).run();
  queueStep(ctx, "local", "digest", cid);
  ctx.db.update(schema.candidates).set({ evidence: { repo: "a/b", repoUrl: "https://github.com/a/b", releaseNotes: "Newly collected changes" } }).run();
  const candidate = ctx.db.select().from(schema.candidates).get()!;
  ctx.db.insert(schema.candidates).values({ ...candidate, id: undefined, key: "second" }).run();
  expect(await processNewCandidates(ctx, "local")).toBe(1);
  expect(pendingJobs(ctx, "local", "server")).toHaveLength(2);
});

it("serves owners in turn so one backlog does not starve another", async () => {
  const job = (ownerId: string, candidateId: number) => ctx.db.insert(schema.llmJobs).values({ ownerId, kind: "lesson", candidateId, draftId: 1, system: "s", user: ownerId, schemaJson: "{}", status: "pending", executor: "server", createdAt: Date.now() }).run();
  const other = Number(ctx.db.insert(schema.candidates).values({ ownerId: "b", repo: "b/c", title: "B", type: "release", key: "b", evidence: { repo: "b/c", repoUrl: "https://github.com/b/c" }, status: "judged", createdAt: 1, updatedAt: 1 }).run().lastInsertRowid);
  for (let i = 0; i < 3; i++) job("local", cid);
  job("b", other);
  vi.mocked(runLlm).mockResolvedValue(output({ rule: "", category: "none" }));
  for (let i = 0; i < 4; i++) await processServerJob(ctx);
  const served = vi.mocked(runLlm).mock.calls.map((call) => call[1].user);
  // b의 작업은 마지막에 들어왔지만 local의 두 번째 작업보다 먼저 처리된다.
  expect(served.slice(0, 2).sort()).toEqual(["b", "local"]);
  expect(served).toHaveLength(4);
});

it("fails a draft request whose digest kept no highlight after the source check, and says why", async () => {
  ctx.db.update(schema.candidates).set({ evidence: { repo: "a/b", repoUrl: "https://github.com/a/b", releaseNotes: "Fixes CRLF positions." } }).run();
  const { jobs } = await (await request(`/api/candidates/${cid}/redraft`, params)).json();
  vi.mocked(runLlm).mockResolvedValue(output({ highlights: ["Parsing is now 3x faster."], limitations: [] }));
  await processServerJob(ctx);
  expect(row(jobs[0])).toMatchObject({ status: "failed", error: expect.stringContaining("확인되지 않은 숫자") });
  expect(ctx.db.select().from(schema.llmJobs).all()).toHaveLength(1);
});


it.each([undefined, 1])("introduces a service without change highlights (digest timestamp %s)", async (highlightsAt) => {
  ctx.db.update(schema.candidates).set({ evidence: { repo: "a/b", repoUrl: "https://github.com/a/b", readmeExcerpt: "A parser for source code.", highlights: [], highlightsAt } }).run();
  const response = await request(`/api/candidates/${cid}/redraft`, { ...params, introduction: true });
  expect(response.status).toBe(202);
  const jobs = pendingJobs(ctx, "local", "server");
  expect(jobs).toHaveLength(1);
  expect(jobs[0].kind).toBe("draft");
  expect(jobs[0].user).toContain("## First introduction");
  expect(jobs[0].user).toContain("A parser for source code.");
  await processServerJob(ctx);
  expect(ctx.db.select().from(schema.drafts).all()).toHaveLength(1);
});

it("preserves the previous draft when introducing a service again", async () => {
  await request(`/api/candidates/${cid}/redraft`, params);
  await processServerJob(ctx);
  const first = ctx.db.select().from(schema.drafts).get()!;
  const response = await request(`/api/candidates/${cid}/redraft`, { ...params, introduction: true });
  expect(response.status).toBe(202);
  await processServerJob(ctx);
  const drafts = ctx.db.select().from(schema.drafts).all();
  expect(drafts).toHaveLength(2);
  expect(drafts.find((item) => item.id === first.id)).toEqual(first);
  expect(drafts.map((item) => item.version).sort()).toEqual([1, 2]);
});

it.each([undefined, 1])("keeps introduction purpose when rewriting without changes (%s)", async (highlightsAt) => {
  ctx.db.update(schema.candidates).set({ evidence: { repo: "a/b", repoUrl: "https://github.com/a/b", description: "A parser", highlights: [], highlightsAt } }).run();
  await request(`/api/candidates/${cid}/redraft`, { ...params, introduction: true });
  await processServerJob(ctx);
  expect(ctx.db.select().from(schema.drafts).get()?.purpose).toBe("introduction");
  // A publication elsewhere must not change this draft's purpose.
  ctx.db.insert(schema.publications).values({ ownerId: "local", candidateId: cid, channel: "linkedin", url: "https://example.test/post", publishedAt: 1 }).run();
  const response = await request(`/api/candidates/${cid}/redraft`, { ...params, instruction: "Shorter" });
  expect(response.status).toBe(202);
  const job = row((await response.json()).jobs[0]);
  expect(job.kind).toBe("draft");
  expect(job.meta?.draftPurpose).toBe("introduction");
  expect(job.user).toContain("## First introduction");
  expect(job.user).toContain("Previous version");
  await processServerJob(ctx);
  expect(ctx.db.select().from(schema.drafts).all().map((d) => d.purpose)).toEqual(["introduction", "introduction"]);
});

it("keeps purpose on failure retry and completes a draft after another channel is published", async () => {
  await request(`/api/candidates/${cid}/redraft`, { ...params, introduction: true });
  vi.mocked(runLlm).mockRejectedValueOnce(new Error("offline"));
  await processServerJob(ctx);
  const failed = ctx.db.select().from(schema.llmJobs).get()!;
  ctx.db.update(schema.candidates).set({ status: "published" }).run();
  const retry = await request(`/api/jobs/${failed.id}/retry`);
  expect(retry.status).toBe(202);
  const id = (await retry.json()).jobs[0];
  expect(row(id).meta?.draftPurpose).toBe("introduction");
  await processServerJob(ctx);
  expect(row(id).status).toBe("done");
  expect(ctx.db.select().from(schema.drafts).get()?.purpose).toBe("introduction");
  expect(ctx.db.select().from(schema.candidates).get()?.status).toBe("published");
});

it.each(["gemini", "local-agent"] as const)("generates another channel of a published candidate with %s", async (provider) => {
  updateSettings(ctx, "local", { llm: { provider } });
  ctx.db.update(schema.candidates).set({ status: "published" }).run();
  const response = await request(`/api/candidates/${cid}/redraft`, { targets: [{ channel: "linkedin", lang: "ko" }], introduction: true });
  expect(response.status).toBe(202);
  const id = (await response.json()).jobs[0];
  if (provider === "local-agent") {
    const claim = claimJob(ctx, "local", id, "cli");
    expect(completeJob(ctx, "local", id, { claimToken: claim.claimToken!, resultJson: JSON.stringify(draft) }).applied).toBe(true);
  } else await processServerJob(ctx);
  expect(row(id).status).toBe("done");
  expect(ctx.db.select().from(schema.candidates).get()?.status).toBe("published");
});

it("allows the requested digest and update draft after publication, without automatic judging", async () => {
  ctx.db.update(schema.candidates).set({ status: "published", evidence: { repo: "a/b", repoUrl: "https://github.com/a/b", releaseNotes: "Adds watch mode." } }).run();
  const response = await request(`/api/candidates/${cid}/redraft`, { ...params, introduction: false });
  expect(response.status).toBe(202);
  vi.mocked(runLlm).mockResolvedValueOnce(output({ highlights: ["Adds watch mode."], limitations: [] }));
  await processServerJob(ctx);
  await processServerJob(ctx);
  expect(ctx.db.select().from(schema.drafts).get()?.purpose).toBe("update");
  expect(ctx.db.select().from(schema.candidates).get()?.status).toBe("published");
  expect(ctx.db.select().from(schema.judgments).all()).toHaveLength(0);
});
