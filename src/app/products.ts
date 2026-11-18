import type { ProductRow } from "../shared/types.js";
import type { AppContext } from "./context.js";
import { listProfiles } from "./profiles.js";

/**
 * 제품 표: 프로필이 있는 저장소마다 승인한 한 줄, 주소, 최근 스타, 마지막 게시, 상태를 한 줄로 모은다.
 * 무엇을 먼저 알릴지 문서·명령을 따로 찾지 않고 고르게 한다. 수치는 가장 최근(만든 시각) 글감의 수집값이다(실시간 아님).
 * 상태: 보관(archived) 프로필은 hold, 승인한 한 줄이 한국어·영어 둘 다 있으면 ready, 아니면 needs_line.
 * 글감 근거(README 원문 등)는 크므로 통째로 읽지 않고, 저장소마다 가장 최근 한 줄의 스타·홈페이지만 SQLite에서 꺼낸다.
 */
export function listProducts(ctx: AppContext, ownerId: string): ProductRow[] {
  const profiles = listProfiles(ctx, ownerId);
  if (!profiles.length) return [];
  const repos = profiles.map((p) => p.repo);
  const marks = repos.map(() => "?").join(",");
  const latest = new Map(
    (
      ctx.db.$client
        .prepare(
          `SELECT repo, id, json_extract(evidence, '$.stars') AS stars, json_extract(evidence, '$.homepage') AS homepage FROM (
        SELECT repo, id, evidence, ROW_NUMBER() OVER (PARTITION BY repo ORDER BY created_at DESC, id DESC) AS rn
        FROM candidates WHERE owner_id = ? AND repo IN (${marks})) WHERE rn = 1`,
        )
        .all(ownerId, ...repos) as { repo: string; id: number; stars: number | null; homepage: string | null }[]
    ).map((r) => [r.repo, r]),
  );
  // 마지막 게시는 저장소마다 한 번에 묶어 센다(프로필마다 게시 기록 전체를 다시 훑지 않게).
  const lastPublished = new Map(
    (
      ctx.db.$client
        .prepare(
          `SELECT c.repo AS repo, MAX(p.published_at) AS at FROM publications p JOIN candidates c ON c.id = p.candidate_id AND c.owner_id = p.owner_id
        WHERE p.owner_id = ? AND c.repo IN (${marks}) GROUP BY c.repo`,
        )
        .all(ownerId, ...repos) as { repo: string; at: number }[]
    ).map((r) => [r.repo, r.at]),
  );
  const rank: Record<ProductRow["status"], number> = { needs_line: 0, ready: 1, hold: 2 };
  return profiles
    .map(({ repo, profile }) => {
      const cand = latest.get(repo);
      const oneLinerKo = profile.oneLinerKo?.trim() || undefined,
        oneLinerEn = profile.oneLinerEn?.trim() || undefined;
      const status: ProductRow["status"] = profile.stage === "archived" ? "hold" : oneLinerKo && oneLinerEn ? "ready" : "needs_line";
      return {
        repo,
        name: profile.naming?.trim() || repo.split("/").at(-1)!,
        oneLinerKo,
        oneLinerEn,
        homepage: cand?.homepage || undefined,
        stars: typeof cand?.stars === "number" ? cand.stars : undefined,
        candidateId: cand?.id,
        lastPublishedAt: lastPublished.get(repo) ?? undefined,
        stage: profile.stage,
        status,
      };
    })
    .sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
}
