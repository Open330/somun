import { createHash } from "node:crypto";
import { z } from "zod";
import { draftLintFacts, lintDraft, type LintResult } from "../core/lint.js";
import { draftPrompt, type CandidateLike, type PromptSpec } from "../core/prompts.js";
import { LlmError, type LlmResult } from "../infra/llm/providers.js";

const id = z.string().regex(/^[a-z0-9_-]+$/);
const draftSchema = z.object({ title: z.string(), body: z.string().trim().min(1) }).strict();
const evidenceSchema = z.object({
  repo: z.string().min(1), repoUrl: z.string().url(), description: z.string().optional(),
  version: z.string().optional(), releaseNotes: z.string().optional(), readmeExcerpt: z.string().optional(),
  highlights: z.array(z.string()).min(1), limitations: z.array(z.string()).default([]),
  stars: z.number().optional(), forks: z.number().optional(), commitCount: z.number().optional(),
  releaseCount: z.number().optional(), firstReleaseAt: z.string().optional(),
  language: z.string().optional(), license: z.string().optional(), homepage: z.string().optional(),
  npmPackage: z.string().optional(), npmMonthlyDownloads: z.number().optional(), demoAsset: z.string().optional(),
}).strict();
export const casesSchema = z.array(z.object({
  id, channel: z.enum(["x", "threads", "linkedin", "show_hn", "show_gn", "blog"]), lang: z.string().min(2),
  candidate: z.object({ title: z.string(), type: z.string(), evidence: evidenceSchema }).strict(),
  required: z.array(z.string().min(1)).default([]),
  requiredAny: z.array(z.object({ id, phrases: z.array(z.string().min(1)).min(1) }).strict()).optional(), forbidden: z.array(z.string().min(1)).default([]),
  reviewNotes: z.string(),
}).strict()).min(1).max(100).superRefine((rows, ctx) => {
  if (new Set(rows.map((r) => r.id)).size !== rows.length) ctx.addIssue({ code: "custom", message: "duplicate case IDs" });
});
export const configSchema = z.object({
  name: id, cases: z.string().min(1), repeats: z.number().int().min(1).max(5).default(1),
  variants: z.array(z.object({
    id, provider: z.enum(["gemini", "openai", "anthropic"]).optional(), model: z.string().min(1).optional(),
    instruction: z.string().optional(), replay: z.record(z.string(), draftSchema).optional(),
  }).strict()).min(1).max(10),
}).strict().superRefine((config, ctx) => {
  if (new Set(config.variants.map((v) => v.id)).size !== config.variants.length) ctx.addIssue({ code: "custom", message: "duplicate variant IDs" });
});
export type ExperimentCase = z.infer<typeof casesSchema>[number];
export type ExperimentConfig = z.infer<typeof configSchema>;
export type Variant = ExperimentConfig["variants"][number];
export const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const checkSchema = z.object({ rule: z.string(), ok: z.boolean(), detail: z.string().optional() });
export const reportSchema = z.object({
  version: z.literal(1), name: z.string(), mode: z.enum(["replay", "live"]), datasetHash: z.string(),
  startedAt: z.string(), evaluatorHash: z.string(), revision: z.string(), dirty: z.boolean(), expectedRows: z.number().int(),
  cases: casesSchema,
  results: z.array(z.object({
    caseId: z.string(), variantId: z.string(), sample: z.number().int(), blindId: z.string(),
    status: z.enum(["ok", "error"]), promptHash: z.string(),
    prompt: z.object({ system: z.string(), user: z.string(), schema: z.record(z.string(), z.unknown()), schemaName: z.string() }),
    requestedModel: z.string().optional(), actualModel: z.string().optional(), provider: z.string().optional(),
    elapsedMs: z.number().nonnegative(), draft: draftSchema.optional(), checks: z.array(checkSchema),
    error: z.enum(["generation_failed", "invalid_output", "timeout"]).optional(), httpStatus: z.number().int().optional(),
    usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), cachedInputTokens: z.number(), totalTokens: z.number() }).optional(),
  })),
});
export type Report = z.infer<typeof reportSchema>;
export type Result = Report["results"][number];
export type Generate = (variant: Variant, prompt: PromptSpec) => Promise<LlmResult>;

export function evaluate(test: ExperimentCase, draft: z.infer<typeof draftSchema>): LintResult[] {
  const checks = lintDraft(test.channel, draft.title, draft.body, undefined, draftLintFacts(test.candidate as CandidateLike));
  const text = `${draft.title}\n${draft.body}`.toLowerCase();
  for (const phrase of test.required) checks.push({ rule: `required:${phrase}`, ok: text.includes(phrase.toLowerCase()), detail: `필수 사실: ${phrase}` });
  for (const group of test.requiredAny ?? []) checks.push({ rule: `required_any:${group.id}`, ok: group.phrases.some((phrase) => text.includes(phrase.toLowerCase())), detail: `필수 개념: ${group.phrases.join(" / ")}` });
  for (const phrase of test.forbidden) checks.push({ rule: `forbidden:${phrase}`, ok: !text.includes(phrase.toLowerCase()), detail: `금지 주장: ${phrase}` });
  return checks;
}

