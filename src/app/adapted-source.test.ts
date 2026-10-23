import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { homepageText } from "../infra/homepage.js";
import { openDb, schema } from "../infra/db/index.js";
import { runLlm, type LlmResult } from "../infra/llm/providers.js";
import type { AppContext } from "./context.js";
import { adaptedSourcePrompt, readSourceExcerptResult } from "./source-excerpt.js";
import { buildPrompt, enqueueJob } from "./pipeline.js";
import { claimJob, completeJob, JOB_LEASE_MS, pendingJobs, retryGeneration } from "./jobs.js";
import { checkLocalResult, readJobDraft } from "./draft-repair.js";
import { processServerJob } from "./generation-worker.js";
import { updateSettings } from "./settings.js";
import { toDraft } from "./candidates.js";

vi.mock("../infra/llm/providers.js", async original => ({ ...await original<typeof import("../infra/llm/providers.js")>(), runLlm: vi.fn() }));
const url = "https://example.com/cedar";
const sources = [
  `Cedar\n기록 정리\n기록을 작업 목록으로 옮기고 원문을 다시 여세요.\n\n${url}`,
  `Cedar\n파일 내보내기\n기록을 CSV 파일로 내보내세요.\n\n${url}`,
];
const prose = `Cedar에서 기록을 작업 목록으로 옮기고 원문을 다시 열어요.\n${url}`;
const alternative = `Cedar에서 기록을 CSV 파일로 내보내요.\n${url}`;
let ctx: AppContext, cid: number;
const json = (body = prose, sourceBody = sources[0]) => ({ title: "", sourceBody, body });
const output = (body = prose, sourceBody = sources[0]): LlmResult => ({ json: json(body, sourceBody), provider: "gemini", model: "gemini-3.5-flash-lite", latencyMs: 1 });
function prompt() { return adaptedSourcePrompt(buildPrompt(ctx, "me", "draft", cid, "x", "ko", { introduction: true }), sources, url, "Cedar"); }
function enqueue() { return enqueueJob(ctx, "me", "draft", cid, "x", "ko", prompt()); }
function row(id: number) { return ctx.db.select().from(schema.llmJobs).where(eq(schema.llmJobs.id, id)).get()!; }
function check(id: number, claimToken: string, result: unknown) { return checkLocalResult(ctx, "me", id, { claimToken, resultJson: JSON.stringify(result) }); }
beforeEach(() => {
  ctx = { db: openDb(":memory:"), env: {}, bus: new EventEmitter(), log: pino({ level: "silent" }), usage: { record: vi.fn() } as unknown as AppContext["usage"] };
  updateSettings(ctx, "me", { voice: { preset: "plain", guide: "", useExamples: false }, llm: { provider: "local-agent" } });
  cid = Number(ctx.db.insert(schema.candidates).values({ ownerId: "me", repo: "me/Cedar", title: "Cedar", type: "new-repo", key: "adapted-source", evidence: { repo: "me/Cedar", repoUrl: "https://github.com/me/Cedar", homepage: url, readmeForChecks: sources.join("\n\n"), readmeTruncated: false }, status: "judged", createdAt: 1, updatedAt: 1 }).run().lastInsertRowid);
});
afterEach(() => { ctx.db.$client.close(); vi.useRealTimers(); vi.resetAllMocks(); });

it("accepts new prose with an exact selected source and stores the selected evidence through normal local completion", () => {
  const id = enqueue(), job = pendingJobs(ctx, "me")[0];
  expect(job.sourceExcerpt).toEqual({ url, adapted: true });
  expect(readJobDraft(job, json())).toEqual({ body: prose, sourceBody: sources[0] });
  expect(prose).not.toBe(sources[0]);
  const claimToken = claimJob(ctx, "me", id, "local").claimToken!;
  expect(check(id, claimToken, json()).issues).toEqual([]);
  expect(row(id).meta?.sourceExcerpt).toEqual({ url, adapted: true, sourceBody: sources[0] });
  expect(completeJob(ctx, "me", id, { claimToken, resultJson: JSON.stringify(json()) })).toEqual({ applied: true });
  expect(toDraft(ctx.db.select().from(schema.drafts).get()!)).toMatchObject({ body: prose, sourceExcerpt: { url, adapted: true, sourceBody: sources[0] } });
});

