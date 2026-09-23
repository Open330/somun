import { and, desc, eq } from "drizzle-orm";
import { CHANNELS, enabledTargets, type Channel } from "../core/channels.js";
import { draftLintFacts, lintDraft, unsupportedNumbers } from "../core/lint.js";
import { digestPrompt, draftPrompt, groundingText, judgePrompt, type PromptSpec } from "../core/prompts.js";
import { schema } from "../infra/db/index.js";
import type { Decision, Evidence, GenerationKind, GenerationPlan, JobKind } from "../shared/types.js";
import { getCandidateRow, recentPublishedTitles } from "./candidates.js";
import { emit, GenerationConflictError, type AppContext } from "./context.js";
import { getSettings, styleKeyOf } from "./settings.js";
import { getProfile } from "./profiles.js";
import { alreadyPublished, alreadyTold, recordHighlights } from "./ledger.js";
import { disputedFor, repoDropCount } from "./learning.js";
import { channelResultsForJudge } from "./publications.js";
import { voiceGuideFor } from "../core/voice.js";

/**
 * LLM 파이프라인: 후보 new → digest(원자료→highlights) → judge(highlights만) → draft(채널별).
 * 모든 단계는 큐(llm_jobs)를 거친다. local-agent면 사용자의 워커가, 아니면 서버 워커가 처리한다. 결과 반영은 applyResult 한 곳.
 */

export type Applied = { kind: JobKind; decision?: Decision; total?: number; draftId?: number; highlights?: number };

/** 문체 예시. 내가 복사한 글이 2개 이상이면 그것만(최근 3개), 모자라면 참고 예시로 채운다. */
export function examplesFor(ctx: AppContext, ownerId: string, channel: Channel, lang: string, limit: number) {
  const rows = ctx.db.select().from(schema.examples).where(and(eq(schema.examples.ownerId, ownerId), eq(schema.examples.channel, channel), eq(schema.examples.lang, lang), eq(schema.examples.active, true))).orderBy(desc(schema.examples.createdAt), desc(schema.examples.id)).limit(50).all();
  const own = rows.filter((r) => r.source !== "seed");
  const seed = rows.filter((r) => r.source === "seed");
  const picked = own.length >= 2 ? own.slice(0, Math.min(3, limit)) : [...own, ...seed].slice(0, limit);
  return picked.map((e) => ({ source: e.source, title: e.title ?? undefined, body: e.body }));
}

function recentFeedback(ctx: AppContext, ownerId: string, limit: number) {
  return ctx.db.select().from(schema.feedback).where(eq(schema.feedback.ownerId, ownerId)).orderBy(desc(schema.feedback.createdAt)).limit(limit).all().map((f) => ({ targetType: f.targetType, reason: f.reason, note: f.note ?? undefined }));
}

export function buildPrompt(ctx: AppContext, ownerId: string, kind: JobKind, candidateId: number, channel?: Channel, lang?: string, opts: { instruction?: string } = {}): PromptSpec {
  const row = getCandidateRow(ctx, ownerId, candidateId);
  const c = { title: row.title, type: row.type, evidence: row.evidence as Evidence };
  const settings = getSettings(ctx, ownerId);
  const profile = getProfile(ctx, ownerId, row.repo)?.profile;
  const disputed = disputedFor(ctx, ownerId, row.repo);
  if (kind === "digest") return digestPrompt(c, { profile, alreadyTold: alreadyTold(ctx, ownerId, row.repo, { excludeCandidateId: candidateId }).filter((t) => !disputed.includes(t.text)).map((t) => t.text), disputed });
  if (kind === "judge") return judgePrompt(c, { recentPublished: recentPublishedTitles(ctx, ownerId, 30), enabledChannels: [...new Set(enabledTargets(settings.channelLangs).map((t) => t.channel))], feedback: recentFeedback(ctx, ownerId, 10), profile, alreadyPublished: alreadyPublished(ctx, ownerId, row.repo), repoDrops: repoDropCount(ctx, ownerId, row.repo), channelResults: channelResultsForJudge(ctx, ownerId) });
  if (!channel || !lang) throw new Error("draft needs a channel and a language");
  const judgment = row.latestJudgmentId ? ctx.db.select().from(schema.judgments).where(eq(schema.judgments.id, row.latestJudgmentId)).get() : null;
  const angle = judgment?.angle ?? undefined;
  // 문체는 설정의 프리셋·지침이 정한다. 예시는 켜져 있을 때만 참고로 붙인다. 다시 쓸 때는 직전 판을 보여줘 같은 문장을 반복하지 않게 한다.
  const prev = ctx.db.select().from(schema.drafts).where(and(eq(schema.drafts.candidateId, candidateId), eq(schema.drafts.channel, channel), eq(schema.drafts.lang, lang))).orderBy(desc(schema.drafts.version)).get();
  return draftPrompt(c, channel, lang, settings.voice.useExamples ? examplesFor(ctx, ownerId, channel, lang, 4) : [], angle, {
    guide: voiceGuideFor(settings.voice, lang),
    profile,
    disputed,
    instruction: opts.instruction?.trim() || undefined,
    previous: opts.instruction && prev ? { title: prev.title ?? undefined, body: prev.body } : undefined,
  });
}

