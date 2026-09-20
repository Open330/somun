#!/usr/bin/env node
/**
 * 로컬 에이전트 워커. 설정의 프로바이더가 local-agent일 때 대기 작업을 가져와
 * 사용자의 Claude Code 또는 Codex CLI(본인 구독)로 처리하고 결과를 돌려준다.
 *
 *   node scripts/agent-worker.mjs --cli claude   # 또는 --cli codex, --once, --interval 30
 *   CONVEX_URL, (인증 배포) SOMUN_TOKEN
 *
 * 작업은 system+user 프롬프트와 JSON 스키마다. CLI에 "JSON만 출력"을 요구하고 파싱한다.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const exec = promisify(execFile);
const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const cli = arg("--cli", "claude");
const once = argv.includes("--once");
const intervalSec = Number(arg("--interval", 30));
const url = process.env.CONVEX_URL ?? readEnvLocal("VITE_CONVEX_URL");
if (!url) throw new Error("CONVEX_URL 필요");

function readEnvLocal(key) {
  try {
    return new RegExp(`^${key}=(.*)$`, "m").exec(readFileSync(new URL("../.env.local", import.meta.url), "utf8"))?.[1]?.trim();
  } catch {
    return undefined;
  }
}

const client = new ConvexHttpClient(url);
if (process.env.SOMUN_TOKEN) client.setAuth(process.env.SOMUN_TOKEN);
const runner = `${cli}@${hostname()}`;

function extractJson(text) {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error("JSON not found in agent output");
  }
}

async function runAgent(job) {
  const prompt = `${job.system}\n\n---\n${job.user}\n\n---\nRespond with a single JSON object matching this JSON Schema and nothing else (no prose, no code fence):\n${job.schemaJson}`;
  if (cli === "claude") {
    const { stdout } = await exec("claude", ["-p", prompt, "--output-format", "json", "--max-turns", "1"], { maxBuffer: 20e6, timeout: 300e3 });
    const outer = JSON.parse(stdout);
    const text = typeof outer.result === "string" ? outer.result : JSON.stringify(outer.result);
    return { json: extractJson(text), model: outer.model ?? "claude-code" };
  }
  if (cli === "codex") {
    const { stdout } = await exec("codex", ["exec", "--skip-git-repo-check", "--json", prompt], { maxBuffer: 20e6, timeout: 300e3 });
    // codex --json은 JSONL 이벤트. 마지막 agent 메시지를 찾는다.
    const lines = stdout.trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const last = [...lines].reverse().find((e) => e?.type === "item.completed" && e.item?.type === "agent_message") ?? [...lines].reverse().find((e) => e?.msg?.type === "agent_message");
    const text = last?.item?.text ?? last?.msg?.message ?? stdout;
    return { json: extractJson(text), model: "codex" };
  }
  throw new Error(`unknown cli ${cli}`);
}

async function tick() {
  const jobs = await client.query(anyApi.jobs.pending, {});
  for (const job of jobs) {
    const claimed = await client.mutation(anyApi.jobs.claim, { id: job._id, runner });
    if (!claimed) continue;
    try {
      const { json, model } = await runAgent(job);
      await client.mutation(anyApi.jobs.complete, { id: job._id, resultJson: JSON.stringify(json), model });
      console.log(`done ${job.kind}${job.channel ? `/${job.channel}` : ""} ${job._id}`);
    } catch (e) {
      await client.mutation(anyApi.jobs.complete, { id: job._id, error: String(e.message ?? e).slice(0, 500) });
      console.error(`failed ${job._id}: ${e.message}`);
    }
  }
  return jobs.length;
}

do {
  const n = await tick();
  if (once) break;
  if (n === 0) await new Promise((r) => setTimeout(r, intervalSec * 1000));
} while (true);
