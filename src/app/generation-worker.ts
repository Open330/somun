import { reserveSharedExecution, SharedQuotaError } from "./shared-quota.js";
import { isBetterRepair } from "../core/draft-repair.js";
import { judgmentTextIssues } from "../core/judgment-text.js";
import { INTRODUCTION_CRITIC_SCHEMA, INTRODUCTION_CRITIC_SYSTEM, INTRODUCTION_EDITOR_SYSTEM, introductionCritiquePrompt, introductionEditPrompt } from "../core/introduction-editor.js";
import { draftPurposeOf } from "../core/prompts.js";
import { asc, eq, inArray, and } from "drizzle-orm";
import { schema } from "../infra/db/index.js";
import { LlmError, modelFor, runLlm } from "../infra/llm/providers.js";
import { recordLlmUsage } from "./llm-usage.js";
import { llmCallOptions } from "./llm-gateway.js";
import { guardsModelEndpoint } from "./net-policy.js";
import { isBlockedError } from "../infra/net.js";
import { localeOf, say } from "./i18n.js";
import type { AppContext } from "./context.js";
import { SIDE_JOB_KINDS } from "../shared/types.js";
import { claimJob, completeJob, pendingJobs } from "./jobs.js";
import { getSettings } from "./settings.js";
import { keyPoolOps, recentUpstreamFailure } from "./keys.js";
import { readSourceExcerptResult } from "./source-excerpt.js";
import { draftIssues, readJobDraft, repairPrompt, repairSchemaJson, SOURCE_EDIT_SYSTEM, worthRepairing } from "./draft-repair.js";
import type { LlmResult } from "../infra/llm/providers.js";
import type { Job } from "../shared/types.js";

/** 자동 보정 상한. 한 번으로는 길이·링크 같은 형식 위반이 남는 일이 잦았다(2026-11-12 실측). 비용 상한을 위해 횟수를 묶는다. */
export const REPAIR_ATTEMPTS = 3;
/** 판단 문장이 깨졌을 때 다시 묻는 횟수. */
export const JUDGMENT_RETRIES = 2;

/**
 * 생성한 초안이 고칠 수 있는 린트에 걸리면, 걸린 내용을 알려 주고 다시 쓰게 한다(최대 REPAIR_ATTEMPTS번).
 * 다시 쓴 쪽이 더 나을 때만 바꾼다. 나아지지 않은 시도는 버리고 가장 나은 판에서 상한까지 다시 시도한다. 남은 위반은 초안의 린트로 화면에 보인다.
 */
async function repairDraft(ctx: AppContext, ownerId: string, job: Job, first: LlmResult, run: (user: string, schemaJson?: string, system?: string) => Promise<LlmResult>): Promise<LlmResult> {
  if (job.sourceExcerpt?.adapted) {
    const selected = readSourceExcerptResult(first.json, job.sourceExcerpt, job.schemaJson);
    job = { ...job, sourceExcerpt: { ...job.sourceExcerpt, sourceBody: selected.sourceBody } };
  }
  let current = first;
  let before = draftIssues(ctx, ownerId, job, first.json, true);
  if (!before?.length || !worthRepairing(ctx, ownerId, job.candidateId)) return first;
  const settings = getSettings(ctx, ownerId);
  const text = (r: LlmResult) => JSON.stringify(readJobDraft(job, r.json, settings.customChannels, settings.bannedPhrases));
  for (let attempt = 1; attempt <= REPAIR_ATTEMPTS && before?.length; attempt++) {
    try {
      const next = await run(repairPrompt(job, current.json, before, settings.customChannels, settings.bannedPhrases), repairSchemaJson(job, current.json), job.sourceExcerpt?.adapted ? SOURCE_EDIT_SYSTEM : undefined);
      const after = draftIssues(ctx, ownerId, job, next.json);
      const better = isBetterRepair(before, after, { before: text(current), after: text(next) });
      ctx.log.info({ jobId: job.id, attempt, before: before.map((l) => l.rule), after: after?.map((l) => l.rule), kept: better ? "repaired" : "previous" }, "draft repair");
      // 모델 출력은 매번 달라서 한 번 나빠졌다고 멈추면 고칠 수 있던 위반이 남는다(2026-11-12 실측). 가장 나은 판에서 상한까지 다시 시도한다.
      if (!better) continue;
      current = next;
      before = after;
    } catch (err) {
      ctx.log.warn({ jobId: job.id, attempt, err: err instanceof Error ? err.message : String(err) }, "draft repair failed; keeping the best draft so far");
      break;
    }
  }
  return current;
}

