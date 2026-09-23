import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { blindReview, casesSchema, compare, configSchema, execute, hash, reportSchema, summary, summarizeReviews, validatePlan, type Report } from "../src/experiments/drafts.js";
import { freeGeminiKeys, runLlm } from "../src/infra/llm/providers.js";
import { openDb, schema } from "../src/infra/db/index.js";
import { exportHoldout } from "../src/experiments/holdout.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  config: { type: "string" }, out: { type: "string" }, live: { type: "boolean", default: false },
  "max-calls": { type: "string", default: "0" }, owner: { type: "string" }, max: { type: "string" }, before: { type: "string" }, after: { type: "string" }, run: { type: "string" }, reviews: { type: "string" },
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
} else if (command === "export-holdout") {
  // 실제로 복사한 초안으로 보류 평가 세트를 만든다. 개인 원고가 들어가므로 기본 위치는 git에서 제외된 experiments/holdout/.
  const db = openDb(resolve(process.env.DATA_DIR ?? "./data", "somun.db"));
  try {
    const owners = db.selectDistinct({ ownerId: schema.drafts.ownerId }).from(schema.drafts).all().map((r) => r.ownerId);
    const owner = values.owner ?? (owners.length === 1 ? owners[0] : undefined);
    if (!owner) throw new Error(`--owner가 필요합니다. 후보: ${owners.join(", ") || "(없음)"}`);
    const outDir = resolve(values.out ?? `experiments/holdout/${new Date().toISOString().slice(0, 10)}`);
    // 이전 내보내기를 덮어쓰지 않는다.
    if (existsSync(outDir)) throw new Error(`이미 있는 경로입니다: ${outDir}. --out으로 새 경로를 지정하세요.`);
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const max = Number(values.max ?? 30);
    if (!Number.isInteger(max) || max < 1 || max > 100) throw new Error("--max는 1~100 사이 정수입니다.");
    const { cases, config, skipped } = exportHoldout(db, owner, { max });
    writeFileSync(resolve(outDir, "cases.json"), `${JSON.stringify(cases, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(resolve(outDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    console.log(`Exported ${cases.length} cases (${skipped} skipped: no digest) to ${outDir}`);
    console.log(`Baseline: npm run experiment -- run --config ${resolve(outDir, "config.json")}`);
  } finally { db.$client.close(); }
} else throw new Error("Commands: run, compare, review, export-holdout");
