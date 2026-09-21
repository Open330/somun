import { and, desc, eq } from "drizzle-orm";
import { CHANNELS, enabledTargets, type Channel } from "../core/channels.js";
import { lintDraft } from "../core/lint.js";
import { digestPrompt, draftPrompt, judgePrompt, type PromptSpec } from "../core/prompts.js";
import { schema } from "../infra/db/index.js";
import { LlmError, runLlm, usageProviderOf } from "../infra/llm/providers.js";
import { UsageReporter } from "../infra/usage.js";
import type { Decision, Evidence, JobKind } from "../shared/types.js";
import { getCandidateRow, recentPublishedTitles } from "./candidates.js";
import { emit, type AppContext } from "./context.js";
import { keyPoolOps } from "./keys.js";
import { getSettings } from "./settings.js";
import { getProfile } from "./profiles.js";
import { alreadyPublished, alreadyTold, recordHighlights } from "./ledger.js";
import { disputedFor, repoDropCount } from "./learning.js";
import { voiceGuideFor } from "../core/voice.js";

/**
 * LLM 파이프라인: 후보 new → digest(원자료→highlights) → judge(highlights만) → draft(채널별).
 * 프로바이더가 local-agent면 큐(llm_jobs)에 넣고 워커가 처리한다. 결과 반영은 applyResult 한 곳.
 */

export type RunResult = { queued?: true; applied?: Applied; error?: string };
export type Applied = { kind: JobKind; decision?: Decision; total?: number; draftId?: number; highlights?: number };

