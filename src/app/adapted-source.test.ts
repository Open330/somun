import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { homepageText } from "../infra/homepage.js";
import { openDb, schema } from "../infra/db/index.js";
import { runLlm, type LlmResult } from "../infra/llm/providers.js";
import type { AppContext } from "./context.js";
import { adaptedSourcePrompt, readSourceExcerptResult, sourceNotationIssues, adaptedSourceIssues } from "./source-excerpt.js";
import { buildPrompt, enqueueJob } from "./pipeline.js";
import { claimJob, completeJob, JOB_LEASE_MS, pendingJobs, retryGeneration } from "./jobs.js";
import { checkLocalResult, readJobDraft } from "./draft-repair.js";
import { processServerJob } from "./generation-worker.js";
import { updateSettings } from "./settings.js";
import { toDraft } from "./candidates.js";
import { saveDraftEdit } from "./review.js";
import { postLength } from "../core/post-length.js";
import { sourceCopyBodies } from "../core/source-copy.js";
import { draftPurposeOf } from "../core/prompts.js";

vi.mock("../infra/llm/providers.js", async original => ({ ...await original<typeof import("../infra/llm/providers.js")>(), runLlm: vi.fn() }));
const url = "https://example.com/cedar";
const sources = [
  `Cedar\n기록 정리\n기록을 작업 목록으로 옮기고 원문을 다시 여세요.\n\n${url}`,
  `Cedar\n파일 내보내기\n기록을 CSV 파일로 내보내세요.\n\n${url}`,
];
const prose = `Cedar에서 기록을 작업 목록으로 옮기고 원문을 다시 열어요.\n${url}`;
const alternative = `Cedar에서 기록을 CSV 파일로 내보내요.\n${url}`;
let ctx: AppContext, cid: number;
const json = (body = prose, sourceBody = sources[0]) => ({ title: "", sourceBody, body, taskExcerpt: "" });
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
  const editing = check(id, claimToken, json());
  expect(editing.issues.map(issue => issue.rule)).toEqual(["introduction_edit"]);
  expect(editing.repairUser).toContain(prose);
  expect(editing.repairUser).not.toContain("## Source choices");
  expect(editing.repairSystem).not.toContain("Sift");
  expect(JSON.parse(editing.repairSchemaJson!).properties.sourceBody.enum).toEqual([sources[0]]);
  expect(JSON.parse(row(id).schemaJson).properties.sourceBody.enum).toEqual(sources);
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

it("edits a valid server introduction once with only its pinned source", async () => {
  updateSettings(ctx, "me", { llm: { provider: "gemini" } });
  vi.mocked(runLlm).mockResolvedValue(output());
  const id = enqueue();
  expect(await processServerJob(ctx)).toBe(true);
  expect(row(id).status).toBe("done");
  expect(runLlm).toHaveBeenCalledTimes(2);
  const editing = vi.mocked(runLlm).mock.calls[1][1];
  expect(editing.user).toContain(prose);
  expect(editing.user).not.toContain("## Source choices");
  expect(editing.system).not.toContain("Sift");
  expect((editing.schema.properties as { sourceBody: { enum: string[] } }).sourceBody.enum).toEqual([sources[0]]);
  expect(JSON.parse(row(id).schemaJson).properties.sourceBody.enum).toEqual(sources);
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
  expect((vi.mocked(runLlm).mock.calls[1][1].schema.properties as { sourceBody: { enum: string[] } }).sourceBody.enum).toEqual([sources[0]]);
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
  expect(draftPurposeOf(undefined, base.user)).toBe("introduction");
  const properties = base.schema.properties as { sourceBody: { enum: string[] }; body: { type: string; enum?: string[] } };
  expect(properties.sourceBody.enum.length).toBeGreaterThan(0);
  expect(properties.sourceBody.enum[0]).toContain("기록을 작업 목록으로 옮기고 원문을 다시 여세요.");
  expect(properties.body.type).toBe("string");
  expect(properties.body.enum).toBeUndefined();
  const result = json(prose, properties.sourceBody.enum[0]);
  expect(readSourceExcerptResult(result, base.sourceExcerpt!, JSON.stringify(base.schema))).toEqual({ body: prose, sourceBody: properties.sourceBody.enum[0] });
  const id = enqueueJob(ctx, "me", "draft", cid, "x", "ko", base);
  const claimToken = claimJob(ctx, "me", id, "local").claimToken!;
  expect(check(id, claimToken, result).issues.map(issue => issue.rule)).toEqual(["introduction_edit"]);
  expect(completeJob(ctx, "me", id, { claimToken, resultJson: JSON.stringify(result) })).toEqual({ applied: true });
  expect(ctx.db.select().from(schema.drafts).get()).toMatchObject({ body: prose, sourceExcerpt: { url, adapted: true, sourceBody: result.sourceBody } });
});

