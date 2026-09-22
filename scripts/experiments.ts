import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { blindReview, casesSchema, compare, configSchema, execute, hash, reportSchema, summary, summarizeReviews, validatePlan, type Report } from "../src/experiments/drafts.js";
import { freeGeminiKeys, runLlm } from "../src/infra/llm/providers.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  config: { type: "string" }, out: { type: "string" }, live: { type: "boolean", default: false },
  "max-calls": { type: "string", default: "0" }, before: { type: "string" }, after: { type: "string" }, run: { type: "string" }, reviews: { type: "string" },
} });
const read = (file: string | undefined): unknown => { if (!file) throw new Error("Required file option missing"); return JSON.parse(readFileSync(resolve(file), "utf8")); };
const command = positionals[0] ?? "run";
if (positionals.length > 1) throw new Error("Unexpected positional arguments");
if (command === "compare") {
  const result = compare(reportSchema.parse(read(values.before)), reportSchema.parse(read(values.after)));
  console.log(JSON.stringify(result, null, 2));
  if (result.regressions.length || result.removedChecks.length) process.exitCode = 1;
} else if (command === "review") {
  console.log(JSON.stringify(summarizeReviews(reportSchema.parse(read(values.run)), read(values.reviews)), null, 2));
} else if (command === "run") {
  const configPath = resolve(values.config ?? "experiments/replay.json");
  const config = configSchema.parse(read(configPath));
  const cases = casesSchema.parse(read(resolve(dirname(configPath), config.cases)));
  const mode = values.live ? "live" : "replay";
  const maxCalls = Number(values["max-calls"]);
  if (!Number.isInteger(maxCalls) || maxCalls < 0) throw new Error("--max-calls must be a nonnegative integer");
  const count = validatePlan(config, cases, mode, maxCalls);
  const keyFor = (provider: string) => provider === "gemini" ? process.env.GEMINI_API_KEY || freeGeminiKeys(process.env.GEMINI_API_KEYS)[0]?.key : provider === "openai" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
  if (mode === "live") for (const variant of config.variants) if (!keyFor(variant.provider!)) throw new Error(`Credential unavailable for ${variant.provider}; no calls made`);
  const out = resolve(values.out ?? `experiments/runs/${Date.now()}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dirname(out), { recursive: true });
  mkdirSync(out, { mode: 0o700 }); // Existing runs must never be overwritten.
  const write = (name: string, value: unknown) => {
    const target = resolve(out, name);
    writeFileSync(`${target}.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    renameSync(`${target}.tmp`, target);
  };
  let revision = "unknown", dirty = true;
  try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()); } catch { /* report remains explicitly unknown */ }
  const evaluatorSources = Object.fromEntries(["src/experiments/drafts.ts", "src/core/lint.ts", "src/core/prompts.ts", "src/core/channels.ts", "src/core/voice.ts", "src/infra/llm/providers.ts", "scripts/experiments.ts"].map((file) => [file, readFileSync(file, "utf8")]));
  write("evaluator-sources.json", evaluatorSources);
  const report: Report = { version: 1, name: config.name, mode, datasetHash: hash(cases), startedAt: new Date().toISOString(), evaluatorHash: hash(evaluatorSources), revision, dirty, expectedRows: count, cases, results: [] };
  write("config.json", config);
  const checkpoint = () => {
    write("report.json", report); write("review.json", blindReview(report));
    writeFileSync(resolve(out, "summary.md"), summary(report), { mode: 0o600 });
  };
  checkpoint();
  console.log(`Experiment: ${mode}, ${count} outputs → ${out}`);
  await execute(config, report, async (variant, prompt) => {
    // Explicit BYOK prevents the production adapter's automatic Gemini model fallback.
    return runLlm({ provider: variant.provider!, model: variant.model, draftModel: variant.model, apiKey: keyFor(variant.provider!) }, prompt, "draft", undefined, undefined, AbortSignal.timeout(90_000));
  }, () => { checkpoint(); console.log(`Completed ${report.results.length}/${count}`); });
  console.log(summary(report));
  if (report.results.some((r) => r.status === "error")) process.exitCode = 1;
} else throw new Error("Commands: run, compare, review");
