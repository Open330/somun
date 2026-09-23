/** GitHub REST 최소 클라이언트. 404와 권한 없음(403)은 null, 한도 초과·그 외 실패는 throw. */
const GH = "https://api.github.com";
const TIMEOUT_MS = 20_000;

/** 레이트 리밋. 빈 결과로 취급하면 기존 근거를 지우므로 반드시 던진다. */
export class GitHubRateLimitError extends Error {
  constructor(path: string, readonly resetAt?: number) {
    super(`GitHub rate limit hit on ${path}${resetAt ? ` (reset ${new Date(resetAt).toISOString()})` : ""}`);
  }
}

function rateLimited(res: Response): boolean {
  return res.status === 429 || (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after")));
}

export class GitHubClient {
  constructor(private readonly token: string) {}

  async get<T>(path: string): Promise<T | null> {
    const res = await fetch(`${GH}${path}`, { headers: this.headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (rateLimited(res)) throw new GitHubRateLimitError(path, Number(res.headers.get("x-ratelimit-reset")) * 1000 || undefined);
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) throw new Error(`GitHub ${path} → ${res.status}`);
    return (await res.json()) as T;
  }

  /** commits 엔드포인트의 Link 헤더로 총 커밋 수 추정. 알 수 없으면 undefined. */
  async commitCount(repo: string): Promise<number | undefined> {
    const res = await fetch(`${GH}/repos/${repo}/commits?per_page=1`, { headers: this.headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (rateLimited(res)) throw new GitHubRateLimitError(`/repos/${repo}/commits`);
    if (!res.ok) return undefined;
    const link = res.headers.get("link") ?? "";
    return Number(/page=(\d+)>; rel="last"/.exec(link)?.[1] ?? 1);
  }

  private headers(): Record<string, string> {
    return { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.token}`, "User-Agent": "somun" };
  }
}

export type GhRepo = { full_name: string; description: string | null; html_url: string; homepage: string | null; stargazers_count: number; forks_count: number; language: string | null; license: { spdx_id: string } | null; created_at: string; pushed_at: string; fork: boolean; archived: boolean; private?: boolean };
export type GhRelease = { tag_name: string; name: string; body: string | null; published_at: string; html_url: string };
export type GhPull = { number: number; title: string; merged_at: string | null; html_url: string };
