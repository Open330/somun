import { EventEmitter } from "node:events";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, schema } from "../infra/db/index.js";
import type { AppContext } from "./context.js";
import { applyResult, buildPrompt, processNewCandidates, queueStep, SWEEP_BACKOFF_MS, SWEEP_MAX_FAILURES } from "./pipeline.js";
import { GenerationConflictError } from "./context.js";
import { saveDraftEdit } from "./review.js";
import { updateSettings } from "./settings.js";

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