/** 비평·수정 반복 상한. */
export const INTRODUCTION_CRITIQUE_ROUNDS = 2;

/**
 * 첫 소개(X·Threads)의 비평·수정 단계(core/introduction-editor). 같은 모델이 독립 검토 기준으로 원문과 대조해 문제를 인용해 적고,
 * 그 목록과 남은 형식 위반을 고치게 한다. 그대로 게시할 만하다는 답이 나오거나 상한에 닿으면 멈춘다.
 * 형식 위반이 늘거나 새로 생긴 수정본은 버린다. 원문 발췌를 그대로 옮기는 초안은 고치지 않는다.
 */
async function editIntroduction(ctx: AppContext, ownerId: string, job: Job, current: LlmResult, run: (user: string, schemaJson?: string, system?: string) => Promise<LlmResult>): Promise<LlmResult> {
  if (ctx.env.introductionEditor === false || draftPurposeOf(null, job.user) !== "introduction" || !["x", "threads"].includes(job.channel ?? "") || job.sourceExcerpt) return current;
  const settings = getSettings(ctx, ownerId);
  let before = draftIssues(ctx, ownerId, job, current.json);
  if (before === null) return current;
  for (let round = 1; round <= INTRODUCTION_CRITIQUE_ROUNDS; round++) {
    try {
      const body = readJobDraft(job, current.json, settings.customChannels, settings.bannedPhrases).body;
      const critique = (await run(introductionCritiquePrompt(job.user, body, job.lang ?? "ko"), JSON.stringify(INTRODUCTION_CRITIC_SCHEMA), INTRODUCTION_CRITIC_SYSTEM)).json as { publishable?: unknown; problems?: unknown };
      const problems = (Array.isArray(critique?.problems) ? critique.problems : []).filter((p): p is string => typeof p === "string" && p.trim().length > 0).slice(0, 8);
      const remaining = before.map((issue) => `${issue.rule}${issue.detail ? `: ${issue.detail}` : ""}`);
      ctx.log.info({ jobId: job.id, round, publishable: critique?.publishable === true, problems, lint: before.map((l) => l.rule) }, "introduction critique");
      if (critique?.publishable === true && !problems.length && !before.length) break;
      if (!problems.length && !remaining.length) break;
      const edited = await run(introductionEditPrompt(job.user, body, job.lang ?? "ko", [...problems, ...remaining]), job.schemaJson, INTRODUCTION_EDITOR_SYSTEM);
      const after = draftIssues(ctx, ownerId, job, edited.json);
      const editedBody = after === null ? "" : readJobDraft(job, edited.json, settings.customChannels, settings.bannedPhrases).body;
      const keep = after !== null && editedBody.trim().length > 0 && after.length <= before.length && after.every((issue) => before!.some((b) => b.rule === issue.rule));
      ctx.log.info({ jobId: job.id, round, after: after?.map((l) => l.rule), kept: keep ? "edited" : "previous" }, "introduction edit");
      if (!keep) continue;
      current = edited;
      before = after;
    } catch (err) {
      ctx.log.warn({ jobId: job.id, round, err: err instanceof Error ? err.message : String(err) }, "introduction critique failed; keeping the draft");
      break;
    }
  }
  return current;
}

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
    if (!(SIDE_JOB_KINDS as readonly string[]).includes(job.kind) && (!candidate || (candidate.status === "dropped" || (candidate.status === "published" && job.kind !== "draft" && !(job.kind === "digest" && job.continuation))))) {
      completeJob(ctx, ownerId, job.id, { claimToken: claim.claimToken, error: say(localeOf(ctx, ownerId), "글감이 삭제·보관·발행되어 생성을 중단했습니다.", "Generation stopped because the candidate was deleted, archived, or published.") }, "server");
      return true;
    }
    const settings = getSettings(ctx, ownerId);
    const started = Date.now(), config = settings.llm;
    // lesson은 분석 모델(다이제스트와 같은 기본 모델)로 돌린다.
    // profile 작업은 로컬 워커만 처리하므로(profiles.queueProfile) 여기에는 생성 단계와 lesson만 온다.
    const modelKind = (job.kind === "lesson" ? "digest" : job.kind) as "digest" | "judge" | "draft";
    let mainRecorded = false;
    try {
      const call = (user: string, schemaJson = job.schemaJson, system = job.system, cfg = config) => { reserveSharedExecution(ctx, ownerId, Date.now(), cfg, { background: Boolean(job.background) }); return runLlm(cfg, { system, user, schema: JSON.parse(schemaJson), schemaName: job.kind === "judge" ? "judgment" : job.kind === "lesson" ? "edit_lesson" : job.kind }, modelKind, keyPoolOps(ctx), ctx.env.geminiKeys, signal, { guardBaseUrl: guardsModelEndpoint(ctx, ownerId, cfg), ...llmCallOptions(ctx, ownerId) }); };
      // 본 호출은 끝나는 즉시 기록한다. 뒤의 보정·반영이 실패해도 이미 쓴 호출이 오류로 잘못 남지 않게.
      let res = await call(job.user, repairSchemaJson(job));
      mainRecorded = true;
      recordLlmUsage(ctx, ownerId, config, started, { res });
      // 판단 이유·각도의 글자 깨짐(가나·한자 혼입, 음차)과 각도의 금지어는 다시 생성한다. 횟수를 묶어 비용을 제한한다.
      if (job.kind === "judge") {
        for (let attempt = 1; attempt <= JUDGMENT_RETRIES; attempt++) {
          const r = (res.json ?? {}) as { reasoning?: unknown; angle?: unknown };
          const issues = judgmentTextIssues({ reasoning: String(r.reasoning ?? ""), angle: String(r.angle ?? "") }, settings.ui?.locale === "en" ? "en" : "ko", settings.bannedPhrases);
          if (!issues.length) break;
          ctx.log.info({ jobId: job.id, attempt, issues }, "judgment text retry");
          const t = Date.now();
          try { const retry = await call(`${job.user}\n\n## Fix before returning\nYour previous answer had these problems in reasoning or angle:\n- ${issues.join("\n- ")}\nReturn the full JSON again with the same judgment and clean wording.`); recordLlmUsage(ctx, ownerId, config, t, { res: retry }); res = retry; }
          catch (err) { if (!(err instanceof SharedQuotaError)) recordLlmUsage(ctx, ownerId, config, t, { failedModel: modelFor(config, modelKind), error: err }); break; }
        }
      }
      if (job.kind === "draft" && job.channel && job.lang) {
        const extra = async (user: string, schemaJson?: string, system?: string, cfg = config) => {
          const t = Date.now();
          try { const r = await call(user, schemaJson, system, cfg); recordLlmUsage(ctx, ownerId, cfg, t, { res: r }); return r; }
          catch (err) { if (!(err instanceof SharedQuotaError)) recordLlmUsage(ctx, ownerId, cfg, t, { failedModel: modelFor(cfg, modelKind), error: err }); throw err; }
        };
        // 보정·편집도 같은 모델(~/.agents/AI_API.md: 문장 생성처럼 품질이 값어치를 하는 단계만 3.7-flash). 개인 키·다른 제공사는 사용자가 고른 모델 그대로.
        res = await repairDraft(ctx, ownerId, job, res, extra);
        res = await editIntroduction(ctx, ownerId, job, res, extra);
      }
      completeJob(ctx, ownerId, job.id, { claimToken: claim.claimToken, resultJson: JSON.stringify(res.json), model: `${res.provider}/${res.model}${res.keyLabel ? `@${res.keyLabel}` : ""}` }, "server");
    } catch (err) {
      // Upstream error bodies may echo credentials; persist only a bounded diagnostic.
      const lc = settings.ui?.locale;
      // 제한 시간을 넘긴 원인이 모델의 서버 오류(503 등)였다면 그렇게 알린다. "다시 시도"만으로는 사용자가 기다릴지 모델을 바꿀지 판단할 수 없다.
      const upstream = config.provider === "gemini" && !config.apiKey ? recentUpstreamFailure(ctx, modelFor(config, modelKind)) : undefined;
      const error = err instanceof SharedQuotaError ? err.message : err instanceof Error && ["TimeoutError", "AbortError"].includes(err.name)
        ? upstream
          ? say(lc, `${modelFor(config, modelKind)} 모델이 서버 오류(HTTP ${upstream})로 응답하지 않아 생성 제한 시간을 넘겼습니다. 몇 분 뒤 다시 시도하거나 설정에서 다른 모델을 골라 주세요.`, `${modelFor(config, modelKind)} kept returning a server error (HTTP ${upstream}), so generation timed out. Try again in a few minutes or pick another model in settings.`)
          : say(lc, "생성 제한 시간을 넘겼거나 서버가 종료되었습니다. 다시 시도해 주세요.", "Generation timed out or the server stopped. Please try again.")
        : isBlockedError(err) ? say(lc, "모델 주소(baseUrl)가 사설망·예약 주소를 가리켜 요청하지 않았습니다. 설정에서 공인 주소로 바꿔 주세요.", "The model address (baseUrl) points to a private or reserved network, so no request was sent. Use a public address in settings.")
        : err instanceof LlmError && err.retryAt ? (() => {
          const when = new Date(err.retryAt).toISOString().slice(0, 16).replace("T", " ");
          const reason = err.code === "pool_exhausted"
            ? say(lc, "선택한 공유 모델을 지금 사용할 수 없습니다", "The selected shared model is currently unavailable")
            : err.code === "upstream_unavailable" || (err.status && err.status >= 500 && err.code !== "gateway_busy")
              ? say(lc, "모델 서버가 응답하지 못했습니다", "The model server could not respond")
              : say(lc, "공유 모델 요청이 제한되었습니다", "Shared model requests are temporarily limited");
          return say(lc, `${reason}(${err.code ?? `HTTP ${err.status}`}). ${when} UTC 이후 다시 시도하거나 설정에서 다른 모델 또는 로컬 워커를 선택해 주세요.`, `${reason} (${err.code ?? `HTTP ${err.status}`}). Try again after ${when} UTC, or choose another model or a local worker in settings.`);
        })()
        : err instanceof LlmError && err.status && err.status >= 500 ? say(lc, `모델 서버가 응답하지 못했습니다(HTTP ${err.status}). 잠시 뒤 다시 시도하거나 설정에서 다른 모델 또는 로컬 워커를 선택해 주세요.`, `The model server could not respond (HTTP ${err.status}). Try again later, or choose another model or a local worker in settings.`)
        : err instanceof LlmError && err.status ? say(lc, `모델 요청 실패 (HTTP ${err.status}). 모델 설정과 사용 한도를 확인한 뒤 다시 시도해 주세요.`, `Model request failed (HTTP ${err.status}). Check the model settings and usage limits, then try again.`)
        : say(lc, "생성하지 못했습니다. 모델 설정·API 키·응답 형식을 확인한 뒤 다시 시도해 주세요.", "Generation failed. Check the model settings, API key, and response format, then try again.");
      completeJob(ctx, ownerId, job.id, { claimToken: claim.claimToken, error }, "server");
      if (!mainRecorded && !(err instanceof SharedQuotaError)) recordLlmUsage(ctx, ownerId, config, started, { failedModel: modelFor(config, modelKind), error: err });
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
