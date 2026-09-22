import { EventEmitter } from "node:events";
import pino from "pino";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDb, schema } from "../infra/db/index.js";
import { runLlm } from "../infra/llm/providers.js";
import type { AppContext } from "./context.js";
import { applyResult, runStep } from "./pipeline.js";
import { saveDraftEdit } from "./review.js";
import { updateSettings } from "./settings.js";

vi.mock("../infra/llm/providers.js", async (original) => ({ ...await original<typeof import("../infra/llm/providers.js")>(), runLlm: vi.fn() }));
let ctx: AppContext;
let id: number;
beforeEach(() => {
  ctx = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: { record: vi.fn() } as unknown as AppContext["usage"] };
  id = Number(ctx.db.insert(schema.candidates).values({ ownerId: "test", repo: "vitejs/vite", title: "Dependency maintenance", type: "release", key: "test", evidence: { repo: "vitejs/vite", repoUrl: "https://github.com/vitejs/vite", highlights: [], highlightsAt: 1 }, status: "judged", createdAt: 1, updatedAt: 1 }).run().lastInsertRowid);
});
afterEach(() => { ctx.db.$client.close(); vi.resetAllMocks(); });

it.each(["gemini", "local-agent"] as const)("does not spend calls or enqueue %s drafts when digest found no evidence", async (provider) => {
  updateSettings(ctx, "test", { llm: { provider } });
  const result = await runStep(ctx, "test", "draft", id, "x", "en");
  expect(result.error).toContain("변경 근거가 없습니다");
  expect(runLlm).not.toHaveBeenCalled();
  expect(ctx.db.select().from(schema.drafts).all()).toHaveLength(0);
  expect(ctx.db.select().from(schema.llmJobs).all()).toHaveLength(0);
});

it("still generates and stores a draft when the digest has concrete evidence", async () => {
  ctx.db.update(schema.candidates).set({ evidence: { repo: "vitejs/vite", repoUrl: "https://github.com/vitejs/vite", highlights: ["Handles CRLF code frame positions."], highlightsAt: 1 } }).run();
  vi.mocked(runLlm).mockResolvedValue({ json: { title: "", body: "vite v8.3.0 fixes CRLF code frame positions. https://github.com/vitejs/vite" }, provider: "gemini", model: "test", latencyMs: 1 });
  const result = await runStep(ctx, "test", "draft", id, "x", "en");
  expect(result.applied?.draftId).toBeTruthy();
  expect(ctx.db.select().from(schema.drafts).all()).toHaveLength(1);
  const request = vi.mocked(runLlm).mock.calls[0][1];
  expect(request.user).not.toContain("first person, past tense");
  expect(request.system).toContain("Factual grounding takes priority");
});

it("does not queue automatic drafts from an empty digest even when the model gives high scores", () => {
  updateSettings(ctx, "test", { llm: { provider: "local-agent" } });
  const result = applyResult(ctx, "test", { kind: "judge", candidateId: id, model: "test", result: { scores: { runnable: 2, numbers: 2, lesson: 2, novelty: 2, audience: 2 }, reasoning: "Publish it", suggestedChannels: ["x"] } }, true);
  expect(result.decision).toBe("ask");
  expect(ctx.db.select().from(schema.llmJobs).all()).toHaveLength(0);
  expect(ctx.db.select().from(schema.judgments).all()[0].reasoning).toContain("변경 근거");
});

it("keeps existing drafts in the review queue after a new judgment", () => {
  ctx.db.update(schema.candidates).set({ status: "drafted" }).run();
  applyResult(ctx, "test", { kind: "judge", candidateId: id, model: "test", result: { scores: {}, reasoning: "Needs evidence" } }, true);
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
