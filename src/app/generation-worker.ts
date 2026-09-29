import { asc, eq, inArray, and } from "drizzle-orm";
import { schema } from "../infra/db/index.js";
import { LlmError, modelFor, runLlm } from "../infra/llm/providers.js";
import { recordLlmUsage } from "./llm-usage.js";
import { guardsModelEndpoint } from "./net-policy.js";
import { isBlockedError } from "../infra/net.js";
import { localeOf, say } from "./i18n.js";
import type { AppContext } from "./context.js";
import { SIDE_JOB_KINDS } from "../shared/types.js";
import { claimJob, completeJob, pendingJobs } from "./jobs.js";
import { getSettings } from "./settings.js";
import { keyPoolOps } from "./keys.js";
import { lintDraftFor } from "./pipeline.js";
import { CHANNELS } from "../core/channels.js";
import type { LintResult } from "../core/lint.js";
import type { LlmResult } from "../infra/llm/providers.js";
import type { Job } from "../shared/types.js";

/** 모델이 다시 쓰면 고칠 수 있는 린트. 사람이 판단할 일(사실 확인 등)이 아니라 형식·표현·근거 위반이다. */
const REPAIRABLE = new Set(["length", "title_length", "sections", "open_question", "avoid_terms", "no_transliterated_names", "banned_phrases", "paragraphs", "has_link", "preferred_link", "no_exclamation", "no_emoji_bullets", "no_placeholder", "numbers_need_review", "no_invented_limit", "repo_name", "no_vote_request"]);

/**
 * 생성한 초안이 고칠 수 있는 린트에 걸리면, 걸린 내용을 알려 주고 한 번만 다시 쓰게 한다.
 * 약한(대체) 모델이 채널 형식을 자주 놓친다. 다시 쓴 쪽이 더 나을 때만 바꾸고, 실패하면 처음 초안을 그대로 둔다.
 */
async function repairDraft(ctx: AppContext, ownerId: string, job: Job, first: LlmResult, run: (user: string) => Promise<LlmResult>): Promise<LlmResult> {
  const channel = job.channel!;
  const purpose = job.user.includes("\n## First introduction\n") ? "introduction" : "update";
  const read = (res: LlmResult) => {
    const r = (res.json ?? {}) as { title?: unknown; body?: unknown };
    return { title: CHANNELS[channel].hasTitle ? String(r.title ?? "").trim() || undefined : undefined, body: String(r.body ?? "").trim() };
  };
  const issues = (res: LlmResult): LintResult[] | null => {
    const d = read(res);
    return d.body ? lintDraftFor(ctx, ownerId, job.candidateId, channel, d.title, d.body, purpose).filter((l) => !l.ok && REPAIRABLE.has(l.rule)) : null;
  };
  const before = issues(first);
  if (!before?.length) return first;
  // 기다리는 사이 글감을 버렸으면 다시 쓸 이유가 없다(결과는 반영 단계에서 어차피 거절된다).
  const status = ctx.db.select({ status: schema.candidates.status }).from(schema.candidates).where(and(eq(schema.candidates.id, job.candidateId), eq(schema.candidates.ownerId, ownerId))).get()?.status;
  if (!status || status === "dropped") return first;
  const prev = read(first);
  const user = [
    job.user,
    "",
    "## Your previous draft",
    prev.title ? `Title: ${prev.title}` : "",
    prev.body,
    "",
    "## Fix these problems",
    "Rewrite the previous draft so these checks pass. Keep every fact and link from Facts, and change only what is needed.",
    ...before.map((l) => `- ${l.rule}${l.detail ? `: ${l.detail}` : ""}`),
  ].join("\n");
  try {
    const second = await run(user);
    const after = issues(second);
    const better = after !== null && after.length < before.length;
    ctx.log.info({ jobId: job.id, before: before.map((l) => l.rule), after: after?.map((l) => l.rule), kept: better ? "repaired" : "first" }, "draft repair");
    return better ? second : first;
  } catch (err) {
    ctx.log.warn({ jobId: job.id, err: err instanceof Error ? err.message : String(err) }, "draft repair failed; keeping the first draft");
    return first;
  }
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
    try {
      const call = (user: string) => runLlm(config, { system: job.system, user, schema: JSON.parse(job.schemaJson), schemaName: job.kind === "judge" ? "judgment" : job.kind === "lesson" ? "edit_lesson" : job.kind }, modelKind, keyPoolOps(ctx), ctx.env.geminiKeys, signal, { guardBaseUrl: guardsModelEndpoint(ctx, ownerId, config) });
      let res = await call(job.user);
      if (job.kind === "draft" && job.channel && job.lang) {
        res = await repairDraft(ctx, ownerId, job, res, async (user) => {
          const t = Date.now();
          try { const r = await call(user); recordLlmUsage(ctx, ownerId, config, t, { res: r }); return r; }
          catch (err) { recordLlmUsage(ctx, ownerId, config, t, { failedModel: modelFor(config, modelKind) }); throw err; }
        });
      }
      completeJob(ctx, ownerId, job.id, { claimToken: claim.claimToken, resultJson: JSON.stringify(res.json), model: `${res.provider}/${res.model}${res.keyLabel ? `@${res.keyLabel}` : ""}` }, "server");
      recordLlmUsage(ctx, ownerId, config, started, { res });
    } catch (err) {
      // Upstream error bodies may echo credentials; persist only a bounded diagnostic.
      const lc = settings.ui?.locale;
      const error = err instanceof Error && ["TimeoutError", "AbortError"].includes(err.name)
        ? say(lc, "생성 제한 시간을 넘겼거나 서버가 종료되었습니다. 다시 시도해 주세요.", "Generation timed out or the server stopped. Please try again.")
        : isBlockedError(err) ? say(lc, "모델 주소(baseUrl)가 사설망·예약 주소를 가리켜 요청하지 않았습니다. 설정에서 공인 주소로 바꿔 주세요.", "The model address (baseUrl) points to a private or reserved network, so no request was sent. Use a public address in settings.")
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
