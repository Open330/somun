/**
 * 영상 bridge. 사용자의 컴퓨터에서 돌며 영상 서버에서 렌더 세션을 받아 Claude Code(본인 구독)로 연출한다.
 * 서버가 이 컴퓨터로 요청을 보낼 수 없으므로(NAT) bridge가 먼저 연결해 가져간다.
 *
 *   VIDEO_SERVER_URL=http://127.0.0.1:8791 VIDEO_BRIDGE_TOKEN=... npm run video-bridge
 *   npm run video-bridge -- --claude "aas exec k-june@claude -- claude"   # 계정을 고정할 때
 *   npm run video-bridge -- --once                                          # 한 건만
 *
 * 모델은 영상 서버의 도구 두 개(check_scene, render_video)만 쓴다. 셸·파일·웹 도구는 끄고, 빈 임시 디렉터리에서 돈다.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionTicket } from "../src/video/service.js";

const argv = process.argv.slice(2);
const arg = (k: string, d: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const server = arg("--server", process.env.VIDEO_SERVER_URL ?? "http://127.0.0.1:8791").replace(/\/$/, "");
const token = process.env.VIDEO_BRIDGE_TOKEN ?? "";
const claudeCmd = arg("--claude", process.env.VIDEO_BRIDGE_CLAUDE ?? "claude").split(" ").filter(Boolean);
const once = argv.includes("--once");
const bridge = `claude@${hostname()}`;
if (!token) { console.error("VIDEO_BRIDGE_TOKEN is required"); process.exit(1); }

const workRoot = mkdtempSync(join(tmpdir(), "somun-video-"));
process.on("exit", () => rmSync(workRoot, { recursive: true, force: true }));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));

type ClaudeResult = { result?: string; is_error?: boolean; total_cost_usd?: number; duration_ms?: number; modelUsage?: Record<string, unknown> };

function runClaude(ticket: SessionTicket, dir: string): Promise<ClaudeResult> {
  // 세션 토큰은 명령줄(ps에 보임)이 아니라 이 세션의 임시 파일로 넘긴다.
  const mcpFile = join(dir, "mcp.json");
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { video: { type: "http", url: `${server}/mcp`, headers: { Authorization: `Bearer ${ticket.token}` } } } }), { mode: 0o600 });
  const args = ["-p", "--output-format", "json", "--model", ticket.model, "--system-prompt", ticket.system,
    "--tools", "", "--strict-mcp-config", "--mcp-config", mcpFile, "--allowedTools", "mcp__video__check_scene,mcp__video__render_video",
    "--setting-sources", "", "--max-turns", "40"];
  const [cmd, ...pre] = claudeCmd;
  return new Promise((resolve, reject) => {
    // 중첩 실행 표시만 지운다. 계정 토큰(CLAUDE_CODE_OAUTH_TOKEN 등)은 그대로 둔다.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "CLAUDECODE"));
    const child = spawn(cmd, [...pre, ...args], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), ticket.timeoutSec * 1000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = out.split("\n").map((l) => l.trim()).reverse().find((l) => l.startsWith("{") && l.includes("\"result\""));
      if (line) { try { return resolve(JSON.parse(line) as ClaudeResult); } catch { /* 아래로 */ } }
      reject(new Error(`claude exited ${code}: ${(err || out).slice(-600)}`));
    });
    child.stdin.end(ticket.user);
  });
}

async function finish(ticket: SessionTicket, body: Record<string, unknown>) {
  const r = await fetch(`${server}/v1/sessions/finish`, { method: "POST", headers: { Authorization: `Bearer ${ticket.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) console.error(`finish → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.ok ? ((await r.json()) as { status: string }) : undefined;
}

async function tick(): Promise<boolean> {
  const r = await fetch(`${server}/v1/sessions/next?wait=25&bridge=${encodeURIComponent(bridge)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 204) return false;
  if (!r.ok) throw new Error(`next → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const ticket = (await r.json()) as SessionTicket;
  const dir = mkdtempSync(join(workRoot, "s-"));
  console.log(`▶ ${ticket.renderId} (${ticket.model})`);
  try {
    const res = await runClaude(ticket, dir);
    const model = Object.keys(res.modelUsage ?? {})[0] ?? ticket.model;
    const done = await finish(ticket, { note: res.is_error ? undefined : res.result, error: res.is_error ? res.result : undefined, model, costUsd: res.total_cost_usd, durationMs: res.duration_ms });
    console.log(`■ ${ticket.renderId} ${done?.status ?? "?"} · $${(res.total_cost_usd ?? 0).toFixed(2)} · ${Math.round((res.duration_ms ?? 0) / 1000)}s`);
  } catch (err) {
    await finish(ticket, { error: (err as Error).message.slice(0, 2000) });
    console.error(`✗ ${ticket.renderId}: ${(err as Error).message.slice(0, 300)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return true;
}

console.log(`video bridge → ${server} as ${bridge} (${claudeCmd.join(" ")})`);
for (;;) {
  try {
    const worked = await tick();
    if (worked && once) break;
  } catch (err) {
    console.error((err as Error).message);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}
