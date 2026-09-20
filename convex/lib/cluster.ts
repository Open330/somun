/**
 * 신호를 의미 단위(후보)로 묶는 순수 규칙.
 * 수집기는 signals를 넣고, 이 함수가 어느 후보 키에 속하는지 결정한다.
 */

export type SignalLike = {
  kind:
    | "release"
    | "pr_merged"
    | "repo_created"
    | "readme_changed"
    | "star_milestone"
    | "download_milestone"
    | "blog_post"
    | "omp_session";
  repo: string;
  ref: string;
  occurredAt: number;
  payload: Record<string, unknown>;
};

export type CandidateType = "release" | "new-repo" | "milestone" | "blog" | "in-progress";

export type ClusterKey = { type: CandidateType; key: string; title: string };

const DAY = 24 * 60 * 60 * 1000;

/**
 * 규칙:
 * - release → release:{repo}@{tag}. 그 앞 30일의 pr_merged는 같은 후보에 붙는다.
 * - repo_created / readme_changed(신규 30일 내) → new-repo:{repo}
 * - star_milestone / download_milestone → milestone:{repo}#{metric}-{threshold}
 * - blog_post → blog:{ref}
 * - pr_merged가 릴리스 없이 3일 이상 같은 주제로 이어지면 → in-progress:{repo}:{weekKey}
 * - omp_session은 단독 후보가 되지 않고, 같은 repo·기간의 후보에 근거로만 붙는다.
 */
export function clusterKeyFor(signal: SignalLike, context: { latestReleaseAt?: number; repoCreatedAt?: number; recentPrCount?: number }): ClusterKey | null {
  const { kind, repo, payload } = signal;
  switch (kind) {
    case "release": {
      const tag = String(payload.tag ?? signal.ref);
      return { type: "release", key: `release:${repo}@${tag}`, title: `${repo} ${tag}` };
    }
    case "repo_created":
      return { type: "new-repo", key: `new-repo:${repo}`, title: `새 저장소 ${repo}` };
    case "readme_changed": {
      const isNew = context.repoCreatedAt !== undefined && signal.occurredAt - context.repoCreatedAt < 30 * DAY;
      return isNew ? { type: "new-repo", key: `new-repo:${repo}`, title: `새 저장소 ${repo}` } : null;
    }
    case "star_milestone":
    case "download_milestone": {
      const metric = kind === "star_milestone" ? "stars" : "downloads";
      const threshold = Number(payload.threshold ?? 0);
      return { type: "milestone", key: `milestone:${repo}#${metric}-${threshold}`, title: `${repo} ${metric} ${threshold}` };
    }
    case "blog_post":
      return { type: "blog", key: `blog:${signal.ref}`, title: String(payload.title ?? signal.ref) };
    case "pr_merged": {
      // 릴리스가 최근 30일 내에 있으면 그 릴리스에 붙고, 없으면 진행형 후보로.
      if (context.latestReleaseAt !== undefined && signal.occurredAt - context.latestReleaseAt < 30 * DAY) return null;
      if ((context.recentPrCount ?? 0) < 3) return null;
      const week = weekKey(signal.occurredAt);
      return { type: "in-progress", key: `in-progress:${repo}:${week}`, title: `${repo} 진행 중 (${week})` };
    }
    case "omp_session":
      return null;
  }
}

export function weekKey(ts: number): string {
  const d = new Date(ts);
  const year = d.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const week = Math.floor((ts - start) / (7 * DAY)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** 마일스톤 임계값. 넘어선 가장 큰 값을 돌려준다 (이미 기록된 값보다 클 때만). */
export const STAR_THRESHOLDS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
export const DOWNLOAD_THRESHOLDS = [100, 500, 1000, 5000, 10000, 50000];

export function crossedThreshold(prev: number | undefined, now: number, thresholds: number[]): number | null {
  const p = prev ?? 0;
  let crossed: number | null = null;
  for (const t of thresholds) if (p < t && now >= t) crossed = t;
  return crossed;
}
