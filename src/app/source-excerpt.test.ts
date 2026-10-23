import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { homepageText } from "../infra/homepage.js";
import { openDb, schema } from "../infra/db/index.js";
import { runLlm, type LlmResult } from "../infra/llm/providers.js";
import { DIGEST_REVISION } from "../core/prompts.js";
import type { AppContext } from "./context.js";
import { applyResult, buildPrompt, enqueueJob } from "./pipeline.js";
import { claimJob, completeJob, pendingJobs, pruneFinishedJobs, retryGeneration } from "./jobs.js";
import { readJobDraft, checkLocalResult } from "./draft-repair.js";
import { processServerJob } from "./generation-worker.js";
import { saveDraftEdit } from "./review.js";
import { updateSettings } from "./settings.js";
import { toDraft } from "./candidates.js";

vi.mock("../infra/llm/providers.js", async original => ({ ...await original<typeof import("../infra/llm/providers.js")>(), runLlm: vi.fn() }));
let ctx: AppContext, cid: number;
const url = "https://example.com/cedar";
const source = homepageText('<html lang="ko"><head><meta property="og:site_name" content="Cedar"></head><body><main><section><div><h1>기록을 모으고<br>다음 작업으로.</h1><p>프로젝트의 기록과 작업을 한곳에서 관리하세요.</p></div><div><h2>기록에서 바로 작업</h2><p>선택한 기록을 작업 목록으로 옮기고 원문을 다시 여세요.</p></div></section></main></body></html>')!;
const output = (body: string): LlmResult => ({ json: { title: "", body }, provider: "gemini", model: "gemini-3.5-flash-lite", latencyMs: 1 });
function prompt() { return buildPrompt(ctx, "me", "draft", cid, "x", "ko", { introduction: true }); }
function allowed() { return (prompt().schema.properties as { body: { enum: string[] } }).body.enum; }
function enqueue() { return enqueueJob(ctx, "me", "draft", cid, "x", "ko", prompt()); }
beforeEach(() => {
  ctx = { db: openDb(":memory:"), env: {}, bus: new EventEmitter(), log: pino({ level: "silent" }), usage: { record: vi.fn() } as unknown as AppContext["usage"] };
  updateSettings(ctx, "me", { voice: { preset: "plain", guide: "", useExamples: false }, llm: { provider: "local-agent" } });
  cid = Number(ctx.db.insert(schema.candidates).values({ ownerId: "me", repo: "me/Cedar", title: "Cedar", type: "new-repo", key: "source-copy", evidence: { repo: "me/Cedar", repoUrl: "https://github.com/me/Cedar", homepage: url, homepageSource: { url, status: "ok", collectedAt: 1, ...source }, highlights: ["프로젝트 기록을 작업으로 옮깁니다."], highlightsAt: 1, digestRevision: DIGEST_REVISION }, status: "judged", createdAt: 1, updatedAt: 1 }).run().lastInsertRowid);
});
afterEach(() => { ctx.db.$client.close(); vi.useRealTimers(); vi.resetAllMocks(); });

it("uses collected whole source units and keeps the same bytes through local check, completion and DTO", () => {
  const body = allowed()[0];
  expect(body).toContain("기록을 모으고\n다음 작업으로.");
  expect(body).toContain("선택한 기록을 작업 목록으로 옮기고 원문을 다시 여세요.");
  const id = enqueue(), job = pendingJobs(ctx, "me")[0];
  expect(job.sourceExcerpt).toEqual({ url });
  expect(readJobDraft(job, { body })).toEqual({ body });
  const claimToken = claimJob(ctx, "me", id, "test").claimToken!;
  expect(checkLocalResult(ctx, "me", id, { claimToken, resultJson: JSON.stringify({ body }) }).issues).toEqual([]);
  expect(completeJob(ctx, "me", id, { claimToken, resultJson: JSON.stringify({ body }) })).toEqual({ applied: true });
  const saved = toDraft(ctx.db.select().from(schema.drafts).get()!);
  expect(saved).toMatchObject({ body, sourceExcerpt: { url }, purpose: "introduction" });
  expect(saved.lint.filter(issue => !issue.ok)).toEqual([]);
});