it("retains a complete long task source while enforcing the final X post budget", async () => {
  const paragraph = "기록을 작업 목록으로 옮기고 원문을 다시 여세요. 작업에 붙일 기록을 선택하면 원래 작성 시각과 문서 위치가 함께 남습니다. 목록에서 기록을 열면 문서의 해당 위치로 돌아가고, 문서에 남긴 메모를 보며 다음 작업을 정할 수 있습니다. 다른 문서에 있는 기록도 같은 목록에 모을 수 있으며, 기록을 옮겨도 원래 문서는 바뀌지 않습니다. 문서에 접근할 권한이 있는 사용자만 원문을 다시 열 수 있습니다.";
  const collected = homepageText(`<html lang="ko"><head><meta property="og:site_name" content="Cedar"></head><body><main><article><h2>기록에서 작업으로</h2><p>${paragraph}</p></article></main></body></html>`)!;
  const candidate = ctx.db.select().from(schema.candidates).where(eq(schema.candidates.id, cid)).get()!;
  ctx.db.update(schema.candidates).set({ evidence: { ...candidate.evidence, homepageSource: { url, status: "ok", collectedAt: 1, ...collected } } }).where(eq(schema.candidates.id, cid)).run();
  const base = buildPrompt(ctx, "me", "draft", cid, "x", "ko", { introduction: true });
  expect(base.sourceExcerpt?.adapted).toBe(true);
  const choices = (base.schema.properties as { sourceBody: { enum: string[] } }).sourceBody.enum;
  const selected = choices.find(body => body.includes(paragraph))!;
  expect(selected).toBeDefined();
  expect(sourceCopyBodies({ url, status: "ok", collectedAt: 1, ...collected }, "Cedar", url, "ko")).toEqual([]);
  expect(postLength("x", selected)).toBeGreaterThan(280);
  expect(selected).toContain("문서에 접근할 권한이 있는 사용자만 원문을 다시 열 수 있습니다.");
  updateSettings(ctx, "me", { llm: { provider: "gemini" } });
  const body = `Cedar에서 기록을 작업 목록에 모으고 문서의 원래 위치를 다시 열어요. 문서에 접근할 권한이 있는 사용자만 원문을 열 수 있어요.\n${url}`;
  vi.mocked(runLlm).mockResolvedValue(output(body, selected));
  enqueueJob(ctx, "me", "draft", cid, "x", "ko", base);
  expect(await processServerJob(ctx)).toBe(true);
  const saved = ctx.db.select().from(schema.drafts).get()!;
  expect(saved.body).toBe(body);
  expect(saved.sourceExcerpt?.sourceBody).toBe(selected);
  expect(saved.lint.find(issue => issue.rule === "length")?.ok).toBe(true);
  vi.mocked(runLlm).mockResolvedValue(output(selected, selected));
  enqueueJob(ctx, "me", "draft", cid, "x", "ko", base);
  expect(await processServerJob(ctx)).toBe(true);
  const oversized = ctx.db.select().from(schema.drafts).all().at(-1)!;
  expect(oversized.sourceExcerpt?.sourceBody).toBe(selected);
  expect(postLength("x", oversized.body)).toBeGreaterThan(280);
  expect(oversized.lint.find(issue => issue.rule === "length")?.ok).toBe(false);
});

it("keeps the first valid introduction if editing fails or adds a length violation", async () => {
  updateSettings(ctx, "me", { llm: { provider: "gemini" } });
  vi.mocked(runLlm).mockResolvedValueOnce(output()).mockRejectedValueOnce(new Error("editor unavailable"));
  enqueue();
  expect(await processServerJob(ctx)).toBe(true);
  expect(runLlm).toHaveBeenCalledTimes(2);
  expect(ctx.db.select().from(schema.drafts).get()?.body).toBe(prose);
  vi.mocked(runLlm).mockClear().mockResolvedValueOnce(output()).mockResolvedValueOnce(output(`${prose} ${"기록을 정리해요. ".repeat(40)}`));
  enqueue();
  expect(await processServerJob(ctx)).toBe(true);
  expect(runLlm).toHaveBeenCalledTimes(2);
  expect(ctx.db.select().from(schema.drafts).all().at(-1)?.body).toBe(prose);
});

