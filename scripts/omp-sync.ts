/**
 * oh-my-prompt 로컬 SQLite를 읽어 최근 세션을 저장소별로 요약하고 소문에 보낸다.
 *   npm run omp-sync -- --days 14
 * 프롬프트 전문은 보내지 않는다. 세션 수, 프롬프트 수, 재시도 추정, 가장 긴 세션의 주제(첫 프롬프트 120자)만.
 */
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { call } from "./_client.js";

const days = Number(process.argv[process.argv.indexOf("--days") + 1] || 14);
const dbPath = process.env.OMP_SQLITE_PATH ?? `${homedir()}/.config/oh-my-prompt/omp.db`;
const db = new Database(dbPath, { readonly: true });
const since = new Date(Date.now() - days * 86400e3).toISOString();
type Row = { session_id: string; source: string; cwd: string | null; created_at: string; prompt_text: string | null; prompt_length: number | null };
const rows = db.prepare(`SELECT session_id, source, cwd, created_at, prompt_text, prompt_length FROM prompts WHERE role='user' AND created_at >= ? AND session_id IS NOT NULL ORDER BY created_at`).all(since) as Row[];

const repoCache = new Map<string, string | null>();
function repoOf(cwd: string | null): string | null {
  if (!cwd) return null;
  if (repoCache.has(cwd)) return repoCache.get(cwd)!;
  let repo: string | null = null;
  try {
    const remote = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    repo = /github\.com[:/]([^/]+\/[^/.]+)/.exec(remote)?.[1] ?? null;
  } catch { /* git 아님 */ }
  repoCache.set(cwd, repo);
  return repo;
}

const RETRY = /(again|still|다시|아직|여전히|또 |same error|not fixed|안 됩니다|안돼|안 되)/i;
type Sess = { sessionId: string; repo: string; source: string; startedAt: number; promptCount: number; retries: number; topic: string };
const sessions = new Map<string, Sess>();
for (const r of rows) {
  const repo = repoOf(r.cwd);
  if (!repo) continue;
  const s = sessions.get(r.session_id) ?? { sessionId: r.session_id, repo, source: r.source, startedAt: Date.parse(r.created_at), promptCount: 0, retries: 0, topic: "" };
  s.promptCount++;
  if (RETRY.test(r.prompt_text ?? "")) s.retries++;
  if (!s.topic) s.topic = (r.prompt_text ?? "").replace(/\s+/g, " ").slice(0, 120);
  sessions.set(r.session_id, s);
}
const byRepo = new Map<string, Sess[]>();
for (const s of sessions.values()) byRepo.set(s.repo, [...(byRepo.get(s.repo) ?? []), s]);
const repos = [...byRepo].map(([repo, list]) => {
  const longest = [...list].sort((a, b) => b.promptCount - a.promptCount)[0];
  const retries = list.reduce((n, s) => n + s.retries, 0);
  const summary = [
    `최근 ${days}일: 세션 ${list.length}개, 프롬프트 ${list.reduce((n, s) => n + s.promptCount, 0)}개 (${[...new Set(list.map((s) => s.source))].join(", ")})`,
    retries ? `재시도로 보이는 프롬프트 ${retries}개 — 실패담 후보` : "재시도 흔적 없음",
    longest ? `가장 긴 세션(${longest.promptCount} 프롬프트) 주제: ${longest.topic}` : "",
  ].filter(Boolean).join("\n");
  return { repo, summary, sessions: list.slice(0, 50).map(({ sessionId, source, startedAt, promptCount, topic }) => ({ sessionId, source, startedAt, promptCount, topic })) };
});
const res = await call<{ inserted: number; attached: number }>("/omp/sessions", { repos });
console.log(`omp-sync: ${rows.length} prompts → ${sessions.size} sessions → ${repos.length} repos; inserted ${res.inserted}, attached ${res.attached}`);
