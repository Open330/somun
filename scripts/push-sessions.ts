/**
 * somun push — 로컬 코딩 에이전트 세션을 요약해 올린다. 원문은 올리지 않는다.
 *   npm run push -- [--days 14] [--sources claude,codex,omp] [--dry-run]
 * 읽는 곳: ~/.claude/projects 아래 .jsonl (Claude Code), ~/.codex/sessions 아래 .jsonl (Codex), ~/.config/oh-my-prompt/omp.db (omp)
 * 저장소 매핑: 세션의 cwd에서 `git remote get-url origin`.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { groupSessions, repoFromRemote, type RawPrompt } from "../src/core/sessions.js";
import { claudePrompts, codexPrompts, walkJsonl } from "../src/infra/session-files.js";
import { call } from "./_client.js";

const argv = process.argv.slice(2);
const arg = (k: string, d: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const days = Number(arg("--days", "14"));
const sources = arg("--sources", "claude,codex,omp").split(",");
const dryRun = argv.includes("--dry-run");
const since = Date.now() - days * 86400e3;

const prompts: RawPrompt[] = [];

// 세션 로그는 1GB를 넘기도 해 한 줄씩 읽는다(src/infra/session-files).
if (sources.includes("claude")) for (const f of walkJsonl(join(homedir(), ".claude", "projects"), since)) for (const p of await claudePrompts(f, since)) prompts.push(p);
if (sources.includes("codex")) for (const f of walkJsonl(join(homedir(), ".codex", "sessions"), since)) for (const p of await codexPrompts(f, since)) prompts.push(p);
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