it("does not use editing completion to accept an unchanged or worse real violation", async () => {
  updateSettings(ctx, "me", { llm: { provider: "gemini" } });
  const tooLong = `${"Cedar에서 기록을 작업 목록으로 옮겨요. ".repeat(15)}\n${url}`;
  vi.mocked(runLlm).mockResolvedValueOnce(output(tooLong)).mockResolvedValueOnce(output(tooLong + " 기록을 보관해요."));
  enqueue();
  expect(await processServerJob(ctx)).toBe(true);
  expect(runLlm).toHaveBeenCalledTimes(2);
  expect(ctx.db.select().from(schema.drafts).get()?.body).toBe(tooLong);
});

it("narrows the first server request of a retried source-pinned job without changing its frozen schema", async () => {
  const id = enqueue(), claimToken = claimJob(ctx, "me", id, "local").claimToken!;
  check(id, claimToken, json());
  completeJob(ctx, "me", id, { claimToken, error: "failed after selecting" });
  updateSettings(ctx, "me", { llm: { provider: "gemini" } });
  const retried = retryGeneration(ctx, "me", id);
  vi.mocked(runLlm).mockResolvedValue(output());
  expect(await processServerJob(ctx)).toBe(true);
  expect((vi.mocked(runLlm).mock.calls[0][1].schema.properties as { sourceBody: { enum: string[] } }).sourceBody.enum).toEqual([sources[0]]);
  expect(JSON.parse(row(retried).schemaJson).properties.sourceBody.enum).toEqual(sources);
  expect(row(retried).status).toBe("done");
});

it.each(["SSH와 SFTP", "SSH나 SFTP", "SSH 또는 SFTP", "SFTP 및 SSH"])("flags an inferred relationship in source technical notation: %s", notation => {
  expect(sourceNotationIssues(`${notation}로 폴더를 열어요.`, "SSH/SFTP로 폴더를 여세요.")).toEqual([{ rule: "claims_need_review", ok: false, detail: expect.stringContaining("SSH/SFTP") }]);
});

it("leaves exact notation, individual protocol mentions, and URLs alone", () => {
  expect(sourceNotationIssues("SSH/SFTP로 폴더를 열어요.", "SSH/SFTP로 폴더를 여세요.")).toEqual([]);
  expect(sourceNotationIssues("SSH를 켜세요. 폴더는 SFTP로 열어요.", "SSH/SFTP로 폴더를 여세요.")).toEqual([]);
  expect(sourceNotationIssues("SSH나 SFTP로 접속해요.", "https://example.com/SSH/SFTP")).toEqual([]);
  expect(sourceNotationIssues("https://example.com/SSH와SFTP", "SSH/SFTP로 폴더를 여세요.")).toEqual([]);
});

it.each([true, false])("checks technical notation through repair and stored lint (fixed=%s)", async fixed => {
  updateSettings(ctx, "me", { llm: { provider: "gemini" } });
  const source = `Cedar\n원격 폴더\nSSH/SFTP로 폴더를 열고 파일을 복사하세요.\n\n${url}`;
  const bad = `Cedar에서 SSH나 SFTP로 폴더를 열고 파일을 복사해요.\n${url}`;
  const good = `Cedar에서 SSH/SFTP로 폴더를 열고 파일을 복사해요.\n${url}`;
  const base = adaptedSourcePrompt(prompt(), [source], url, "Cedar");
  vi.mocked(runLlm).mockResolvedValueOnce(output(bad, source)).mockResolvedValueOnce(output(fixed ? good : bad, source));
  enqueueJob(ctx, "me", "draft", cid, "x", "ko", base);
  expect(await processServerJob(ctx)).toBe(true);
  expect(runLlm).toHaveBeenCalledTimes(2);
  const saved = ctx.db.select().from(schema.drafts).get()!;
  expect(saved.body).toBe(fixed ? good : bad);
  expect(saved.lint.some(issue => !issue.ok && issue.detail?.includes("SSH/SFTP"))).toBe(!fixed);
  if (!fixed) {
    const held = saveDraftEdit(ctx, "me", saved.id, { body: bad, markCopied: true, copyIfClean: true });
    expect(held.copyHeld).toBe(true);
    expect(held.status).not.toBe("copied");
    expect(held.lint.some(issue => !issue.ok && issue.detail?.includes("SSH/SFTP"))).toBe(true);
    const corrected = saveDraftEdit(ctx, "me", saved.id, { body: good, markCopied: true, copyIfClean: true });
    expect(corrected.lint.some(issue => !issue.ok && issue.detail?.includes("SSH/SFTP"))).toBe(false);
    expect(corrected.copyHeld).toBeUndefined();
    expect(corrected.status).toBe("copied");
  }
});

