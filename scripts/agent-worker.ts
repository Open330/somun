/**
 * 로컬 에이전트 워커. 설정의 프로바이더가 local-agent일 때 대기 작업을 가져와
 * 사용자의 Claude Code 또는 Codex CLI(본인 구독)로 처리하고 결과를 돌려준다.
 *   npm run agent-worker -- --cli claude   # 또는 --cli codex, --once, --interval 30
 */
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import type { Job } from "../src/shared/types.js";
import { call } from "./_client.js";

/** 프롬프트는 stdin으로. 중첩 실행을 막는 에이전트 환경변수는 지운다. */
function run(cmd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "CLAUDECODE"));
    const child = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 300e3);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(-600) || out.slice(-600)}`));
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

function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(t); } catch {
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error("JSON not found in agent output");
  }
}

async function runAgent(job: Job): Promise<{ json: unknown; model: string }> {
  const prompt = `${job.system}\n\n---\n${job.user}\n\n---\nRespond with a single JSON object matching this JSON Schema and nothing else (no prose, no code fence):\n${job.schemaJson}`;
  if (cli === "claude") {
    const stdout = await run("claude", ["-p", "--output-format", "json", "--max-turns", "1"], prompt);
    const outer = JSON.parse(stdout) as { result?: unknown; model?: string };
    return { json: extractJson(typeof outer.result === "string" ? outer.result : JSON.stringify(outer.result)), model: outer.model ?? "claude-code" };
  }
  if (cli === "codex") {
    const stdout = await run("codex", ["exec", "--skip-git-repo-check", "--json", "-"], prompt);
    const lines = stdout.trim().split("\n").map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } }).filter((x): x is Record<string, unknown> => Boolean(x));
    const last = [...lines].reverse().find((e) => e.type === "item.completed" && (e.item as { type?: string })?.type === "agent_message");
    const text = (last?.item as { text?: string })?.text ?? stdout;
    return { json: extractJson(text), model: "codex" };
  }
  throw new Error(`unknown cli ${cli}`);
}

async function tick(): Promise<number> {
  const jobs = await call<Job[]>("/jobs/pending");
  for (const job of jobs) {
    const { claimed, claimToken } = await call<{ claimed: boolean; claimToken?: string }>(`/jobs/${job.id}/claim`, { runner });
    if (!claimed || !claimToken) continue;
    try {
      const { json, model } = await runAgent(job);
      const { applied } = await call<{ applied: boolean }>(`/jobs/${job.id}/complete`, { claimToken, resultJson: JSON.stringify(json), model });
      console.log(`${applied ? "done" : "not applied"} ${job.kind}${job.channel ? `/${job.channel}` : ""} #${job.id}`);
    } catch (e) {
      await call(`/jobs/${job.id}/complete`, { claimToken, error: String((e as Error).message ?? e).slice(0, 500) });
      console.error(`failed #${job.id}: ${(e as Error).message}`);
    }
  }
  return jobs.length;
}

for (;;) {
  const n = await tick();
  if (once) break;
  if (n === 0) await new Promise((r) => setTimeout(r, intervalSec * 1000));
}
