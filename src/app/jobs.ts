import { and, eq } from "drizzle-orm";
import { schema } from "../infra/db/index.js";
import type { Channel, Job, JobKind } from "../shared/types.js";
import { emit, NotFoundError, type AppContext } from "./context.js";
import { applyResult } from "./pipeline.js";

/** local-agent 워커가 쓰는 큐 API. */
const toJob = (r: typeof schema.llmJobs.$inferSelect): Job => ({ id: r.id, kind: r.kind as JobKind, candidateId: r.candidateId, channel: (r.channel as Channel | null) ?? undefined, lang: r.lang ?? undefined, system: r.system, user: r.user, schemaJson: r.schemaJson, status: r.status as Job["status"], runner: r.runner ?? undefined, error: r.error ?? undefined, createdAt: r.createdAt });

export function pendingJobs(ctx: AppContext, ownerId: string): Job[] {
  return ctx.db.select().from(schema.llmJobs).where(and(eq(schema.llmJobs.ownerId, ownerId), eq(schema.llmJobs.status, "pending"))).limit(20).all().map(toJob);
}

export function claimJob(ctx: AppContext, ownerId: string, id: number, runner: string): boolean {
  const r = ctx.db.update(schema.llmJobs).set({ status: "claimed", runner, claimedAt: Date.now() }).where(and(eq(schema.llmJobs.id, id), eq(schema.llmJobs.ownerId, ownerId), eq(schema.llmJobs.status, "pending"))).run();
  return r.changes > 0;
}

export async function completeJob(ctx: AppContext, ownerId: string, id: number, input: { resultJson?: string; error?: string; model?: string }): Promise<{ applied: boolean }> {
  const j = ctx.db.select().from(schema.llmJobs).where(and(eq(schema.llmJobs.id, id), eq(schema.llmJobs.ownerId, ownerId))).get();
  if (!j) throw new NotFoundError("job");
  if (input.error || !input.resultJson) {
    ctx.db.update(schema.llmJobs).set({ status: "failed", error: input.error ?? "no result", finishedAt: Date.now() }).where(eq(schema.llmJobs.id, id)).run();
    emit(ctx, ownerId, { resource: "jobs", id });
    return { applied: false };
  }
  ctx.db.update(schema.llmJobs).set({ status: "done", resultJson: input.resultJson, finishedAt: Date.now() }).where(eq(schema.llmJobs.id, id)).run();
  await applyResult(ctx, ownerId, { kind: j.kind as JobKind, candidateId: j.candidateId, channel: (j.channel as Channel | null) ?? undefined, lang: j.lang ?? undefined, result: JSON.parse(input.resultJson), model: `local:${j.runner ?? "agent"}${input.model ? `/${input.model}` : ""}` });
  emit(ctx, ownerId, { resource: "jobs", id });
  return { applied: true };
}