/** 자동 재시도 간격과 상한. 모델 쿼터가 풀리길 기다리되, 같은 실패에 비용을 계속 쓰지 않는다. */
export const SWEEP_BACKOFF_MS = 6 * 3600_000;
export const SWEEP_MAX_FAILURES = 3;

/**
 * 아직 판단하지 않은 후보를 태운다. 자동 모드(watch.mode=auto)인 소유자의 것만, 그중 recentDays 안에 갱신된 것만.
 * 다이제스트가 끝난 후보는 판단부터 잇는다(다이제스트를 반복하지 않는다). 최근에 실패했거나 여러 번 실패한 후보는 건너뛴다.
 * 수동 모드에서는 사용자가 고른 것만 judgeCandidates로 태운다.
 */
export async function processNewCandidates(ctx: AppContext, ownerId?: string): Promise<number> {
  const where = ownerId ? and(eq(schema.candidates.status, "new"), eq(schema.candidates.ownerId, ownerId)) : eq(schema.candidates.status, "new");
  const rows = ctx.db.select().from(schema.candidates).where(where).all();
  const settingsByOwner = new Map<string, ReturnType<typeof getSettings>>();
  const now = Date.now();
  let n = 0;
  for (const c of rows) {
    const s = settingsByOwner.get(c.ownerId) ?? getSettings(ctx, c.ownerId);
    settingsByOwner.set(c.ownerId, s);
    if (s.watch.mode !== "auto") continue;
    if (c.updatedAt < now - s.watch.recentDays * 86400e3) continue;
    // 다이제스트 뒤에 새 신호가 합쳐졌으면(updatedAt이 더 늦음) 요약이 낡았으므로 다이제스트부터 다시 한다.
    const digestedAt = (c.evidence as Evidence).highlightsAt;
    const kind: JobKind = digestedAt && c.updatedAt <= digestedAt ? "judge" : "digest";
    const jobs = ctx.db.select({ status: schema.llmJobs.status, finishedAt: schema.llmJobs.finishedAt }).from(schema.llmJobs).where(and(eq(schema.llmJobs.candidateId, c.id), eq(schema.llmJobs.kind, kind))).all();
    if (jobs.some((j) => j.status === "pending" || j.status === "claimed")) continue;
    const failed = jobs.filter((j) => j.status === "failed");
    if (failed.length >= SWEEP_MAX_FAILURES || failed.some((j) => (j.finishedAt ?? 0) > now - SWEEP_BACKOFF_MS)) continue;
    try { queueStep(ctx, c.ownerId, kind, c.id); n++; }
    catch (err) { if (!(err instanceof GenerationConflictError)) throw err; }
  }
  return n;
}

/** 사용자가 고른 후보를 판단한다 (수동 모드의 진입점). 순서대로 돌리고 실패는 건너뛴다. */
export async function judgeCandidates(ctx: AppContext, ownerId: string, ids: number[]): Promise<{ started: number }> {
  let started = 0;
  for (const id of ids) {
    const c = ctx.db.select().from(schema.candidates).where(and(eq(schema.candidates.id, id), eq(schema.candidates.ownerId, ownerId))).get();
    if (!c || ["dropped", "published"].includes(c.status)) continue;
    started++;
    try { queueStep(ctx, ownerId, "digest", id); } catch (e) { ctx.log.warn({ id, err: (e as Error).message }, "judge failed"); }
  }
  return { started };
}

