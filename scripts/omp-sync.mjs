#!/usr/bin/env node
/**
 * oh-my-prompt 로컬 SQLite를 읽어 최근 세션을 저장소별로 요약하고 소문에 보낸다.
 *   node scripts/omp-sync.mjs [--days 14]
 * 저장소 매핑: prompts.cwd 에서 `git remote get-url origin` 으로 owner/repo 를 얻는다.
 * 프롬프트 전문은 보내지 않는다. 세션 수, 프롬프트 수, 재시도 추정, 가장 긴 세션의 주제(첫 프롬프트 120자)만 보낸다.
 */
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const days = Number(process.argv[process.argv.indexOf("--days") + 1] || 14);
const dbPath = process.env.OMP_SQLITE_PATH ?? `${homedir()}/.config/oh-my-prompt/omp.db`;
const url = process.env.CONVEX_URL ?? readEnvLocal("VITE_CONVEX_URL");
if (!url) throw new Error("CONVEX_URL 필요");

function readEnvLocal(key) {
  try {
    return new RegExp(`^${key}=(.*)$`, "m").exec(readFileSync(new URL("../.env.local", import.meta.url), "utf8"))?.[1]?.trim();
  } catch {
    return undefined;
  }
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const since = new Date(Date.now() - days * 86400e3).toISOString();
const rows = db
  .prepare(`SELECT session_id, source, project, cwd, created_at, prompt_text, prompt_length FROM prompts WHERE role='user' AND created_at >= ? AND session_id IS NOT NULL ORDER BY created_at`)
  .all(since);

const repoCache = new Map();
function repoOf(cwd) {
  if (!cwd) return null;
  if (repoCache.has(cwd)) return repoCache.get(cwd);
  let repo = null;
  try {
    const remote = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const m = /github\.com[:/]([^/]+\/[^/.]+)/.exec(remote);
    if (m) repo = m[1];
  } catch {
    /* git 아님 */
  }
  repoCache.set(cwd, repo);
  return repo;
}

const RETRY = /(again|still|다시|아직|여전히|또 |same error|not fixed|안 됩니다|안돼|안 되)/i;
const sessions = new Map();
for (const r of rows) {
  const repo = repoOf(r.cwd);
  if (!repo) continue;
  const key = r.session_id;
  const s = sessions.get(key) ?? { sessionId: key, repo, source: r.source, startedAt: Date.parse(r.created_at), promptCount: 0, retries: 0, topic: "", totalLen: 0 };
  s.promptCount++;
  s.totalLen += r.prompt_length ?? 0;
  if (RETRY.test(r.prompt_text ?? "")) s.retries++;
  if (!s.topic) s.topic = (r.prompt_text ?? "").replace(/\s+/g, " ").slice(0, 120);
  sessions.set(key, s);
}

const byRepo = new Map();
for (const s of sessions.values()) byRepo.set(s.repo, [...(byRepo.get(s.repo) ?? []), s]);

const repos = [];
for (const [repo, list] of byRepo) {
  const longest = [...list].sort((a, b) => b.promptCount - a.promptCount)[0];
  const retries = list.reduce((n, s) => n + s.retries, 0);
  const summary = [
    `최근 ${days}일: 세션 ${list.length}개, 프롬프트 ${list.reduce((n, s) => n + s.promptCount, 0)}개 (${[...new Set(list.map((s) => s.source))].join(", ")})`,
    retries ? `재시도로 보이는 프롬프트 ${retries}개 — 실패담 후보` : "재시도 흔적 없음",
    longest ? `가장 긴 세션(${longest.promptCount} 프롬프트) 주제: ${longest.topic}` : "",
  ].filter(Boolean).join("\n");
  repos.push({ repo, summary, sessions: list.slice(0, 50).map(({ sessionId, source, startedAt, promptCount, topic }) => ({ sessionId, source, startedAt, promptCount, topic })) });
}

const client = new ConvexHttpClient(url);
if (process.env.SOMUN_TOKEN) client.setAuth(process.env.SOMUN_TOKEN);
const res = await client.mutation(anyApi.omp.ingestSessions, { repos });
console.log(`omp-sync: ${rows.length} prompts → ${sessions.size} sessions → ${repos.length} repos; inserted ${res.inserted}, attached ${res.attached}`);
