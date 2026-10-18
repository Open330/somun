import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { conditionCandidates, conditionSources } from "../core/condition-review.js";
import type { EvidenceLike, ProfileLike } from "../core/prompts.js";
import { schema } from "../infra/db/index.js";
import type { ConditionReviewState, Evidence } from "../shared/types.js";
import { emit, GenerationConflictError, NotFoundError, type AppContext } from "./context.js";
import { getProfile } from "./profiles.js";
import { localeOf, say } from "./i18n.js";

type DraftRow = typeof schema.drafts.$inferSelect;
const VERSION = "user-source-confirmation-v1";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** 해시는 실제로 표시/대조하는 자료 전체를 묶는다. 조건 발췌나 모델 요약만 해시하지 않는다. */
export function conditionReviewState(draft: DraftRow, evidence: EvidenceLike, profile?: ProfileLike): ConditionReviewState {
  const material = conditionSources(evidence, profile);
  const sources = conditionCandidates(material);
  const revision = hash({ version: VERSION, ownerId: draft.ownerId, draftId: draft.id, title: draft.title ?? "", body: draft.body,
    material, profile, description: evidence.description, repoUrl: evidence.repoUrl,
    experimental: evidence.experimental, commitSubjects: evidence.commitSubjects, mergedPrTitles: evidence.mergedPrTitles });
  return { required: sources.length > 0, revision, sources,
    ...(sources.length && draft.conditionReview?.revision === revision ? { confirmedAt: draft.conditionReview.reviewedAt } : {}) };
}

export function currentConditionReview(ctx: AppContext, ownerId: string, draft: DraftRow): ConditionReviewState {
  const candidate = ctx.db.select().from(schema.candidates).where(and(eq(schema.candidates.id, draft.candidateId), eq(schema.candidates.ownerId, ownerId))).get();
  if (!candidate) throw new NotFoundError("candidate");
  return conditionReviewState(draft, candidate.evidence as Evidence, getProfile(ctx, ownerId, candidate.repo)?.profile);
}

/** 확인 주체와 대상 해시는 서버에서 결정한다. 오래된 화면·다른 계정·수정 전 확인을 받아들이지 않는다. */
export function confirmDraftConditions(ctx: AppContext, ownerId: string, draftId: number, revision: string, reviewerId = ownerId): ConditionReviewState {
  return ctx.db.$client.transaction(() => {
    const draft = ctx.db.select().from(schema.drafts).where(and(eq(schema.drafts.id, draftId), eq(schema.drafts.ownerId, ownerId))).get();
    if (!draft) throw new NotFoundError("draft");
    const current = currentConditionReview(ctx, ownerId, draft);
    if (current.revision !== revision) throw new GenerationConflictError(say(localeOf(ctx, ownerId), "초안이나 원자료가 바뀌었습니다. 새로 불러와 다시 확인하세요.", "The draft or source material changed. Reload and review it again."));
    if (!current.required) return current;
    const reviewedAt = current.confirmedAt ?? Date.now();
    ctx.db.update(schema.drafts).set({ conditionReview: { revision: current.revision, reviewedAt, reviewedBy: reviewerId } }).where(eq(schema.drafts.id, draftId)).run();
    emit(ctx, ownerId, { resource: "drafts", id: draftId });
    return { ...current, confirmedAt: reviewedAt };
  }).immediate();
}
