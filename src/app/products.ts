import { desc, eq } from "drizzle-orm";
import { schema } from "../infra/db/index.js";
import type { Evidence, ProductRow } from "../shared/types.js";
import type { AppContext } from "./context.js";
import { listProfiles } from "./profiles.js";
import { lastAnnouncedAt } from "./publications.js";

/**
 * 제품 표: 프로필이 있는 저장소마다 승인한 한 줄, 주소, 최근 스타, 마지막 게시, 상태를 한 줄로 모은다.
 * 무엇을 먼저 알릴지 문서·명령을 따로 찾지 않고 고르게 한다. 수치는 가장 최근 글감의 수집값이다(실시간 아님).
 * 상태: 보관(archived) 프로필은 hold, 승인한 한 줄이 한국어·영어 둘 다 있으면 ready, 아니면 needs_line.
 */
export function listProducts(ctx: AppContext, ownerId: string): ProductRow[] {
  const latest = new Map<string, { id: number; evidence: Evidence }>();
  for (const c of ctx.db.select({ id: schema.candidates.id, repo: schema.candidates.repo, evidence: schema.candidates.evidence }).from(schema.candidates).where(eq(schema.candidates.ownerId, ownerId)).orderBy(desc(schema.candidates.id)).all()) {
    if (c.repo && !latest.has(c.repo)) latest.set(c.repo, { id: c.id, evidence: c.evidence as Evidence });
  }
  const rank: Record<ProductRow["status"], number> = { needs_line: 0, ready: 1, hold: 2 };
  return listProfiles(ctx, ownerId)
    .map(({ repo, profile }) => {
      const cand = latest.get(repo);
      const oneLinerKo = profile.oneLinerKo?.trim() || undefined, oneLinerEn = profile.oneLinerEn?.trim() || undefined;
      const status: ProductRow["status"] = profile.stage === "archived" ? "hold" : oneLinerKo && oneLinerEn ? "ready" : "needs_line";
      return {
        repo, name: profile.naming?.trim() || repo.split("/").at(-1)!, oneLinerKo, oneLinerEn,
        homepage: cand?.evidence.homepage || undefined, stars: cand?.evidence.stars, candidateId: cand?.id,
        lastPublishedAt: lastAnnouncedAt(ctx, ownerId, repo), stage: profile.stage, status,
      };
    })
    .sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
}
