/** GitHub REST 최소 클라이언트. 404/403은 null, 그 외 실패는 throw. */
const GH = "https://api.github.com";

export class GitHubClient {
  constructor(private readonly token: string) {}

  async get<T>(path: string): Promise<T | null> {
    const res = await fetch(`${GH}${path}`, { headers: this.headers() });
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) throw new Error(`GitHub ${path} → ${res.status}`);
    return (await res.json()) as T;
  }

  /** commits 엔드포인트의 Link 헤더로 총 커밋 수 추정. */
  async commitCount(repo: string): Promise<number> {
    const res = await fetch(`${GH}/repos/${repo}/commits?per_page=1`, { headers: this.headers() });
    if (!res.ok) return 0;
    const link = res.headers.get("link") ?? "";
    return Number(/page=(\d+)>; rel="last"/.exec(link)?.[1] ?? 1);
  }

  private headers(): Record<string, string> {
    return { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.token}`, "User-Agent": "somun" };
  }
}

export type GhRepo = { full_name: string; description: string | null; html_url: string; homepage: string | null; stargazers_count: number; forks_count: number; language: string | null; license: { spdx_id: string } | null; created_at: string; pushed_at: string; fork: boolean; archived: boolean };
export type GhRelease = { tag_name: string; name: string; body: string | null; published_at: string; html_url: string };
export type GhPull = { number: number; title: string; merged_at: string | null; html_url: string };