export function queueStep(ctx: AppContext, ownerId: string, kind: JobKind, candidateId: number, channel?: Channel, lang?: string, opts: { instruction?: string; continuation?: GenerationPlan } = {}): number {
  return ctx.db.$client.transaction(() => {
    const c = getCandidateRow(ctx, ownerId, candidateId);
    if (["dropped", "published"].includes(c.status)) throw new GenerationConflictError("보관되거나 발행된 글감은 다시 생성할 수 없습니다. 먼저 글감을 복원해 주세요.");
    const evidence = c.evidence as Evidence;
    if (kind === "draft" && evidence.highlightsAt && !evidence.highlights?.some((text) => text.trim())) throw new GenerationConflictError("알릴 만한 변경 근거가 없습니다. 소스를 추가한 뒤 다시 분석해 주세요.");
    return enqueueJob(ctx, ownerId, kind, candidateId, channel, lang, buildPrompt(ctx, ownerId, kind, candidateId, channel, lang, opts), opts.continuation);
  }).immediate();
}

export function enqueueJob(ctx: AppContext, ownerId: string, kind: JobKind, candidateId: number, channel: Channel | undefined, lang: string | undefined, prompt: PromptSpec, continuation?: GenerationPlan): number {
  const open = ctx.db.select().from(schema.llmJobs).where(eq(schema.llmJobs.candidateId, candidateId)).all()
    .find((j) => j.kind === kind && (j.channel ?? undefined) === channel && (j.lang ?? undefined) === lang && (j.status === "pending" || j.status === "claimed"));
  if (open) {
    if (open.system !== prompt.system || open.user !== prompt.user || JSON.stringify(open.continuation ?? null) !== JSON.stringify(continuation ?? null)) throw new GenerationConflictError("진행 중인 작업이 있습니다. 완료된 뒤 다른 지침으로 다시 요청해 주세요.");
    return open.id;
  }
  const id = Number(ctx.db.insert(schema.llmJobs).values({ ownerId, kind, candidateId, channel: channel ?? null, lang: lang ?? null, system: prompt.system, user: prompt.user, schemaJson: JSON.stringify(prompt.schema), executor: getSettings(ctx, ownerId).llm.provider === "local-agent" ? "local" : "server", continuation: continuation ?? null, status: "pending", createdAt: Date.now() }).run().lastInsertRowid);
  emit(ctx, ownerId, { resource: "jobs", id });
  return id;
}

