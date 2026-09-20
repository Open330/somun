/**
 * somun push — 로컬 코딩 에이전트 세션을 요약해 올린다. 원문은 올리지 않는다.
 *   npm run push -- [--days 14] [--sources claude,codex,omp] [--dry-run]
 * 읽는 곳: ~/.claude/projects 아래 .jsonl (Claude Code), ~/.codex/sessions 아래 .jsonl (Codex), ~/.config/oh-my-prompt/omp.db (omp)
 * 저장소 매핑: 세션의 cwd에서 `git remote get-url origin`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { groupSessions, repoFromRemote, type RawPrompt } from "../src/core/sessions.js";
import { call } from "./_client.js";

const argv = process.argv.slice(2);
const arg = (k: string, d: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const days = Number(arg("--days", "14"));
const sources = arg("--sources", "claude,codex,omp").split(",");
const dryRun = argv.includes("--dry-run");
const since = Date.now() - days * 86400e3;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".jsonl") && statSync(p).mtimeMs >= since) out.push(p);
  }
  return out;
}
const lines = (file: string) => readFileSync(file, "utf8").split("\n").map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } }).filter((x): x is Record<string, unknown> => Boolean(x));

const prompts: RawPrompt[] = [];

if (sources.includes("claude")) {
  for (const f of walk(join(homedir(), ".claude", "projects"))) {
    for (const d of lines(f)) {
      if (d.type !== "user" || !d.sessionId) continue;
      const m = d.message as { content?: unknown } | undefined;
      const c = m?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? (c.find((x) => (x as { type?: string }).type === "text") as { text?: string } | undefined)?.text ?? "" : "";
      if (!text || text.startsWith("<")) continue; // 도구 결과·시스템 주입 제외
      const at = Date.parse(String(d.timestamp ?? ""));
      if (!at || at < since) continue;
      prompts.push({ sessionId: String(d.sessionId), source: "claude-code", cwd: (d.cwd as string) ?? null, at, text });
    }
  }
}
if (sources.includes("codex")) {
  for (const f of walk(join(homedir(), ".codex", "sessions"))) {
    let cwd: string | null = null, sessionId = "";
    for (const d of lines(f)) {
      const p = (d.payload ?? {}) as Record<string, unknown>;
      if (d.type === "session_meta") { cwd = (p.cwd as string) ?? null; sessionId = String(p.id ?? p.session_id ?? ""); continue; }
      let text = "";
      if (d.type === "event_msg" && p.type === "user_message") text = String(p.message ?? "");
      else if (d.type === "response_item" && p.type === "message" && p.role === "user") text = ((p.content as { type?: string; text?: string }[]) ?? []).filter((x) => x.type === "input_text").map((x) => x.text ?? "").join(" ");
      if (!text || !sessionId) continue;
      const at = Date.parse(String(d.timestamp ?? ""));
      if (!at || at < since) continue;
      prompts.push({ sessionId, source: "codex", cwd, at, text });
    }
  }
}
if (sources.includes("omp")) {
  const dbPath = process.env.OMP_SQLITE_PATH ?? join(homedir(), ".config", "oh-my-prompt", "omp.db");
  if (existsSync(dbPath)) {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(`SELECT session_id, source, cwd, created_at, prompt_text FROM prompts WHERE role='user' AND created_at >= ? AND session_id IS NOT NULL`).all(new Date(since).toISOString()) as { session_id: string; source: string; cwd: string | null; created_at: string; prompt_text: string | null }[];
    for (const r of rows) prompts.push({ sessionId: r.session_id, source: `omp:${r.source}`, cwd: r.cwd, at: Date.parse(r.created_at), text: r.prompt_text ?? "" });
  }
}

const cache = new Map<string, string | null>();
const repoOf = (cwd: string | null) => {
  if (!cwd) return null;
  if (cache.has(cwd)) return cache.get(cwd)!;
  let repo: string | null = null;
  try { repo = repoFromRemote(execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], { stdio: ["ignore", "pipe", "ignore"] }).toString()); } catch { /* git 아님 */ }
  cache.set(cwd, repo);
  return repo;
};
// 같은 세션이 Claude Code 파일과 omp 양쪽에 있으면 한 번만 (omp는 보조).
const seen = new Set<string>();
const deduped = prompts.filter((p) => { const k = `${p.sessionId}:${p.at}`; if (seen.has(k)) return false; seen.add(k); return true; });
const repos = groupSessions(deduped, repoOf, days);
console.log(`prompts ${deduped.length} → sessions ${new Set(deduped.map((p) => p.sessionId)).size} → repos ${repos.length}`);
for (const r of repos) console.log(`  ${r.repo}: ${r.sessions.length} sessions`);
if (dryRun) process.exit(0);
const res = await call<{ inserted: number; attached: number }>("/sessions", { repos });
console.log(`uploaded: inserted ${res.inserted}, attached ${res.attached}`);
