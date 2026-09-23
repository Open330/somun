import { asc, eq, inArray, and } from "drizzle-orm";
import { schema } from "../infra/db/index.js";
import { LlmError, modelFor, runLlm } from "../infra/llm/providers.js";
import { recordLlmUsage } from "./llm-usage.js";
import { localeOf, say } from "./i18n.js";
import type { AppContext } from "./context.js";
import { SIDE_JOB_KINDS } from "../shared/types.js";
import { claimJob, completeJob, pendingJobs } from "./jobs.js";
import { getSettings } from "./settings.js";
import { keyPoolOps } from "./keys.js";

/** 직전에 처리한 소유자. 다음 차례는 그 뒤 소유자부터라 한 사람의 대기열이 다른 사람을 막지 않는다. */
const lastServed = new WeakMap<AppContext["db"], string>();

/** One leased job at a time per process, round-robin across owners. HTTP handlers only enqueue. */
export async function processServerJob(ctx: AppContext, signal?: AbortSignal): Promise<boolean> {
  const owners = ctx.db.selectDistinct({ ownerId: schema.llmJobs.ownerId }).from(schema.llmJobs)
    .where(and(eq(schema.llmJobs.executor, "server"), inArray(schema.llmJobs.status, ["pending", "claimed"]))).orderBy(asc(schema.llmJobs.ownerId)).all().map((r) => r.ownerId);
  const last = lastServed.get(ctx.db);
  const start = last === undefined ? 0 : owners.findIndex((o) => o > last);
  const rotated = start <= 0 ? owners : [...owners.slice(start), ...owners.slice(0, start)];
  for (const ownerId of rotated) {
    const job = pendingJobs(ctx, ownerId, "server")[0];
    if (!job) continue;
    const claim = claimJob(ctx, ownerId, job.id, "server", "server");
    if (!claim.claimToken) continue;
    lastServed.set(ctx.db, ownerId);
    const candidate = ctx.db.select().from(schema.candidates).where(and(eq(schema.candidates.id, job.candidateId), eq(schema.candidates.ownerId, ownerId))).get();
    if (!(SIDE_JOB_KINDS as readonly string[]).includes(job.kind) && (!candidate || ["dropped", "published"].includes(candidate.status))) {
      completeJob(ctx, ownerId, job.id, { claimToken: claim.claimToken, error: say(localeOf(ctx, ownerId), "글감이 삭제·보관·발행되어 생성을 중단했습니다.", "Generation stopped because the candidate was deleted, archived, or published.") }, "server");
      return true;
    }
    const started = Date.now(), config = getSettings(ctx, ownerId).llm;
    // lesson은 분석 모델(다이제스트와 같은 기본 모델)로 돌린다.
    // profile 작업은 로컬 워커만 처리하므로(profiles.queueProfile) 여기에는 생성 단계와 lesson만 온다.
    const modelKind = (job.kind === "lesson" ? "digest" : job.kind) as "digest" | "judge" | "draft";
    try {
      const res = await runLlm(config, { system: job.system, user: job.user, schema: JSON.parse(job.schemaJson), schemaName: job.kind === "judge" ? "judgment" : job.kind === "lesson" ? "edit_lesson" : job.kind }, modelKind, keyPoolOps(ctx), ctx.env.geminiKeys, signal);
      completeJob(ctx, ownerId, job.id, { claimToken: claim.claimToken, resultJson: JSON.stringify(res.json), model: `${res.provider}/${res.model}${res.keyLabel ? `@${res.keyLabel}` : ""}` }, "server");
      recordLlmUsage(ctx, ownerId, config, started, { res });
    } catch (err) {
      // Upstream error bodies may echo credentials; persist only a bounded diagnostic.
      const lc = localeOf(ctx, ownerId);
      const error = err instanceof Error && ["TimeoutError", "AbortError"].includes(err.name)
        ? say(lc, "생성 제한 시간을 넘겼거나 서버가 종료되었습니다. 다시 시도해 주세요.", "Generation timed out or the server stopped. Please try again.")
        : err instanceof LlmError && err.status ? say(lc, `모델 요청 실패 (HTTP ${err.status}). 모델 설정과 사용 한도를 확인한 뒤 다시 시도해 주세요.`, `Model request failed (HTTP ${err.status}). Check the model settings and usage limits, then try again.`)
        : say(lc, "생성하지 못했습니다. 모델 설정·API 키·응답 형식을 확인한 뒤 다시 시도해 주세요.", "Generation failed. Check the model settings, API key, and response format, then try again.");
      completeJob(ctx, ownerId, job.id, { claimToken: claim.claimToken, error }, "server");
      recordLlmUsage(ctx, ownerId, config, started, { failedModel: modelFor(config, modelKind) });
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
