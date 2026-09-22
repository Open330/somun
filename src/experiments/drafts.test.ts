import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { LlmError } from "../infra/llm/providers.js";
import { blindReview, casesSchema, compare, configSchema, evaluate, execute, hash, summarizeReviews, validatePlan, type Report } from "./drafts.js";

const cases = casesSchema.parse(JSON.parse(readFileSync("experiments/cases.json", "utf8")));
const config = configSchema.parse(JSON.parse(readFileSync("experiments/replay.json", "utf8")));
const fresh = (mode: Report["mode"] = "replay"): Report => ({ version: 1, name: "test", mode, datasetHash: hash(cases), evaluatorHash: "test", cases, expectedRows: 12, startedAt: "2026-09-22T00:00:00Z", revision: "test", dirty: false, results: [] });

it("detects deliberately bad outputs across all six channels without network calls", async () => {
  const report = fresh(), generate = vi.fn(), checkpoint = vi.fn();
  expect(validatePlan(config, cases, "replay", 0)).toBe(12);
  await execute(config, report, generate, checkpoint);
  expect(generate).not.toHaveBeenCalled(); expect(checkpoint).toHaveBeenCalledTimes(12);
  expect(report.results.filter((r) => r.variantId === "reference").every((r) => r.checks.every((c) => c.ok))).toBe(true);
  expect(report.results.filter((r) => r.variantId === "stress").every((r) => r.checks.some((c) => c.rule === "numbers_need_review" && !c.ok))).toBe(true);
});

it("rejects incomplete replay, duplicate IDs, false repeats, and excessive live budgets before execution", () => {
  expect(() => casesSchema.parse([...cases, cases[0]])).toThrow();
  expect(() => configSchema.parse({ ...config, variants: [config.variants[0], config.variants[0]] })).toThrow();
  expect(() => validatePlan({ ...config, variants: [{ id: "missing" }] }, cases, "replay", 0)).toThrow("Missing replay");
  expect(() => validatePlan({ ...config, repeats: 2 }, cases, "replay", 0)).toThrow("independent samples");
  expect(() => validatePlan(config, cases, "live", 1)).toThrow("12 generations");
  expect(() => validatePlan(config, cases, "live", 12)).toThrow("Explicit provider");
});

it("checkpoints failures and invalid outputs without leaking provider errors", async () => {
  const report = fresh("live");
  const generate = vi.fn().mockRejectedValueOnce(new LlmError("SECRET_KEY=private", 429, true))
    .mockResolvedValue({ json: { body: "missing title" }, model: "actual", provider: "gemini", latencyMs: 5 });
  const checkpoint = vi.fn();
  await execute(config, report, generate, checkpoint);
  expect(report.results).toHaveLength(12);
  expect(report.results[0].error).toBe("generation_failed");
  expect(report.results[0].httpStatus).toBe(429);
  expect(report.results[1].error).toBe("invalid_output");
  expect(report.results[1].actualModel).toBe("actual");
  expect(JSON.stringify(report)).not.toContain("SECRET_KEY");
  expect(checkpoint).toHaveBeenCalledTimes(12);
});

it("requires paired complete datasets and detects regressions and missing checks", async () => {
  const before = fresh(); await execute(config, before, vi.fn(), () => {});
  const after = structuredClone(before);
  expect(compare(before, after).regressions).toEqual([]);
  after.results[0].checks[0].ok = false;
  expect(compare(before, after).regressions.length).toBeGreaterThan(0);
  after.results[0].checks.pop();
  expect(compare(before, after).removedChecks.length).toBeGreaterThan(0);
  expect(() => compare(before, { ...after, datasetHash: "changed" })).toThrow("different datasets");
  after.results.pop(); expect(() => compare(before, after)).toThrow("incomplete or unpaired");
});

it("keeps unreviewed results separate and validates blinded human review IDs", async () => {
  const report = fresh(); await execute(config, report, vi.fn(), () => {});
  const exported = blindReview(report);
  expect(JSON.stringify(exported)).not.toContain('"variantId"');
  expect(JSON.stringify(exported)).not.toContain('"checks"');
  expect(summarizeReviews(report, exported).every((r) => r.reviewed === 0 && r.meanGrounding === null && r.meanEditSeconds === null)).toBe(true);
  const reviewed = JSON.parse(JSON.stringify(exported));
  reviewed[0].ratings = { grounding: 4, clarity: 3, voice: 4 }; reviewed[0].publishable = false; reviewed[0].editSeconds = 0;
  expect(summarizeReviews(report, reviewed).reduce((n, r) => n + r.reviewed, 0)).toBe(1);
  reviewed[0].ratings.grounding = 6; expect(() => summarizeReviews(report, reviewed)).toThrow();
  expect(() => summarizeReviews(report, exported.slice(1))).toThrow("IDs");
  const changed = structuredClone(exported); changed[0].draft!.body = "Changed output";
  expect(() => summarizeReviews(report, changed)).toThrow("changed");
});