it.each([undefined, "unknown source", ` ${sources[0]}`, `${sources[0]}\n`])("rejects missing or altered source wording before local pinning and storage: %s", sourceBody => {
  const id = enqueue(), claimToken = claimJob(ctx, "me", id, "local").claimToken!;
  const result = { title: "", body: prose, sourceBody };
  expect(() => check(id, claimToken, result)).toThrow("preserve its permitted source");
  expect(row(id).meta?.sourceExcerpt?.sourceBody).toBeUndefined();
  expect(completeJob(ctx, "me", id, { claimToken, resultJson: JSON.stringify(result) })).toEqual({ applied: false });
  expect(ctx.db.select().from(schema.drafts).all()).toEqual([]);
});

it("does not let a later check or completion switch to another otherwise allowed source", () => {
  const id = enqueue(), claimToken = claimJob(ctx, "me", id, "local").claimToken!;
  check(id, claimToken, json());
  expect(() => check(id, claimToken, json(alternative, sources[1]))).toThrow("preserve its permitted source");
  expect(row(id).meta?.sourceExcerpt?.sourceBody).toBe(sources[0]);
  expect(completeJob(ctx, "me", id, { claimToken, resultJson: JSON.stringify(json(alternative, sources[1])) })).toEqual({ applied: false });
  expect(ctx.db.select().from(schema.drafts).all()).toEqual([]);
});

it.each(["wrong claim", "expired lease"])("does not pin a source for an invalid local lease: %s", variation => {
  const id = enqueue(), claimToken = claimJob(ctx, "me", id, "local").claimToken!;
  if (variation === "expired lease") ctx.db.update(schema.llmJobs).set({ claimedAt: Date.now() - JOB_LEASE_MS - 1 }).where(eq(schema.llmJobs.id, id)).run();
  expect(check(id, variation === "wrong claim" ? "invalid-claim" : claimToken, json())).toEqual({ issues: [] });
  expect(row(id).meta?.sourceExcerpt).toEqual({ url, adapted: true });
});

it("does not pin an invalid empty result and permits a corrected first valid selection", () => {
  const id = enqueue(), claimToken = claimJob(ctx, "me", id, "local").claimToken!;
  expect(() => check(id, claimToken, json("   "))).toThrow("empty draft body");
  expect(row(id).meta?.sourceExcerpt?.sourceBody).toBeUndefined();
  check(id, claimToken, json(alternative, sources[1]));
  expect(row(id).meta?.sourceExcerpt?.sourceBody).toBe(sources[1]);
});

it("retains a pinned source and schema when retrying a failed adapted job", () => {
  const id = enqueue(), claimToken = claimJob(ctx, "me", id, "local").claimToken!;
  check(id, claimToken, json());
  completeJob(ctx, "me", id, { claimToken, error: "failed after checking" });
  const retried = retryGeneration(ctx, "me", id), job = pendingJobs(ctx, "me").find(candidate => candidate.id === retried)!;
  expect(job.sourceExcerpt).toEqual({ url, adapted: true, sourceBody: sources[0] });
  expect(job.schemaJson).toBe(row(id).schemaJson);
  expect(() => readJobDraft(job, json(alternative, sources[1]))).toThrow("preserve its permitted source");
});

it("stores a valid first server result with adapted provenance without a local check", async () => {
  updateSettings(ctx, "me", { llm: { provider: "gemini" } });
  vi.mocked(runLlm).mockResolvedValue(output());
  const id = enqueue();
  expect(await processServerJob(ctx)).toBe(true);
  expect(row(id).status).toBe("done");
  expect(runLlm).toHaveBeenCalledOnce();
  expect(ctx.db.select().from(schema.drafts).get()).toMatchObject({ body: prose, sourceExcerpt: { url, adapted: true, sourceBody: sources[0] } });
});