it("enforces the adapted mode's explicit register without treating quotations as prose", () => {
  expect(adaptedSourceIssues("Cedar는 기록을 정리합니다.").map(issue => issue.rule)).toEqual(["register_mismatch"]);
  expect(adaptedSourceIssues("Cedar는 기록을 정리해요.")).toEqual([]);
  expect(adaptedSourceIssues("Cedar에 ‘작업을 완료했습니다.’라는 기록이 남아요.")).toEqual([]);
});

it("uses the existing narrow register preparation consistently for adapted local checking and completion", async () => {
  const formal = `Cedar에서 기록을 작업 목록으로 옮깁니다. 원문으로 돌아갈 수 있습니다.\n${url}`;
  const prepared = `Cedar에서 기록을 작업 목록으로 옮깁니다. 원문으로 돌아갈 수 있어요.\n${url}`;
  const id = enqueue(), job = pendingJobs(ctx, "me")[0];
  expect(readJobDraft(job, json(formal)).body).toBe(prepared);
  const claimToken = claimJob(ctx, "me", id, "local").claimToken!;
  expect(completeJob(ctx, "me", id, { claimToken, resultJson: JSON.stringify(json(formal)) })).toEqual({ applied: true });
  expect(ctx.db.select().from(schema.drafts).get()?.body).toBe(prepared);
  expect(ctx.db.select().from(schema.drafts).get()?.lint.some(issue => issue.rule === "register_mismatch" && !issue.ok)).toBe(true);
});

it("writes and edits one server introduction with its task quote and original source pinned", async () => {
  updateSettings(ctx, "me", { llm: { provider: "gemini" } });
  const sourcePrompt = adaptedSourcePrompt(prompt(), sources, url, "Cedar", { planTask: true });
  const taskExcerpt = "기록을 작업 목록으로 옮기고 원문을 다시 여세요.";
  const first = { ...output(), json: { ...json(), taskExcerpt } };
  const edited = `Cedar는 기록을 작업 목록으로 모으는 도구예요. 원문을 다시 열어 내용을 확인할 수 있어요.\n${url}`;
  const second = { ...output(edited), json: { ...json(edited), taskExcerpt } };
  vi.mocked(runLlm).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const id = enqueueJob(ctx, "me", "draft", cid, "x", "ko", sourcePrompt);
  expect(await processServerJob(ctx)).toBe(true);
  expect(runLlm).toHaveBeenCalledTimes(2);
  const editor = vi.mocked(runLlm).mock.calls[1][1];
  const properties = editor.schema.properties as { sourceBody: { enum: string[] } };
  expect(properties.sourceBody.enum).toEqual([sources[0]]);
  expect(editor.user.slice(editor.user.indexOf("## Selected source"))).not.toContain(sources[1]);
  expect(row(id).status).toBe("done");
  expect(ctx.db.select().from(schema.drafts).get()).toMatchObject({ body: edited, sourceExcerpt: { url, adapted: true, sourceBody: sources[0] } });
  expect(ctx.db.select().from(schema.draftEdits).all()).toEqual([]);
});

it("rejects an invented task quote without changing an existing draft", async () => {
  const firstId = enqueue(), claimToken = claimJob(ctx, "me", firstId, "local").claimToken!;
  completeJob(ctx, "me", firstId, { claimToken, resultJson: JSON.stringify(json()) });
  updateSettings(ctx, "me", { llm: { provider: "gemini" } });
  vi.mocked(runLlm).mockResolvedValueOnce({ ...output(), json: { ...json(), taskExcerpt: "invented task" } });
  const id = enqueueJob(ctx, "me", "draft", cid, "x", "ko", adaptedSourcePrompt(prompt(), sources, url, "Cedar", { planTask: true }));
  expect(await processServerJob(ctx)).toBe(true);
  expect(runLlm).toHaveBeenCalledTimes(1);
  expect(row(id).status).toBe("failed");
  expect(ctx.db.select().from(schema.drafts).all()).toMatchObject([{ body: prose }]);
});

it("holds imperative introductions while preserving quoted instructions and source wording", () => {
  expect(adaptedSourceIssues("Cedar에서 기록을 옮길 수 있어요.").map(issue => issue.rule)).toEqual([]);
  expect(adaptedSourceIssues("Cedar에서 작업을 추가하세요.").map(issue => issue.rule)).toEqual(["register_mismatch"]);
  expect(adaptedSourceIssues("‘추가하세요.’라고 표시해요.")).toEqual([]);
  expect(adaptedSourceIssues("> 추가하세요.\n`열어보세요.`\nCedar는 기록을 정리해요.")).toEqual([]);
});