it("preserves the historical failure cases instead of relabelling old model outputs as new generations", async () => {
  const historicalCases = casesSchema.parse(JSON.parse(readFileSync("experiments/historical-cases.json", "utf8")));
  const historical = configSchema.parse(JSON.parse(readFileSync("experiments/historical.json", "utf8")));
  const report = { ...fresh(), cases: historicalCases, expectedRows: 4 };
  await execute(historical, report, vi.fn(), () => {});
  expect(report.results.filter((r) => r.variantId === "before").every((r) => r.checks.some((c) => !c.ok))).toBe(true);
  expect(report.results.filter((r) => r.variantId === "after").every((r) => r.checks.every((c) => c.ok))).toBe(true);
  expect(report.results.every((r) => r.actualModel === undefined && r.elapsedMs === 0)).toBe(true);
});

it("interleaves repeated live variants and preserves the exact prompt, actual model and usage", async () => {
  const plan = { ...config, repeats: 2, variants: config.variants.map((v) => ({ ...v, provider: "gemini" as const, model: "requested", instruction: v.id === "stress" ? "Keep it short" : undefined })) };
  const report = { ...fresh("live"), cases: [cases[0]], expectedRows: 4 };
  expect(validatePlan(plan, report.cases, "live", 4)).toBe(4);
  const order: string[] = [];
  await execute(plan, report, async (variant) => {
    order.push(variant.id);
    return { provider: "gemini", model: "actual-version", latencyMs: 1, json: config.variants[0].replay![cases[0].id], usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, totalTokens: 15 } };
  }, () => {});
  expect(order).toEqual(["reference", "stress", "stress", "reference"]);
  expect(report.results[1].prompt.user).toContain("Keep it short");
  expect(report.results[0].promptHash).not.toBe(report.results[1].promptHash);
  expect(report.results[0]).toMatchObject({ requestedModel: "requested", actualModel: "actual-version", usage: { totalTokens: 15 } });
  expect(new Set(report.results.map((r) => r.blindId)).size).toBe(4);
});

it("catches previously missed coverage and Korean wording defects with the new frozen rubric", () => {
  const coverage = casesSchema.parse(JSON.parse(readFileSync("experiments/coverage-cases.json", "utf8")));
  const prior = JSON.parse(readFileSync("docs/experiments/2026-09-22/lite-report.json", "utf8")) as Report;
  for (const row of prior.results.filter((r) => r.caseId === "show_gn")) {
    const checks = evaluate(coverage.find((c) => c.id === row.caseId)!, row.draft!);
    expect(checks.some((c) => !c.ok)).toBe(true);
    if (row.variantId === "concise") {
      expect(checks.find((c) => c.rule === "required:node_modules")?.ok).toBe(false);
      expect(checks.find((c) => c.rule === "required:프록시")?.ok).toBe(false);
    }
  }
  const checks = evaluate(coverage.find((c) => c.id === "show_gn")!, { title: "Show GN: vite - 변경 내용", body: "preload 의존성의 settling을 생략합니다. 코드 프레임의 CRLF 줄바꿈 처리를 수정합니다. 전체 node_modules 경로 구성 요소만 의존성으로 취급합니다. 프록시 컨텍스트 매처를 서버 생성 시 미리 컴파일합니다." });
  expect(checks.every((c) => c.ok)).toBe(true);
});

it("accepts translated coverage aliases without changing old report dataset hashes", () => {
  const old = JSON.parse(readFileSync("docs/experiments/2026-09-22/lite-report.json", "utf8")) as Report;
  expect(hash(casesSchema.parse(old.cases))).toBe(old.datasetHash);
  const cases = casesSchema.parse(JSON.parse(readFileSync("experiments/coverage-cases-v2.json", "utf8")));
  const test = cases.find((c) => c.lang === "ko")!;
  const draft = { title: "변경", body: "미리 로드된 의존성의 settling을 생략합니다. CRLF 줄바꿈을 처리합니다. 전체 node_modules 경로 구성 요소만 의존성으로 봅니다. 프록시 컨텍스트 매처를 미리 컴파일합니다." };
  expect(evaluate(test, draft).every((r) => r.ok)).toBe(true);
  const omitted = { ...draft, body: draft.body.replace("프록시", "") };
  expect(evaluate(test, omitted).find((r) => r.rule === "required_any:proxy")?.ok).toBe(false);
  expect(() => casesSchema.parse([{ ...test, requiredAny: [{ id: "empty", phrases: [] }] }])).toThrow();
});

it("recognizes the established Korean transliteration of preload", () => {
  const cases = casesSchema.parse(JSON.parse(readFileSync("experiments/coverage-cases-v3.json", "utf8")));
  const test = cases.find((c) => c.lang === "ko")!;
  const checks = evaluate(test, { title: "변경", body: "프리로드 의존성의 settling을 생략합니다. CRLF 줄바꿈과 node_modules 경로를 처리합니다. 프록시 컨텍스트 매처를 미리 컴파일합니다." });
  expect(checks.find((c) => c.rule === "required_any:preload")?.ok).toBe(true);
});