it("rejects a server repair that changes the selected source, retaining the first result", async () => {
  updateSettings(ctx, "me", { llm: { provider: "gemini" } });
  const tooLong = `${"Cedar에서 기록을 작업 목록으로 옮겨요. ".repeat(15)}\n${url}`;
  vi.mocked(runLlm).mockResolvedValueOnce(output(tooLong)).mockResolvedValueOnce(output(alternative, sources[1]));
  const id = enqueue();
  expect(await processServerJob(ctx)).toBe(true);
  expect(runLlm).toHaveBeenCalledTimes(2);
  expect(row(id).status).toBe("done");
  const saved = ctx.db.select().from(schema.drafts).get()!;
  expect(saved.body).toBe(tooLong);
  expect(saved.sourceExcerpt).toEqual({ url, adapted: true, sourceBody: sources[0] });
  expect(saved.lint.find(issue => issue.rule === "length")?.ok).toBe(false);
  expect(vi.mocked(runLlm).mock.calls[1][1].schema).toEqual(vi.mocked(runLlm).mock.calls[0][1].schema);
});

it("accepts a shorter server repair of the same selected source", async () => {
  updateSettings(ctx, "me", { llm: { provider: "gemini" } });
  vi.mocked(runLlm).mockResolvedValueOnce(output(`${"Cedar에서 기록을 작업 목록으로 옮겨요. ".repeat(15)}\n${url}`)).mockResolvedValueOnce(output());
  enqueue();
  expect(await processServerJob(ctx)).toBe(true);
  expect(runLlm).toHaveBeenCalledTimes(2);
  expect(ctx.db.select().from(schema.drafts).get()).toMatchObject({ body: prose, sourceExcerpt: { url, adapted: true, sourceBody: sources[0] } });
});

it("does not treat a permitted source selection as semantic approval of rewritten claims", () => {
  const fictionalClaim = `Cedar는 없는 기능도 해요. ${url}`;
  expect(readSourceExcerptResult(json(fictionalClaim), { url, adapted: true }, JSON.stringify(prompt().schema))).toEqual({ body: fictionalClaim, sourceBody: sources[0] });
});

it("uses collected homepage units for the ordinary default buildPrompt adapted path", () => {
  const collected = homepageText('<html lang="ko"><head><meta property="og:site_name" content="Cedar"></head><body><main><section><div><h2>기록에서 다음 작업으로</h2><p>기록과 작업을 한곳에서 관리하세요.</p></div><article><h3>기록에서 작업으로</h3><p>기록을 작업 목록으로 옮기고 원문을 다시 여세요.</p></article></section></main></body></html>')!;
  const candidate = ctx.db.select().from(schema.candidates).where(eq(schema.candidates.id, cid)).get()!;
  ctx.db.update(schema.candidates).set({ evidence: { ...candidate.evidence, homepageSource: { url, status: "ok", collectedAt: 1, ...collected } } }).where(eq(schema.candidates.id, cid)).run();
  const base = buildPrompt(ctx, "me", "draft", cid, "x", "ko", { introduction: true });
  expect(base.sourceExcerpt).toEqual({ url, adapted: true });
  const properties = base.schema.properties as { sourceBody: { enum: string[] }; body: { type: string; enum?: string[] } };
  expect(properties.sourceBody.enum.length).toBeGreaterThan(0);
  expect(properties.sourceBody.enum[0]).toContain("기록을 작업 목록으로 옮기고 원문을 다시 여세요.");
  expect(properties.body.type).toBe("string");
  expect(properties.body.enum).toBeUndefined();
  const result = json(prose, properties.sourceBody.enum[0]);
  expect(readSourceExcerptResult(result, base.sourceExcerpt!, JSON.stringify(base.schema))).toEqual({ body: prose, sourceBody: properties.sourceBody.enum[0] });
  const id = enqueueJob(ctx, "me", "draft", cid, "x", "ko", base);
  const claimToken = claimJob(ctx, "me", id, "local").claimToken!;
  expect(check(id, claimToken, result).issues).toEqual([]);
  expect(completeJob(ctx, "me", id, { claimToken, resultJson: JSON.stringify(result) })).toEqual({ applied: true });
  expect(ctx.db.select().from(schema.drafts).get()).toMatchObject({ body: prose, sourceExcerpt: { url, adapted: true, sourceBody: result.sourceBody } });
});
