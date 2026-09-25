import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { and, asc, eq, gt, gte, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../infra/db/index.js";
import { SIDE_JOB_KINDS, type Channel, type ChangeEvent, type GenerationKind, type Job, type JobKind, type JobProgress } from "../shared/types.js";
import { emit, GenerationConflictError, NotFoundError, type AppContext } from "./context.js";
import { getCandidateRow } from "./candidates.js";
import { applyResult, buildPrompt, enqueueJob, processNewCandidates } from "./pipeline.js";
import { applyLesson } from "./learning.js";
import { applyProfile, pendingProfileJob } from "./profiles.js";
import { localeOf, say } from "./i18n.js";

// CLI execution is limited to 5 minutes; allow another 5 minutes for delivery.
export const JOB_LEASE_MS = 10 * 60_000;
export const MAX_JOB_ATTEMPTS = 3;
const toJob = (r: typeof schema.llmJobs.$inferSelect): Job => ({ id: r.id, kind: r.kind as JobKind, candidateId: r.candidateId, channel: (r.channel as Channel | null) ?? undefined, lang: r.lang ?? undefined, system: r.system, user: r.user, schemaJson: r.schemaJson, status: r.status as Job["status"], runner: r.runner ?? undefined, error: r.error ?? undefined, createdAt: r.createdAt });

const score = z.number().int().min(0).max(2);
const results = {
  digest: z.object({ highlights: z.array(z.string()), limitations: z.array(z.string()).optional() }),
  judge: z.object({ scores: z.object({ runnable: score, numbers: score, lesson: score, novelty: score, audience: score }), reasoning: z.string(), suggestedChannels: z.array(z.string()).optional(), angle: z.string().optional() }),
  draft: z.object({ title: z.string().optional(), body: z.string().trim().min(1) }),
  lesson: z.object({ rule: z.string().optional(), category: z.string().optional() }),
  profile: z.record(z.string(), z.unknown()),
};
const isSideJob = (kind: string) => (SIDE_JOB_KINDS as readonly string[]).includes(kind);

function recoverExpired(ctx: AppContext, ownerId: string, now: number) {
  const expired = and(eq(schema.llmJobs.ownerId, ownerId), eq(schema.llmJobs.status, "claimed"), or(isNull(schema.llmJobs.claimedAt), lte(schema.llmJobs.claimedAt, now - JOB_LEASE_MS)));
  ctx.db.update(schema.llmJobs).set({ status: "failed", error: "worker lease expired; attempt limit reached", finishedAt: now, claimToken: null })
    .where(and(expired, gte(schema.llmJobs.attempts, MAX_JOB_ATTEMPTS))).run();
  ctx.db.update(schema.llmJobs).set({ status: "pending", runner: null, claimedAt: null, claimToken: null })
    .where(and(expired, lt(schema.llmJobs.attempts, MAX_JOB_ATTEMPTS))).run();
}

export function pendingJobs(ctx: AppContext, ownerId: string, executor: "local" | "server" = "local"): Job[] {
  return ctx.db.$client.transaction(() => {
    recoverExpired(ctx, ownerId, Date.now());
    return ctx.db.select().from(schema.llmJobs).where(and(eq(schema.llmJobs.ownerId, ownerId), eq(schema.llmJobs.status, "pending"), eq(schema.llmJobs.executor, executor)))
      .orderBy(asc(schema.llmJobs.createdAt), asc(schema.llmJobs.id)).limit(20).all().map(toJob);
  }).immediate();
}

export function claimJob(ctx: AppContext, ownerId: string, id: number, runner: string, executor: "local" | "server" = "local"): { claimed: boolean; claimToken?: string } {
  const result = ctx.db.$client.transaction(() => {
    const now = Date.now();
    recoverExpired(ctx, ownerId, now);
    const claimToken = randomUUID();
    const r = ctx.db.update(schema.llmJobs).set({ status: "claimed", runner, claimedAt: now, claimToken, attempts: sql`${schema.llmJobs.attempts} + 1` })
      .where(and(eq(schema.llmJobs.id, id), eq(schema.llmJobs.ownerId, ownerId), eq(schema.llmJobs.status, "pending"), eq(schema.llmJobs.executor, executor), lt(schema.llmJobs.attempts, MAX_JOB_ATTEMPTS))).run();
    return r.changes ? { claimed: true, claimToken } : { claimed: false };
  }).immediate();
  if (result.claimed) emit(ctx, ownerId, { resource: "jobs", id });
  return result;
}

export function completeJob(ctx: AppContext, ownerId: string, id: number, input: { claimToken: string; resultJson?: string; error?: string; model?: string }, executor: "local" | "server" = "local"): { applied: boolean } {
  // Publish only committed changes. The next pipeline jobs are persisted in the same transaction.
  const events: (ChangeEvent & { ownerId: string })[] = [];
  const bus = new EventEmitter();
  bus.on("change", (event) => events.push(event));
  let profileApplied = false;
  const result = ctx.db.$client.transaction(() => {
    const j = ctx.db.select().from(schema.llmJobs).where(and(eq(schema.llmJobs.id, id), eq(schema.llmJobs.ownerId, ownerId))).get();
    if (!j) throw new NotFoundError("job");
    if (j.executor !== executor || j.claimToken !== input.claimToken || j.status !== "claimed" || j.claimedAt === null || j.claimedAt <= Date.now() - JOB_LEASE_MS) return { applied: false };
    const candidate = ctx.db.select().from(schema.candidates).where(and(eq(schema.candidates.id, j.candidateId), eq(schema.candidates.ownerId, ownerId))).get();
    // lesson은 발행 뒤에도 반영한다(수정 후 복사·발행이 가장 흔한 흐름).
    if (!input.error && !isSideJob(j.kind) && (!candidate || ["dropped", "published"].includes(candidate.status))) {
      ctx.db.update(schema.llmJobs).set({ status: "failed", error: say(localeOf(ctx, ownerId), "글감이 삭제·보관·발행되어 생성 결과를 반영하지 않았습니다.", "The result was not applied because the candidate was deleted, archived, or published."), finishedAt: Date.now() }).where(eq(schema.llmJobs.id, id)).run();
      events.push({ ownerId, resource: "jobs", id });
      return { applied: false };
    }
    if (input.error || !input.resultJson) {
      ctx.db.update(schema.llmJobs).set({ status: "failed", error: input.error ?? "no result", finishedAt: Date.now() }).where(eq(schema.llmJobs.id, id)).run();
    } else {
      let parsed: unknown;
      try {
        parsed = results[j.kind as JobKind].parse(JSON.parse(input.resultJson));
      } catch {
        ctx.db.update(schema.llmJobs).set({ status: "failed", error: "invalid job result", finishedAt: Date.now() }).where(eq(schema.llmJobs.id, id)).run();
        events.push({ ownerId, resource: "jobs", id });
        return { applied: false };
      }
      let applied: ReturnType<typeof applyResult> | undefined;
      const model = executor === "server" ? input.model ?? "server" : `local:${j.runner ?? "agent"}${input.model ? `/${input.model}` : ""}`;
      if (j.kind === "profile" && !applyProfile({ ...ctx, bus }, ownerId, j.meta ?? {}, parsed, model, j.createdAt)) {
        ctx.db.update(schema.llmJobs).set({ status: "failed", error: "invalid job metadata", finishedAt: Date.now() }).where(eq(schema.llmJobs.id, id)).run();
        events.push({ ownerId, resource: "jobs", id });
        return { applied: false };
      }
      if (j.kind === "profile") profileApplied = true;
      else if (j.kind === "lesson") { if (j.draftId) applyLesson({ ...ctx, bus }, ownerId, j.draftId, j.lessonKind === "drop" ? "drop" : "edit", parsed as { rule?: string; category?: string }); }
      else applied = applyResult({ ...ctx, bus }, ownerId, { kind: j.kind as GenerationKind, candidateId: j.candidateId, channel: (j.channel as Channel | null) ?? undefined, lang: j.lang ?? undefined, result: parsed, promptText: j.user, model }, j.continuation ?? undefined);
      // 초안을 이어 쓰려던 다이제스트가 쓸 요약을 남기지 못했으면(원자료에 없는 숫자로 모두 빠진 경우 포함) 실패로 남겨 이유를 보여준다.
      const raw = j.kind === "digest" ? (parsed as { highlights: string[] }).highlights.filter((text) => text.trim()).length : 0;
      const empty = j.kind === "digest" && j.continuation && applied?.highlights === 0;
      const lc = empty ? localeOf(ctx, ownerId) : "ko";
      const error = !empty ? null : raw > 0
        ? say(lc, "요약에 원자료에서 확인되지 않은 숫자만 있어 초안을 쓰지 않았습니다. 글감의 '원자료에서 확인하지 못해 뺀 요약'을 확인해 주세요.", "No draft was written: every digest line had numbers not found in the raw material. See the digest lines left out on the candidate page.")
        : say(lc, "알릴 만한 변경 근거가 없습니다. 소스를 추가한 뒤 다시 분석해 주세요.", "There is no change worth announcing yet. Add a source and analyze again.");
      ctx.db.update(schema.llmJobs).set({ status: empty ? "failed" : "done", resultJson: input.resultJson, error, finishedAt: Date.now() }).where(eq(schema.llmJobs.id, id)).run();
    }
    events.push({ ownerId, resource: "jobs", id });
    return { applied: !input.error && Boolean(input.resultJson) };
  }).immediate();
  for (const event of events) emit(ctx, event.ownerId, event);
  // 프로필을 기다리던 자동 처리 글감(pipeline.processNewCandidates가 미뤄 둔 것)을 이제 태운다.
  if (profileApplied) void processNewCandidates(ctx, ownerId).catch((err: Error) => ctx.log.warn({ err: err.message }, "sweep after profile failed"));
  return result;
}

/** Safe status DTO: prompts, credentials, results and lease tokens never leave this endpoint. */
export function generationStatus(ctx: AppContext, ownerId: string, candidateId?: number): JobProgress[] {
  if (candidateId !== undefined) getCandidateRow(ctx, ownerId, candidateId);
  recoverExpired(ctx, ownerId, Date.now());
  const rows = ctx.db.select().from(schema.llmJobs).where(and(eq(schema.llmJobs.ownerId, ownerId), ne(schema.llmJobs.kind, "lesson"), candidateId === undefined ? undefined : eq(schema.llmJobs.candidateId, candidateId))).orderBy(sql`${schema.llmJobs.id} desc`).limit(200).all();
  const seen = new Set<string>();
  return rows.filter((r) => { const key = `${r.candidateId}:${r.kind}:${r.channel}:${r.lang}:${r.meta?.repo ?? ""}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .filter((r) => !(r.status === "failed" && supersededAfterFailure(ctx, r))).map((r) => ({ id: r.id, candidateId: r.candidateId, repo: r.meta?.repo, kind: r.kind as JobKind, channel: (r.channel ?? undefined) as Channel | undefined, lang: r.lang ?? undefined, executor: r.executor as "local" | "server", status: r.status as JobProgress["status"], error: r.error ?? undefined, createdAt: r.createdAt, finishedAt: r.finishedAt ?? undefined }));
}

/**
 * 실패 뒤에 같은 결과물이 다른 경로(다른 모델, 서버 생성, 다시 쓰기)로 새로 생겼으면 그 실패는 더 볼 필요가 없다.
 * 가장 최근 작업만 보여 주므로, 작업 기록을 남기지 않는 경로로 만든 결과가 오래된 실패를 가리지 못하던 문제를 막는다.
 */
function supersededAfterFailure(ctx: AppContext, job: typeof schema.llmJobs.$inferSelect): boolean {
  // 실패가 끝난 뒤에 생긴 것만 친다. 실패한 그 작업이 남긴 흔적(빈 다이제스트의 highlightsAt 등)은 제외.
  const since = job.finishedAt ?? job.createdAt;
  if (job.kind === "draft" && job.channel && job.lang) {
    return Boolean(ctx.db.select({ id: schema.drafts.id }).from(schema.drafts).where(and(eq(schema.drafts.ownerId, job.ownerId), eq(schema.drafts.candidateId, job.candidateId), eq(schema.drafts.channel, job.channel), eq(schema.drafts.lang, job.lang), gt(schema.drafts.createdAt, since))).get());
  }
  if (job.kind === "judge") {
    return Boolean(ctx.db.select({ id: schema.judgments.id }).from(schema.judgments).where(and(eq(schema.judgments.candidateId, job.candidateId), gt(schema.judgments.createdAt, since))).get());
  }
  if (job.kind === "digest") {
    const c = ctx.db.select({ evidence: schema.candidates.evidence }).from(schema.candidates).where(eq(schema.candidates.id, job.candidateId)).get();
    return ((c?.evidence as { highlightsAt?: number } | undefined)?.highlightsAt ?? 0) > since;
  }
  return false;
}

export function retryGeneration(ctx: AppContext, ownerId: string, id: number): number {
  return ctx.db.$client.transaction(() => {
    const job = ctx.db.select().from(schema.llmJobs).where(and(eq(schema.llmJobs.id, id), eq(schema.llmJobs.ownerId, ownerId))).get();
    if (!job) throw new NotFoundError("job");
    if (job.status !== "failed") throw new GenerationConflictError(say(localeOf(ctx, ownerId), "실패한 작업만 다시 시도할 수 있습니다.", "Only failed jobs can be retried."));
    // lesson·profile은 글감 상태와 무관하고 draftId·meta가 있어야 반영된다. 같은 입력으로 새 행을 만든다.
    if (isSideJob(job.kind)) {
      // 같은 저장소의 프로필 작업이 이미 대기 중이면 하나만 둔다(늦게 끝난 옛 결과가 덮지 않도록).
      if (job.kind === "profile" && job.meta?.repo && pendingProfileJob(ctx, ownerId, job.meta.repo)) throw new GenerationConflictError(say(localeOf(ctx, ownerId), "이 저장소의 프로필 작업이 이미 대기 중입니다.", "A profile job for this repository is already waiting."));
      const { id: _id, status: _s, runner: _r, claimToken: _t, attempts: _a, resultJson: _res, error: _e, claimedAt: _c, finishedAt: _f, ...rest } = job;
      void [_id, _s, _r, _t, _a, _res, _e, _c, _f];
      const newId = Number(ctx.db.insert(schema.llmJobs).values({ ...rest, status: "pending", createdAt: Date.now() }).run().lastInsertRowid);
      emit(ctx, ownerId, { resource: "jobs", id: newId });
      return newId;
    }
    const candidate = getCandidateRow(ctx, ownerId, job.candidateId);
    if (["dropped", "published"].includes(candidate.status)) throw new GenerationConflictError(say(localeOf(ctx, ownerId), "보관되거나 발행된 글감은 다시 생성할 수 없습니다.", "Archived or published candidates cannot be generated again."));
    // 다이제스트·판단은 지금의 근거와 계정 언어로 다시 만든다. 초안은 요청한 지침이 프롬프트에 들어 있으므로 저장된 것을 그대로 쓴다.
    const prompt = job.kind === "draft" ? { system: job.system, user: job.user, schema: JSON.parse(job.schemaJson), schemaName: job.kind } : buildPrompt(ctx, ownerId, job.kind as JobKind, job.candidateId);
    return enqueueJob(ctx, ownerId, job.kind as JobKind, job.candidateId, (job.channel ?? undefined) as Channel | undefined, job.lang ?? undefined, prompt, job.continuation ?? undefined);
  }).immediate();
}

/**
 * 끝난 작업의 프롬프트·결과 원문을 비운다(행과 상태는 남긴다). 원문이 쌓여 DB와 백업이 커지는 것을 막는다.
 * 실패한 작업은 "다시 시도"가 같은 프롬프트를 쓰므로 그대로 둔다.
 */
export function pruneFinishedJobs(ctx: AppContext, olderThanMs = 14 * 86_400_000): number {
  return ctx.db.update(schema.llmJobs).set({ system: "", user: "", resultJson: null })
    .where(and(eq(schema.llmJobs.status, "done"), lt(schema.llmJobs.finishedAt, Date.now() - olderThanMs), ne(schema.llmJobs.user, ""))).run().changes;
}