function examplesFor(ctx: AppContext, ownerId: string, channel: Channel, lang: string, limit: number) {
  const rows = ctx.db.select().from(schema.examples).where(and(eq(schema.examples.ownerId, ownerId), eq(schema.examples.channel, channel), eq(schema.examples.lang, lang), eq(schema.examples.active, true))).orderBy(desc(schema.examples.createdAt)).limit(50).all();
  const own = rows.filter((r) => r.source !== "seed");
  const seed = rows.filter((r) => r.source === "seed");
  return [...own, ...seed].slice(0, limit).map((e) => ({ source: e.source, title: e.title ?? undefined, body: e.body }));
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
  if (kind === "judge") return judgePrompt(c, { recentPublished: recentPublishedTitles(ctx, ownerId, 30), enabledChannels: [...new Set(enabledTargets(settings.channelLangs).map((t) => t.channel))], feedback: recentFeedback(ctx, ownerId, 10), profile, alreadyPublished: alreadyPublished(ctx, ownerId, row.repo), repoDrops: repoDropCount(ctx, ownerId, row.repo) });
  if (!channel || !lang) throw new Error("draft needs a channel and a language");
  const judgment = row.latestJudgmentId ? ctx.db.select().from(schema.judgments).where(eq(schema.judgments.id, row.latestJudgmentId)).get() : null;
  const angle = judgment?.reasoning.split("각도: ")[1]?.trim();
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

/** 한 단계 실행. 직접 프로바이더면 호출 후 반영, local-agent면 큐잉. */
export async function runStep(ctx: AppContext, ownerId: string, kind: JobKind, candidateId: number, channel?: Channel, lang?: string, opts: { instruction?: string } = {}): Promise<RunResult> {
  const settings = getSettings(ctx, ownerId);
  const prompt = buildPrompt(ctx, ownerId, kind, candidateId, channel, lang, opts);
  if (settings.llm.provider === "local-agent") {
    enqueueJob(ctx, ownerId, kind, candidateId, channel, lang, prompt);
    return { queued: true };
  }
  const startedAt = Date.now();
  try {
    const res = await runLlm({ ...settings.llm }, prompt, kind, keyPoolOps(ctx), ctx.env.geminiKeys);
    ctx.usage.record({
      userId: UsageReporter.userIdOf(ownerId), occurredAt: new Date(startedAt).toISOString(), provider: usageProviderOf(res.provider, settings.llm.baseUrl), model: res.model,
      apiKeyLabel: res.keyLabel === "byok" ? "user" : res.keyLabel, latencyMs: res.latencyMs, status: "success",
      inputTokens: res.usage?.inputTokens ?? 0, outputTokens: res.usage?.outputTokens ?? 0, cachedInputTokens: res.usage?.cachedInputTokens ?? 0, totalTokens: res.usage?.totalTokens ?? 0,
    });
    const applied = await applyResult(ctx, ownerId, { kind, candidateId, channel, lang, result: res.json, model: `${res.provider}/${res.model}${res.keyLabel ? `@${res.keyLabel}` : ""}` });
    return { applied };
  } catch (e) {
    ctx.usage.record({ userId: UsageReporter.userIdOf(ownerId), occurredAt: new Date(startedAt).toISOString(), provider: usageProviderOf(settings.llm.provider, settings.llm.baseUrl), model: settings.llm.model ?? "unknown", latencyMs: Date.now() - startedAt, status: "error", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 });
    const msg = e instanceof LlmError ? e.message : String((e as Error).message ?? e);
    ctx.log.error({ kind, candidateId, channel, lang, err: msg }, "llm step failed");
    return { error: msg };
  }
}

/** 새 후보 전부 다이제스트부터. 순차 실행(키 풀과 모델 수요를 아낀다). */
/**
 * 아직 판단하지 않은 후보를 태운다. 자동 모드(watch.mode=auto)인 소유자의 것만, 그중 recentDays 안에 갱신된 것만.
 * 수동 모드에서는 사용자가 고른 것만 judgeCandidates로 태운다.
 */
export async function processNewCandidates(ctx: AppContext, ownerId?: string): Promise<number> {
  const where = ownerId ? and(eq(schema.candidates.status, "new"), eq(schema.candidates.ownerId, ownerId)) : eq(schema.candidates.status, "new");
  const rows = ctx.db.select().from(schema.candidates).where(where).all();
  const settingsByOwner = new Map<string, ReturnType<typeof getSettings>>();
  let n = 0;
  for (const c of rows) {
    const s = settingsByOwner.get(c.ownerId) ?? getSettings(ctx, c.ownerId);
    settingsByOwner.set(c.ownerId, s);
    if (s.watch.mode !== "auto") continue;
    if (c.updatedAt < Date.now() - s.watch.recentDays * 86400e3) continue;
    await runStep(ctx, c.ownerId, "digest", c.id);
    n++;
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
    try { await runStep(ctx, ownerId, "digest", id); } catch (e) { ctx.log.warn({ id, err: (e as Error).message }, "judge failed"); }
  }
  return { started };
}

export function enqueueJob(ctx: AppContext, ownerId: string, kind: JobKind, candidateId: number, channel: Channel | undefined, lang: string | undefined, prompt: PromptSpec): number {
  const open = ctx.db.select().from(schema.llmJobs).where(eq(schema.llmJobs.candidateId, candidateId)).all()
    .find((j) => j.kind === kind && (j.channel ?? undefined) === channel && (j.lang ?? undefined) === lang && (j.status === "pending" || j.status === "claimed"));
  if (open) return open.id;
  const id = Number(ctx.db.insert(schema.llmJobs).values({ ownerId, kind, candidateId, channel: channel ?? null, lang: lang ?? null, system: prompt.system, user: prompt.user, schemaJson: JSON.stringify(prompt.schema), status: "pending", createdAt: Date.now() }).run().lastInsertRowid);
  emit(ctx, ownerId, { resource: "jobs", id });
  return id;
}

/** 결과 반영. 판단이 draft면 채널별 초안을 이어서 실행한다 (await하지 않고 백그라운드). */
export async function applyResult(ctx: AppContext, ownerId: string, args: { kind: JobKind; candidateId: number; channel?: Channel; lang?: string; result: unknown; model: string }): Promise<Applied> {
  const c = getCandidateRow(ctx, ownerId, args.candidateId);
  const settings = getSettings(ctx, ownerId);
  const now = Date.now();
  const ev = c.evidence as Evidence;

  if (args.kind === "digest") {
    const r = args.result as { highlights?: unknown; limitations?: unknown };
    const strs = (x: unknown, n: number) => (Array.isArray(x) ? x.filter((h): h is string => typeof h === "string" && h.trim().length > 0).slice(0, n) : []);
    const highlights = strs(r.highlights, 8);
    const fromReadme = Boolean(ev.limitations?.length);
    const limitations = fromReadme ? ev.limitations : strs(r.limitations, 3);
    ctx.db.update(schema.candidates).set({ evidence: { ...ev, highlights, highlightsAt: now, limitations, limitationsSource: fromReadme ? ev.limitationsSource ?? "readme" : "digest" } as Record<string, unknown>, updatedAt: now }).where(eq(schema.candidates.id, c.id)).run();
    emit(ctx, ownerId, { resource: "candidates", id: c.id });
    recordHighlights(ctx, ownerId, c.repo, c.id, highlights, c.key, now);
    void runStep(ctx, ownerId, "judge", c.id);
    return { kind: "digest", highlights: highlights.length };
  }

  if (args.kind === "judge") {
    const r = args.result as { scores?: Record<string, unknown>; reasoning?: string; suggestedChannels?: unknown; angle?: string };
    const clamp = (n: unknown) => Math.max(0, Math.min(2, Math.round(Number(n) || 0)));
    const scores = { runnable: clamp(r.scores?.runnable), numbers: clamp(r.scores?.numbers), lesson: clamp(r.scores?.lesson), novelty: clamp(r.scores?.novelty), audience: clamp(r.scores?.audience) };
    const w = settings.rubricWeights;
    const total = scores.runnable * w.runnable + scores.numbers * w.numbers + scores.lesson * w.lesson + scores.novelty * w.novelty + scores.audience * w.audience;
    const decision: Decision = total >= settings.draftThreshold ? "draft" : total >= settings.deferThreshold ? "defer" : "ask";
    const targets = enabledTargets(settings.channelLangs);
    const suggested = (Array.isArray(r.suggestedChannels) ? r.suggestedChannels : []).filter((ch): ch is Channel => targets.some((t) => t.channel === ch));
    const reasoning = r.angle ? `${r.reasoning}\n\n각도: ${r.angle}` : String(r.reasoning ?? "");
    const jid = Number(ctx.db.insert(schema.judgments).values({ ownerId, candidateId: c.id, scores, total, reasoning, decision, suggestedChannels: suggested, model: args.model, createdAt: now }).run().lastInsertRowid);
    ctx.db.update(schema.candidates).set({ latestJudgmentId: jid, status: decision === "defer" ? "deferred" : "judged", updatedAt: now }).where(eq(schema.candidates.id, c.id)).run();
    emit(ctx, ownerId, { resource: "candidates", id: c.id });
    if (decision === "draft") {
      const picked = suggested.length ? targets.filter((t) => suggested.includes(t.channel)) : targets;
      void (async () => {
        for (const t of picked) await runStep(ctx, ownerId, "draft", c.id, t.channel, t.lang);
      })();
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
  const draftId = Number(ctx.db.insert(schema.drafts).values({ ownerId, candidateId: c.id, channel, lang, version, title: title ?? null, body, mediaHint: spec.mediaHint || null, lint: lintDraft(channel, title, body, settings.bannedPhrases, { repo: ev.repo, limitations: ev.limitations ?? [] }), status: "proposed", model: args.model, voice: settings.voice.preset, createdAt: now, updatedAt: now }).run().lastInsertRowid);
  ctx.db.update(schema.candidates).set({ status: "drafted", updatedAt: now }).where(eq(schema.candidates.id, c.id)).run();
  emit(ctx, ownerId, { resource: "drafts", id: draftId });
  emit(ctx, ownerId, { resource: "candidates", id: c.id });
  return { kind: "draft", draftId };
}