it.each(["invented content", "prefix", "suffix"])("rejects an out-of-enum %s before storage without trimming it into membership", variation => {
  const body = allowed()[0];
  const invalid = variation === "prefix" ? ` ${body}` : variation === "suffix" ? `${body}\n` : variation;
  const id = enqueue(), claimToken = claimJob(ctx, "me", id, "test").claimToken!;
  expect(() => checkLocalResult(ctx, "me", id, { claimToken, resultJson: JSON.stringify({ body: invalid }) })).toThrow("exactly match");
  expect(completeJob(ctx, "me", id, { claimToken, resultJson: JSON.stringify({ body: invalid }) })).toEqual({ applied: false });
  expect(ctx.db.select().from(schema.drafts).all()).toEqual([]);
  expect(() => applyResult(ctx, "me", { kind: "draft", candidateId: cid, channel: "x", lang: "ko", result: { body: invalid }, model: "test", draftPurpose: "introduction", sourceExcerpt: { url }, schemaJson: JSON.stringify(prompt().schema) })).toThrow("exactly match");
});

it("keeps frozen source schema and provenance on failed retries, prunes completed source text, and never auto-learns source copy", () => {
  vi.useFakeTimers();
  const id = enqueue();
  completeJob(ctx, "me", id, { claimToken: claimJob(ctx, "me", id, "test").claimToken!, error: "failed" });
  const next = retryGeneration(ctx, "me", id), job = pendingJobs(ctx, "me")[0];
  expect(job.sourceExcerpt).toEqual({ url });
  expect(job.schemaJson).toBe(ctx.db.select().from(schema.llmJobs).where(eq(schema.llmJobs.id, id)).get()!.schemaJson);
  const body = allowed()[0];
  completeJob(ctx, "me", next, { claimToken: claimJob(ctx, "me", next, "test").claimToken!, resultJson: JSON.stringify({ body }) });
  const saved = ctx.db.select().from(schema.drafts).get()!;
  expect(saveDraftEdit(ctx, "me", saved.id, { body, markCopied: true })).toMatchObject({ status: "copied", sourceExcerpt: { url } });
  expect(ctx.db.select().from(schema.examples).all()).toEqual([]);
  const edited = saveDraftEdit(ctx, "me", saved.id, { body: body + "\n메모", markCopied: false });
  expect(edited.sourceExcerpt).toEqual({ url });
  vi.advanceTimersByTime(15 * 86_400_000);
  expect(pruneFinishedJobs(ctx)).toBe(1);
  expect(ctx.db.select().from(schema.llmJobs).where(eq(schema.llmJobs.id, next)).get()).toMatchObject({ schemaJson: "{}", user: "", meta: { draftPurpose: "introduction" } });
  expect(ctx.db.select().from(schema.llmJobs).where(eq(schema.llmJobs.id, id)).get()!.meta?.sourceExcerpt).toEqual({ url });
});

it.each(["instruction", "voice", "examples", "update", "language", "unusable source", "mismatched source URL", "missing homepage"])("preserves ordinary writing for %s", variation => {
  if (variation === "voice") updateSettings(ctx, "me", { voice: { preset: "plain", guide: "저의 경험으로 쓰세요", useExamples: false } });
  if (variation === "examples") updateSettings(ctx, "me", { voice: { preset: "plain", guide: "", useExamples: true } });
  if (variation === "unusable source") {
    const row = ctx.db.select().from(schema.candidates).get()!;
    ctx.db.update(schema.candidates).set({ evidence: { ...row.evidence, homepageSource: { ...row.evidence.homepageSource!, copyUnits: undefined } } }).run();
  }
  if (variation === "mismatched source URL" || variation === "missing homepage") {
    const row = ctx.db.select().from(schema.candidates).get()!;
    ctx.db.update(schema.candidates).set({ evidence: { ...row.evidence, homepage: variation === "missing homepage" ? undefined : "https://example.com/different" } }).run();
  }
  const p = buildPrompt(ctx, "me", "draft", cid, "x", variation === "language" ? "en" : "ko", { introduction: variation !== "update", instruction: variation === "instruction" ? "파일만 설명하세요" : undefined });
  expect(p.sourceExcerpt).toBeUndefined();
  expect((p.schema.properties as { body: { enum?: unknown } }).body.enum).toBeUndefined();
});

it("stores an unchanged source selection through the server worker with the same schema", async () => {
  updateSettings(ctx, "me", { llm: { provider: "gemini" } });
  const body = allowed()[0];
  vi.mocked(runLlm).mockResolvedValue(output(body));
  enqueue();
  expect(await processServerJob(ctx)).toBe(true);
  expect(runLlm).toHaveBeenCalledOnce();
  expect(vi.mocked(runLlm).mock.calls[0][1].schema).toEqual(prompt().schema);
  expect(ctx.db.select().from(schema.drafts).get()).toMatchObject({ body, sourceExcerpt: { url } });
});
