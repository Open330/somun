/**
 * 로컬 에이전트 워커. 설정의 프로바이더가 local-agent일 때 대기 작업을 가져와
 * 사용자의 Claude Code 또는 Codex CLI(본인 구독)로 처리하고 결과를 돌려준다.
 *   npm run agent-worker -- --cli claude   # 또는 --cli codex, --once, --interval 30
 */
import { isBetterRepair } from "../src/core/draft-repair.js";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { Job, LocalUsage } from "../src/shared/types.js";
import { claudeUsage, codexModelFrom, codexUsage, mainModel } from "../src/core/agent-usage.js";
import { call } from "./_client.js";

/** 프롬프트는 stdin으로. 중첩 실행을 막는 에이전트 환경변수는 지운다. */
function run(cmd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "CLAUDECODE"));
    // 빈 임시 디렉터리에서 실행한다. 원자료(PR 제목·커밋)가 프롬프트에 들어가므로 저장소나 .env 가까이에서 돌리지 않는다.
    const child = spawn(cmd, args, { env, cwd: workDir, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 300e3);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      // 실패해도 출력에 사용량이 있을 수 있다(최대 턴·오류 결과). 호출한 쪽이 읽을 수 있게 붙여 둔다.
      else reject(Object.assign(new Error(`${cmd} exited ${code}: ${err.slice(-600) || out.slice(-600)}`), { stdout: out }));
    });
    child.stdin.end(input);
  });
}
const argv = process.argv.slice(2);
const arg = (k: string, d: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const cli = arg("--cli", "claude");
const once = argv.includes("--once");
const intervalSec = Number(arg("--interval", "30"));
const runner = `${cli}@${hostname()}`;
const workDir = mkdtempSync(join(tmpdir(), "somun-agent-"));
process.on("exit", () => rmSync(workDir, { recursive: true, force: true }));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));

function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(t); } catch {
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error("JSON not found in agent output");
  }
}

/** Codex는 출력에 모델 이름을 싣지 않는다. 사용자의 Codex 설정(최상위 model)에서 읽는다. */
function codexModel(): string {
  try { return codexModelFrom(readFileSync(join(homedir(), ".codex", "config.toml"), "utf8")); } catch { return "codex"; }
}

const parseLines = (stdout: string) => stdout.trim().split("\n").map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } }).filter((x): x is Record<string, unknown> => Boolean(x));

