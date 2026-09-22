import { asc, eq, inArray, and } from "drizzle-orm";
import { schema } from "../infra/db/index.js";
import { LlmError, modelFor, runLlm, usageProviderOf } from "../infra/llm/providers.js";
import { UsageReporter } from "../infra/usage.js";
import type { JobKind } from "../shared/types.js";
import type { AppContext } from "./context.js";
import { claimJob, completeJob, pendingJobs } from "./jobs.js";
import { getSettings } from "./settings.js";
import { keyPoolOps } from "./keys.js";

/** One leased job at a time per process. HTTP handlers only enqueue. */
export async function processServerJob(ctx: AppContext, signal?: AbortSignal): Promise<boolean> {
  const candidates = ctx.db.select({ ownerId: schema.llmJobs.ownerId }).from(schema.llmJobs)
    .where(and(eq(schema.llmJobs.executor, "server"), inArray(schema.llmJobs.status, ["pending", "claimed"]))).orderBy(asc(schema.llmJobs.id)).all();
  for (const ownerId of new Set(candidates.map((j) => j.ownerId))) {
    const job = pendingJobs(ctx, ownerId, "server")[0];
    if (!job) continue;
    const claim = claimJob(ctx, ownerId, job.id, "server", "server");
    if (!claim.claimToken) continue;
    const candidate = ctx.db.select().from(schema.candidates).where(and(eq(schema.candidates.id, job.candidateId), eq(schema.candidates.ownerId, ownerId))).get();
    if (!candidate || ["dropped", "published"].includes(candidate.status)) {
      completeJob(ctx, ownerId, job.id, { claimToken: claim.claimToken, error: "글감이 삭제·보관·발행되어 생성을 중단했습니다." }, "server");
      return true;
    }
    const started = Date.now(), config = getSettings(ctx, ownerId).llm;
    const base = { userId: UsageReporter.userIdOf(ownerId), occurredAt: new Date(started).toISOString(), provider: usageProviderOf(config.provider, config.baseUrl), model: modelFor(config, job.kind) };
    try {
      const res = await runLlm(config, { system: job.system, user: job.user, schema: JSON.parse(job.schemaJson), schemaName: job.kind === "judge" ? "judgment" : job.kind }, job.kind as JobKind, keyPoolOps(ctx), ctx.env.geminiKeys, signal);
      completeJob(ctx, ownerId, job.id, { claimToken: claim.claimToken, resultJson: JSON.stringify(res.json), model: `${res.provider}/${res.model}${res.keyLabel ? `@${res.keyLabel}` : ""}` }, "server");
      ctx.usage.record({ ...base, provider: usageProviderOf(res.provider, config.baseUrl), model: res.model, apiKeyLabel: res.keyLabel === "byok" ? "user" : res.keyLabel, latencyMs: Date.now() - started, status: "success", inputTokens: res.usage?.inputTokens ?? 0, outputTokens: res.usage?.outputTokens ?? 0, cachedInputTokens: res.usage?.cachedInputTokens ?? 0, totalTokens: res.usage?.totalTokens ?? 0 });
    } catch (err) {
      // Upstream error bodies may echo credentials; persist only a bounded diagnostic.
      const error = err instanceof Error && ["TimeoutError", "AbortError"].includes(err.name)
        ? "생성 제한 시간을 넘겼거나 서버가 종료되었습니다. 다시 시도해 주세요."
        : err instanceof LlmError && err.status ? `모델 요청 실패 (HTTP ${err.status}). 모델 설정과 사용 한도를 확인한 뒤 다시 시도해 주세요.`
        : "생성하지 못했습니다. 모델 설정·API 키·응답 형식을 확인한 뒤 다시 시도해 주세요.";
      completeJob(ctx, ownerId, job.id, { claimToken: claim.claimToken, error }, "server");
      ctx.usage.record({ ...base, latencyMs: Date.now() - started, status: "error", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 });
      ctx.log.warn({ jobId: job.id, error }, "generation failed");
    }
    return true;
  }
  return false;
}

export function startGenerationWorker(ctx: AppContext): { stop: () => Promise<void> } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let running: Promise<void> = Promise.resolve();
  const controller = new AbortController();
  const tick = () => {
    running = (async () => {
      let worked = false;
      try { worked = await processServerJob(ctx, AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)])); }
      catch (err) { ctx.log.error({ err: (err as Error).message }, "generation worker failed"); }
      if (!stopped) timer = setTimeout(tick, worked ? 0 : 1000);
    })();
  };
  timer = setTimeout(tick, 0);
  return { stop: async () => { stopped = true; clearTimeout(timer); controller.abort(); await running; } };
}
