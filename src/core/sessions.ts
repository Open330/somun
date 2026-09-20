/**
 * 코딩 에이전트 세션 요약 (순수). 업로더 CLI와 서버가 같은 규칙을 쓴다.
 * 프롬프트 원문은 요약에 들어가지 않는다. 주제는 첫 프롬프트 120자까지만.
 */
export type RawPrompt = { sessionId: string; source: string; cwd: string | null; at: number; text: string };
export type SessionSummary = { sessionId: string; source: string; startedAt: number; promptCount: number; retries: number; topic: string };
export type RepoSessionSummary = { repo: string; summary: string; sessions: SessionSummary[] };

const RETRY = /(again|still|다시|아직|여전히|또 |same error|not fixed|안 됩니다|안돼|안 되|doesn'?t work|not working)/i;

export function groupSessions(prompts: RawPrompt[], repoOf: (cwd: string | null) => string | null, days: number): RepoSessionSummary[] {
  const sessions = new Map<string, SessionSummary & { repo: string }>();
  for (const p of prompts) {
    const repo = repoOf(p.cwd);
    if (!repo || !p.sessionId) continue;
    const s = sessions.get(p.sessionId) ?? { sessionId: p.sessionId, repo, source: p.source, startedAt: p.at, promptCount: 0, retries: 0, topic: "" };
    s.promptCount++;
    if (RETRY.test(p.text)) s.retries++;
    if (!s.topic) s.topic = p.text.replace(/\s+/g, " ").trim().slice(0, 120);
    if (p.at < s.startedAt) s.startedAt = p.at;
    sessions.set(p.sessionId, s);
  }
  const byRepo = new Map<string, (SessionSummary & { repo: string })[]>();
  for (const s of sessions.values()) byRepo.set(s.repo, [...(byRepo.get(s.repo) ?? []), s]);
  return [...byRepo].map(([repo, list]) => {
    const longest = [...list].sort((a, b) => b.promptCount - a.promptCount)[0];
    const retries = list.reduce((n, s) => n + s.retries, 0);
    const sources = [...new Set(list.map((s) => s.source))].join(", ");
    const summary = [
      `최근 ${days}일: 세션 ${list.length}개, 프롬프트 ${list.reduce((n, s) => n + s.promptCount, 0)}개 (${sources})`,
      retries ? `재시도로 보이는 프롬프트 ${retries}개 — 실패담 후보` : "재시도 흔적 없음",
      longest ? `가장 긴 세션(${longest.promptCount} 프롬프트) 주제: ${longest.topic}` : "",
    ].filter(Boolean).join("\n");
    return { repo, summary, sessions: list.slice(0, 50).map(({ sessionId, source, startedAt, promptCount, retries: r, topic }) => ({ sessionId, source, startedAt, promptCount, retries: r, topic })) };
  });
}

/** GitHub 원격 URL → owner/repo. */
export function repoFromRemote(remote: string): string | null {
  return /github\.com[:/]([^/\s]+\/[^/\s.]+)/.exec(remote)?.[1] ?? null;
}