/** CLI로 작업 하나를 처리한다. 쓴 호출의 사용량은 usage에 쌓는다(실패한 호출도). */
async function runAgent(job: Job, usage: LocalUsage[]): Promise<{ json: unknown; model: string }> {
  const prompt = `${job.system}\n\n---\n${job.user}\n\n---\nRespond with a single JSON object matching this JSON Schema and nothing else (no prose, no code fence):\n${job.schemaJson}`;
  const startedAt = Date.now();
  const failed = (provider: LocalUsage["provider"], model: string) => usage.push({ provider, model, startedAt, latencyMs: Date.now() - startedAt, status: "error", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
  if (cli === "claude") {
    let stdout: string;
    try { stdout = await run("claude", ["-p", "--output-format", "json", "--max-turns", "1"], prompt); }
    catch (e) {
      // 최대 턴·오류로 끝나도 출력에 쓴 토큰이 있으면 그대로 오류 이벤트로 남긴다.
      let spent: LocalUsage[] = [];
      try { spent = claudeUsage(JSON.parse((e as { stdout?: string }).stdout ?? ""), startedAt).map((u) => ({ ...u, status: "error" as const })); } catch { /* 출력이 JSON이 아님 */ }
      if (spent.length) usage.push(...spent); else failed("anthropic", "claude-code");
      throw e;
    }
    let outer: { result?: unknown; model?: string; modelUsage?: Parameters<typeof claudeUsage>[0]["modelUsage"]; duration_api_ms?: number };
    try { outer = JSON.parse(stdout); } catch (e) { failed("anthropic", "claude-code"); throw e; }
    usage.push(...claudeUsage(outer, startedAt));
    return { json: extractJson(typeof outer.result === "string" ? outer.result : JSON.stringify(outer.result)), model: mainModel(outer.modelUsage) ?? outer.model ?? "claude-code" };
  }
  if (cli === "codex") {
    const model = codexModel();
    let stdout: string;
    try { stdout = await run("codex", ["exec", "--skip-git-repo-check", "--json", "-"], prompt); }
    catch (e) {
      const spent = codexUsage(parseLines((e as { stdout?: string }).stdout ?? ""), model, startedAt, Date.now() - startedAt).map((u) => ({ ...u, status: "error" as const }));
      if (spent.length) usage.push(...spent); else failed("openai", model);
      throw e;
    }
    const lines = parseLines(stdout);
    const spent = codexUsage(lines, model, startedAt, Date.now() - startedAt);
    if (spent.length) usage.push(...spent); else failed("openai", model);
    const last = [...lines].reverse().find((e) => e.type === "item.completed" && (e.item as { type?: string })?.type === "agent_message");
    const text = (last?.item as { text?: string })?.text ?? stdout;
    return { json: extractJson(text), model };
  }
  throw new Error(`unknown cli ${cli}`);
}

type Check = { issues: { rule: string; detail?: string }[]; repairUser?: string };

/**
 * 서버 작업자와 같은 자동 보정: 서버가 초안을 린트해 고칠 점을 알려 주면 한 번 더 쓰고, 덜 걸리는 쪽을 제출한다.
 * 확인 API가 없는 예전 서버이거나 다시 쓰기가 실패하면 처음 결과를 그대로 낸다.
 */
async function repair(job: Job, claimToken: string, first: { json: unknown; model: string }, usage: LocalUsage[]): Promise<{ json: unknown; model: string }> {
  let before: Check;
  try { before = await call<Check>(`/jobs/${job.id}/check`, { claimToken, resultJson: JSON.stringify(first.json) }); } catch { return first; }
  if (!before.repairUser) return first;
  try {
    const again = await runAgent({ ...job, user: before.repairUser }, usage);
    const after = await call<Check>(`/jobs/${job.id}/check`, { claimToken, resultJson: JSON.stringify(again.json) });
    const better = isBetterRepair(before.issues, after.issues, { before: JSON.stringify(first.json ?? ""), after: JSON.stringify(again.json ?? "") });
    console.log(`repair #${job.id}: ${before.issues.map((i) => i.rule).join(",")} → ${after.issues.map((i) => i.rule).join(",") || "ok"} (${better ? "repaired" : "kept first"})`);
    return better ? again : first;
  } catch (e) {
    console.error(`repair failed #${job.id}: ${(e as Error).message}; keeping the first draft`);
    return first;
  }
}

async function tick(): Promise<number> {
  const jobs = await call<Job[]>("/jobs/pending");
  for (const job of jobs) {
    const { claimed, claimToken } = await call<{ claimed: boolean; claimToken?: string }>(`/jobs/${job.id}/claim`, { runner });
    if (!claimed || !claimToken) continue;
    // 이 작업에서 쓴 CLI 호출(본 호출 + 보정). 완료 보고에 함께 보낸다. 서버는 유효한 첫 보고에서만 센다.
    const usage: LocalUsage[] = [];
    try {
      let { json, model } = await runAgent(job, usage);
      if (job.kind === "draft") ({ json, model } = await repair(job, claimToken, { json, model }, usage));
      const { applied } = await call<{ applied: boolean }>(`/jobs/${job.id}/complete`, { claimToken, resultJson: JSON.stringify(json), model, usage });
      console.log(`${applied ? "done" : "not applied"} ${job.kind}${job.channel ? `/${job.channel}` : ""} #${job.id}`);
    } catch (e) {
      await call(`/jobs/${job.id}/complete`, { claimToken, error: String((e as Error).message ?? e).slice(0, 500), usage });
      console.error(`failed #${job.id}: ${(e as Error).message}`);
    }
  }
  return jobs.length;
}

// 서버 재시작·네트워크 끊김으로 워커가 죽지 않게 한다. 연속 실패하면 대기 시간을 늘린다(최대 5분).
let failures = 0;
for (;;) {
  let n = 0;
  try { n = await tick(); failures = 0; }
  catch (e) {
    failures++;
    console.error(`poll failed (${failures}): ${(e as Error).message}`);
    if (once) process.exit(1);
  }
  if (once) break;
  if (n === 0) await new Promise((r) => setTimeout(r, Math.min(300, intervalSec * 2 ** Math.min(failures, 4)) * 1000));
}