export function validatePlan(config: ExperimentConfig, cases: ExperimentCase[], mode: Report["mode"], maxCalls: number): number {
  const count = config.variants.length * cases.length * config.repeats;
  if (count > 100) throw new Error("Experiment limited to 100 outputs; split the dataset");
  if (mode === "live" && count > maxCalls) throw new Error(`Plan needs ${count} generations; --max-calls is ${maxCalls}`);
  if (mode === "replay" && config.repeats !== 1) throw new Error("Replay repeats must be 1; copied outputs are not independent samples");
  for (const variant of config.variants) {
    if (mode === "live" && (!variant.provider || !variant.model)) throw new Error(`Explicit provider and model required: ${variant.id}`);
    if (mode === "replay" && cases.some((test) => !variant.replay?.[test.id])) throw new Error(`Missing replay outputs: ${variant.id}`);
  }
  return count;
}

/** Case/sample first: variants are interleaved to reduce time-of-run confounding. */
export async function execute(config: ExperimentConfig, report: Report, generate: Generate, checkpoint: () => void): Promise<void> {
  for (const test of report.cases) for (let sample = 1; sample <= config.repeats; sample++) {
    const variants = sample % 2 ? config.variants : [...config.variants].reverse();
    for (const variant of variants) {
      const prompt = draftPrompt(test.candidate, test.channel, test.lang, [], undefined, { instruction: variant.instruction });
      const row: Result = {
        caseId: test.id, variantId: variant.id, sample,
        blindId: hash([report.startedAt, test.id, variant.id, sample]).slice(0, 16),
        status: "error", promptHash: hash(prompt), prompt, requestedModel: variant.model, provider: variant.provider,
        elapsedMs: 0, checks: [],
      };
      const start = Date.now();
      try {
        const response = report.mode === "live" ? await generate(variant, prompt) : undefined;
        row.elapsedMs = report.mode === "live" ? Date.now() - start : 0;
        row.actualModel = response?.model; row.provider = response?.provider ?? variant.provider; row.usage = response?.usage;
        const parsed = draftSchema.safeParse(response ? response.json : variant.replay?.[test.id]);
        if (!parsed.success) row.error = "invalid_output";
        else { row.draft = parsed.data; row.checks = evaluate(test, parsed.data); row.status = "ok"; }
      } catch (error) {
        row.error = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "timeout" : "generation_failed";
        if (error instanceof LlmError) row.httpStatus = error.status;
        row.elapsedMs = Date.now() - start;
      }
      // Provider errors may contain headers/prompts. Never serialize raw error text.
      report.results.push(row); checkpoint();
    }
  }
}

export function summary(report: Report): string {
  const lines = [`# ${report.name}`, "", `Mode: ${report.mode}; completed: ${report.results.length}/${report.expectedRows}`, "", "Automatic checks are not a factuality or publishability score. Replay latency is not model latency.", "", "| Variant | Outputs | Errors | Checks passed | Mean latency (ms) |", "|---|---:|---:|---:|---:|"];
  for (const variant of new Set(report.results.map((r) => r.variantId))) {
    const rows = report.results.filter((r) => r.variantId === variant);
    const errors = rows.filter((r) => r.status === "error").length;
    const passes = rows.filter((r) => r.status === "ok" && r.checks.every((c) => c.ok)).length;
    lines.push(`| ${variant} | ${rows.length} | ${errors} | ${passes}/${rows.length} | ${report.mode === "live" ? Math.round(rows.reduce((n, r) => n + r.elapsedMs, 0) / rows.length) : "n/a"} |`);
  }
  lines.push("", "## Generation errors", "");
  for (const row of report.results.filter((r) => r.status === "error")) lines.push(`- ${row.caseId}/${row.variantId}/${row.sample}: ${row.error}${row.httpStatus ? ` (HTTP ${row.httpStatus})` : ""}`);
  lines.push("", "## Failed checks", "");
  for (const row of report.results) for (const check of row.checks.filter((c) => !c.ok)) lines.push(`- ${row.caseId}/${row.variantId}/${row.sample}: ${check.rule}`);
  return lines.join("\n") + "\n";
}