/** 결과 반영. 다음 단계(판단 → 채널별 초안)는 같은 트랜잭션에서 큐에 넣는다. */
export function applyResult(ctx: AppContext, ownerId: string, args: { kind: GenerationKind; candidateId: number; channel?: Channel; lang?: string; result: unknown; model: string; promptText?: string }, continuation?: GenerationPlan): Applied {
  const c = getCandidateRow(ctx, ownerId, args.candidateId);
  const settings = getSettings(ctx, ownerId);
  const now = Date.now();
  const ev = c.evidence as Evidence;
  const next = (kind: JobKind, channel?: Channel, lang?: string) => enqueueJob(ctx, ownerId, kind, c.id, channel, lang, buildPrompt(ctx, ownerId, kind, c.id, channel, lang));

  if (args.kind === "digest") {
    const r = args.result as { highlights?: unknown; limitations?: unknown };
    const strs = (x: unknown, n: number) => (Array.isArray(x) ? x.filter((h): h is string => typeof h === "string" && h.trim().length > 0).slice(0, n) : []);
    // 요약도 원자료와 맞춰 본다. 원자료에 없는 수치를 담은 요약은 판단·초안에 넘기지 않는다.
    // 기준은 지금의 근거 + 이 다이제스트가 실제로 본 프롬프트. 작업이 대기하는 사이 수집이 근거를 바꿔도 모델이 본 원자료로 맞춰 본다.
    const grounding = [groundingText({ title: c.title, type: c.type, evidence: ev }, getProfile(ctx, ownerId, c.repo)?.profile), args.promptText ?? ""].join("\n\n");
    // 먼저 거르고 나서 8개로 자른다. 앞쪽이 걸러져도 뒤쪽의 근거 있는 요약을 살린다.
    const checked = strs(r.highlights, 20).map((text) => ({ text, numbers: unsupportedNumbers(text, grounding) }));
    const highlights = checked.filter((h) => h.numbers.length === 0).map((h) => h.text).slice(0, 8);
    const unverifiedHighlights = checked.filter((h) => h.numbers.length > 0);
    if (unverifiedHighlights.length) ctx.log.info({ candidateId: c.id, dropped: unverifiedHighlights.length }, "digest highlights with unsupported numbers");
    const fromReadme = Boolean(ev.limitations?.length);
    const limitations = fromReadme ? ev.limitations : strs(r.limitations, 3);
    ctx.db.update(schema.candidates).set({ evidence: { ...ev, highlights, unverifiedHighlights: unverifiedHighlights.length ? unverifiedHighlights : undefined, highlightsAt: now, limitations, limitationsSource: fromReadme ? ev.limitationsSource ?? "readme" : "digest" } as Record<string, unknown>, updatedAt: now }).where(eq(schema.candidates.id, c.id)).run();
    emit(ctx, ownerId, { resource: "candidates", id: c.id });
    recordHighlights(ctx, ownerId, c.repo, c.id, highlights, c.key, now);
    if (continuation) {
      if (highlights.length) for (const t of continuation.targets) queueStep(ctx, ownerId, "draft", c.id, t.channel, t.lang, { instruction: continuation.instruction });
    } else next("judge");
    return { kind: "digest", highlights: highlights.length };
  }

  if (args.kind === "judge") {
    const r = args.result as { scores?: Record<string, unknown>; reasoning?: string; suggestedChannels?: unknown; angle?: string };
    const clamp = (n: unknown) => Math.max(0, Math.min(2, Math.round(Number(n) || 0)));
    const scores = { runnable: clamp(r.scores?.runnable), numbers: clamp(r.scores?.numbers), lesson: clamp(r.scores?.lesson), novelty: clamp(r.scores?.novelty), audience: clamp(r.scores?.audience) };
    const w = settings.rubricWeights;
    const total = scores.runnable * w.runnable + scores.numbers * w.numbers + scores.lesson * w.lesson + scores.novelty * w.novelty + scores.audience * w.audience;
    const noChanges = Boolean(ev.highlightsAt) && !ev.highlights?.some((text) => text.trim());
    const decision: Decision = noChanges ? "ask" : total >= settings.draftThreshold ? "draft" : total >= settings.deferThreshold ? "defer" : "ask";
    const targets = enabledTargets(settings.channelLangs);
    const suggested = (Array.isArray(r.suggestedChannels) ? r.suggestedChannels : []).filter((ch): ch is Channel => targets.some((t) => t.channel === ch));
    const reasoning = noChanges ? "요약에서 알릴 만한 변경 근거를 찾지 못했습니다. 변경 내용이 있는 소스를 추가한 뒤 다시 분석해 주세요." : String(r.reasoning ?? "");
    const angle = noChanges ? null : String(r.angle ?? "").trim() || null;
    const jid = Number(ctx.db.insert(schema.judgments).values({ ownerId, candidateId: c.id, scores, total, reasoning, angle, decision, suggestedChannels: suggested, model: args.model, createdAt: now }).run().lastInsertRowid);
    ctx.db.update(schema.candidates).set({ latestJudgmentId: jid, status: c.status === "drafted" ? "drafted" : decision === "defer" ? "deferred" : "judged", updatedAt: now }).where(eq(schema.candidates.id, c.id)).run();
    emit(ctx, ownerId, { resource: "candidates", id: c.id });
    if (decision === "draft") {
      const picked = suggested.length ? targets.filter((t) => suggested.includes(t.channel)) : targets;
      for (const t of picked) next("draft", t.channel, t.lang);
    }
    return { kind: "judge", decision, total };
  }

  const channel = args.channel, lang = args.lang;
  if (!channel || !lang) throw new Error("draft needs a channel and a language");
  const r = args.result as { title?: string; body?: string };
  const spec = CHANNELS[channel];
  const title = spec.hasTitle ? String(r.title ?? "").trim() || undefined : undefined;
  const body = String(r.body ?? "").trim();
  if (!body) throw new Error("empty draft body");
  const version = ctx.db.select().from(schema.drafts).where(and(eq(schema.drafts.candidateId, c.id), eq(schema.drafts.channel, channel), eq(schema.drafts.lang, lang))).all().length + 1;
  const draftId = Number(ctx.db.insert(schema.drafts).values({ ownerId, candidateId: c.id, channel, lang, version, title: title ?? null, body, mediaHint: spec.mediaHint || null, lint: lintDraft(channel, title, body, settings.bannedPhrases, draftLintFacts({ title: c.title, type: c.type, evidence: ev }, getProfile(ctx, ownerId, c.repo)?.profile)), status: "proposed", model: args.model, voice: settings.voice.preset, styleKey: styleKeyOf(settings.voice), createdAt: now, updatedAt: now }).run().lastInsertRowid);
  ctx.db.update(schema.candidates).set({ status: "drafted", updatedAt: now }).where(eq(schema.candidates.id, c.id)).run();
  emit(ctx, ownerId, { resource: "drafts", id: draftId });
  emit(ctx, ownerId, { resource: "candidates", id: c.id });
  return { kind: "draft", draftId };
}
