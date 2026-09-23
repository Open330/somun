import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { and, asc, eq, gte, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../infra/db/index.js";
import type { Channel, ChangeEvent, Job, JobKind, JobProgress } from "../shared/types.js";
import { emit, GenerationConflictError, NotFoundError, type AppContext } from "./context.js";
import { getCandidateRow } from "./candidates.js";
import { applyResult, enqueueJob } from "./pipeline.js";
import { applyLesson } from "./learning.js";

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
};

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
  const result = ctx.db.$client.transaction(() => {
    const j = ctx.db.select().from(schema.llmJobs).where(and(eq(schema.llmJobs.id, id), eq(schema.llmJobs.ownerId, ownerId))).get();
    if (!j) throw new NotFoundError("job");
    if (j.executor !== executor || j.claimToken !== input.claimToken || j.status !== "claimed" || j.claimedAt === null || j.claimedAt <= Date.now() - JOB_LEASE_MS) return { applied: false };
    const candidate = ctx.db.select().from(schema.candidates).where(and(eq(schema.candidates.id, j.candidateId), eq(schema.candidates.ownerId, ownerId))).get();
    // lesson은 발행 뒤에도 반영한다(수정 후 복사·발행이 가장 흔한 흐름).
    if (!input.error && j.kind !== "lesson" && (!candidate || ["dropped", "published"].includes(candidate.status))) {
      ctx.db.update(schema.llmJobs).set({ status: "failed", error: "글감이 삭제·보관·발행되어 생성 결과를 반영하지 않았습니다.", finishedAt: Date.now() }).where(eq(schema.llmJobs.id, id)).run();
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
      if (j.kind === "lesson") { if (j.draftId) applyLesson({ ...ctx, bus }, ownerId, j.draftId, j.lessonKind === "drop" ? "drop" : "edit", parsed as { rule?: string; category?: string }); }
      else applied = applyResult({ ...ctx, bus }, ownerId, { kind: j.kind as Exclude<JobKind, "lesson">, candidateId: j.candidateId, channel: (j.channel as Channel | null) ?? undefined, lang: j.lang ?? undefined, result: parsed, promptText: j.user, model: executor === "server" ? input.model ?? "server" : `local:${j.runner ?? "agent"}${input.model ? `/${input.model}` : ""}` }, j.continuation ?? undefined);
      // 초안을 이어 쓰려던 다이제스트가 쓸 요약을 남기지 못했으면(원자료에 없는 숫자로 모두 빠진 경우 포함) 실패로 남겨 이유를 보여준다.
      const raw = j.kind === "digest" ? (parsed as { highlights: string[] }).highlights.filter((text) => text.trim()).length : 0;
      const empty = j.kind === "digest" && j.continuation && applied?.highlights === 0;
      const error = !empty ? null : raw > 0 ? "요약에 원자료에서 확인되지 않은 숫자만 있어 초안을 쓰지 않았습니다. 글감의 '원자료에서 확인하지 못해 뺀 요약'을 확인해 주세요." : "알릴 만한 변경 근거가 없습니다. 소스를 추가한 뒤 다시 분석해 주세요.";
      ctx.db.update(schema.llmJobs).set({ status: empty ? "failed" : "done", resultJson: input.resultJson, error, finishedAt: Date.now() }).where(eq(schema.llmJobs.id, id)).run();
    }
    events.push({ ownerId, resource: "jobs", id });
    return { applied: !input.error && Boolean(input.resultJson) };
  }).immediate();
  for (const event of events) emit(ctx, event.ownerId, event);
  return result;
}

/** Safe status DTO: prompts, credentials, results and lease tokens never leave this endpoint. */
export function generationStatus(ctx: AppContext, ownerId: string, candidateId?: number): JobProgress[] {
  if (candidateId !== undefined) getCandidateRow(ctx, ownerId, candidateId);
  recoverExpired(ctx, ownerId, Date.now());
  const rows = ctx.db.select().from(schema.llmJobs).where(and(eq(schema.llmJobs.ownerId, ownerId), ne(schema.llmJobs.kind, "lesson"), candidateId === undefined ? undefined : eq(schema.llmJobs.candidateId, candidateId))).orderBy(sql`${schema.llmJobs.id} desc`).limit(200).all();
  const seen = new Set<string>();
  return rows.filter((r) => { const key = `${r.candidateId}:${r.kind}:${r.channel}:${r.lang}`; if (seen.has(key)) return false; seen.add(key); return true; }).map((r) => ({ id: r.id, candidateId: r.candidateId, kind: r.kind as JobKind, channel: (r.channel ?? undefined) as Channel | undefined, lang: r.lang ?? undefined, executor: r.executor as "local" | "server", status: r.status as JobProgress["status"], error: r.error ?? undefined, createdAt: r.createdAt, finishedAt: r.finishedAt ?? undefined }));
}

export function retryGeneration(ctx: AppContext, ownerId: string, id: number): number {
  return ctx.db.$client.transaction(() => {
    const job = ctx.db.select().from(schema.llmJobs).where(and(eq(schema.llmJobs.id, id), eq(schema.llmJobs.ownerId, ownerId))).get();
    if (!job) throw new NotFoundError("job");
    if (job.status !== "failed") throw new GenerationConflictError("실패한 작업만 다시 시도할 수 있습니다.");
    // lesson은 발행된 글감에도 쓰이고 초안 id가 있어야 반영된다. 같은 입력으로 새 행을 만든다.
    if (job.kind === "lesson") {
      const { id: _id, status: _s, runner: _r, claimToken: _t, attempts: _a, resultJson: _res, error: _e, claimedAt: _c, finishedAt: _f, ...rest } = job;
      void [_id, _s, _r, _t, _a, _res, _e, _c, _f];
      const newId = Number(ctx.db.insert(schema.llmJobs).values({ ...rest, status: "pending", createdAt: Date.now() }).run().lastInsertRowid);
      emit(ctx, ownerId, { resource: "jobs", id: newId });
      return newId;
    }
    const candidate = getCandidateRow(ctx, ownerId, job.candidateId);
    if (["dropped", "published"].includes(candidate.status)) throw new GenerationConflictError("보관되거나 발행된 글감은 다시 생성할 수 없습니다.");
    return enqueueJob(ctx, ownerId, job.kind as JobKind, job.candidateId, (job.channel ?? undefined) as Channel | undefined, job.lang ?? undefined, { system: job.system, user: job.user, schema: JSON.parse(job.schemaJson), schemaName: job.kind }, job.continuation ?? undefined);
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