export function compare(before: Report, after: Report) {
  if (before.datasetHash !== after.datasetHash || hash(before.cases) !== hash(after.cases)) throw new Error("Cannot compare different datasets or expectations");
  const key = (r: Result) => `${r.caseId}/${r.variantId}/${r.sample}`;
  const old = new Map(before.results.map((r) => [key(r), r]));
  if (before.results.length !== before.expectedRows || after.results.length !== after.expectedRows || old.size !== before.results.length || after.results.length !== old.size || new Set(after.results.map(key)).size !== old.size || after.results.some((r) => !old.has(key(r)))) throw new Error("Cannot compare incomplete or unpaired runs");
  const regressions: string[] = [], improvements: string[] = [], addedChecks: string[] = [], removedChecks: string[] = [];
  for (const row of after.results) {
    const prev = old.get(key(row))!;
    const passed = (r: Result) => r.status === "ok" && r.checks.every((c) => c.ok);
    if (passed(prev) && !passed(row)) regressions.push(key(row));
    if (!passed(prev) && passed(row)) improvements.push(key(row));
    const prior = new Map(prev.checks.map((c) => [c.rule, c.ok]));
    for (const c of row.checks) {
      if (prior.get(c.rule) === true && !c.ok) regressions.push(`${key(row)}:${c.rule}`);
      if (!prior.has(c.rule)) addedChecks.push(`${key(row)}:${c.rule}`);
    }
    if (row.status === "ok") for (const c of prev.checks) if (!row.checks.some((check) => check.rule === c.rule)) removedChecks.push(`${key(row)}:${c.rule}`);
  }
  return { beforeMode: before.mode, afterMode: after.mode, regressions, improvements, addedChecks, removedChecks, evaluatorChanged: before.evaluatorHash !== after.evaluatorHash, note: "Paired automatic checks only; no claim of statistical significance or human preference." };
}

/** Deliberately omits provider, model, variant and automatic grades. Keep report.json away from reviewers. */
export function blindReview(report: Report) {
  return report.results.filter((r) => r.draft).sort((a, b) => a.blindId.localeCompare(b.blindId)).map((row) => {
    const test = report.cases.find((c) => c.id === row.caseId)!;
    return { blindId: row.blindId, channel: test.channel, lang: test.lang, evidence: test.candidate, reviewNotes: test.reviewNotes, draft: row.draft, ratings: { grounding: null, clarity: null, voice: null }, publishable: null, editSeconds: null, notes: "" };
  });
}

const reviewSchema = z.array(z.object({
  blindId: z.string(), ratings: z.object({ grounding: z.number().int().min(1).max(5).nullable(), clarity: z.number().int().min(1).max(5).nullable(), voice: z.number().int().min(1).max(5).nullable() }).strict(),
  publishable: z.boolean().nullable(), editSeconds: z.number().nonnegative().nullable(), notes: z.string(),
  // The exported contextual fields are retained for a reviewer editing the JSON file.
  channel: z.string(), lang: z.string(), evidence: z.unknown(), reviewNotes: z.string(), draft: draftSchema,
}).strict());

export function summarizeReviews(report: Report, input: unknown) {
  const reviews = reviewSchema.parse(input);
  const expected = new Map(blindReview(report).map((r) => [r.blindId, r]));
  if (reviews.length !== expected.size || new Set(reviews.map((r) => r.blindId)).size !== expected.size || reviews.some((r) => !expected.has(r.blindId))) throw new Error("Review IDs must match this run exactly");
  for (const review of reviews) {
    const original = expected.get(review.blindId)!;
    if (hash(review.draft) !== hash(original.draft) || hash(review.evidence) !== hash(original.evidence) || review.channel !== original.channel || review.lang !== original.lang || review.reviewNotes !== original.reviewNotes) throw new Error("Review source/output was changed; edit ratings and notes only");
  }
  return [...new Set(report.results.map((r) => r.variantId))].map((variantId) => {
    const ids = new Set(report.results.filter((r) => r.variantId === variantId).map((r) => r.blindId));
    const rows = reviews.filter((r) => ids.has(r.blindId));
    const completed = rows.filter((r) => r.publishable !== null && Object.values(r.ratings).every((score) => score !== null));
    const timed = completed.filter((r) => r.editSeconds !== null);
    return { variantId, generated: rows.length, reviewed: completed.length, pending: rows.length - completed.length,
      publishable: completed.filter((r) => r.publishable).length,
      meanGrounding: completed.length ? completed.reduce((n, r) => n + r.ratings.grounding!, 0) / completed.length : null,
      meanClarity: completed.length ? completed.reduce((n, r) => n + r.ratings.clarity!, 0) / completed.length : null,
      meanVoice: completed.length ? completed.reduce((n, r) => n + r.ratings.voice!, 0) / completed.length : null,
      timed: timed.length, meanEditSeconds: timed.length ? timed.reduce((n, r) => n + r.editSeconds!, 0) / timed.length : null };
  });
}
