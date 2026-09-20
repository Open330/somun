"use node";
import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { getOwnerId } from "./owner";
import { runLlm, type KeyPoolOps, type LlmConfig } from "./lib/providers";
import { digestPrompt, draftPrompt, judgePrompt, type PromptSpec } from "./lib/prompts";
import type { Channel } from "./lib/channels";
import type { Id } from "./_generated/dataModel";

/**
 * LLM 작업 실행기. 종류(digest/judge/draft)별로 프롬프트를 만들고,
 * 설정의 프로바이더가 local-agent면 큐에 넣고, 아니면 바로 호출해서 jobs.apply로 반영한다.
 *
 * 흐름: 후보 new → digest(원자료 → highlights) → judge(highlights만 봄) → draft(채널별)
 */

const kindValidator = v.union(v.literal("digest"), v.literal("judge"), v.literal("draft"));
type Kind = "digest" | "judge" | "draft";
type RunResult = { queued?: boolean; applied?: unknown; error?: string } | null;

async function buildPrompt(ctx: { runQuery: (ref: never, args: never) => Promise<unknown> }, kind: Kind, c: { _id: Id<"candidates">; ownerId: string; title: string; type: string; evidence: Record<string, unknown>; latestJudgmentId?: Id<"judgments"> }, channel: Channel | undefined, settings: { enabledChannels: string[] }): Promise<PromptSpec> {
  const rq = ctx.runQuery as unknown as <T>(ref: unknown, args: unknown) => Promise<T>;
  if (kind === "digest") return digestPrompt(c as never);
  if (kind === "judge") {
    const recentPublished = await rq<string[]>(internal.candidates.recentPublishedTitles, { ownerId: c.ownerId, days: 30 });
    const feedback = await rq<{ targetType: string; reason: string; note?: string }[]>(internal.drafts.recentFeedback, { ownerId: c.ownerId, limit: 10 });
    return judgePrompt(c as never, { recentPublished, enabledChannels: settings.enabledChannels, feedback });
  }
  if (!channel) throw new Error("draft needs a channel");
  const examples = await rq<{ source: string; title?: string; body: string }[]>(internal.drafts.examplesFor, { ownerId: c.ownerId, channel, limit: 4 });
  const judgment = c.latestJudgmentId ? await rq<{ reasoning: string } | null>(internal.candidates.getJudgment, { id: c.latestJudgmentId }) : null;
  const angle = judgment?.reasoning.split("각도: ")[1]?.trim();
  return draftPrompt(c as never, channel, examples, angle);
}

export const run = internalAction({
  args: { kind: kindValidator, candidateId: v.id("candidates"), channel: v.optional(v.string()) },
  handler: async (ctx, { kind, candidateId, channel }): Promise<RunResult> => {
    const c = await ctx.runQuery(internal.candidates.getInternal, { id: candidateId });
    if (!c) return null;
    const settings = await ctx.runQuery(internal.settings.getForOwner, { ownerId: c.ownerId });
    const llm: LlmConfig = settings.llm ?? { provider: "gemini", model: settings.model };
    const prompt = await buildPrompt(ctx as never, kind, c as never, channel as Channel | undefined, settings);
    const ch = channel as Channel | undefined;

    if (llm.provider === "local-agent") {
      await ctx.runMutation(internal.jobs.enqueue, { ownerId: c.ownerId, kind, candidateId, channel: ch, system: prompt.system, user: prompt.user, schemaJson: JSON.stringify(prompt.schema) });
      return { queued: true };
    }
    try {
      const pool: KeyPoolOps = {
        order: (labels) => ctx.runQuery(internal.keys.order, { labels }),
        report: async (r) => { await ctx.runMutation(internal.keys.report, r); },
      };
      const res = await runLlm(llm, prompt, kind, pool);
      const applied = await ctx.runMutation(internal.jobs.apply, { kind, candidateId, channel: ch, resultJson: JSON.stringify(res.json), model: `${res.provider}/${res.model}${res.keyLabel ? `@${res.keyLabel}` : ""}` });
      return { applied };
    } catch (e) {
      console.error(`llm ${kind} for ${candidateId} failed`, e);
      return { error: (e as Error).message };
    }
  },
});

/** 수집 뒤: new 상태 후보를 다이제스트부터 태운다. */
export const judgePending = internalAction({
  args: { ownerId: v.optional(v.string()) },
  handler: async (ctx, { ownerId }): Promise<{ started: number }> => {
    const pending = await ctx.runQuery(internal.candidates.listByStatus, { status: "new", ownerId });
    for (const c of pending) await ctx.scheduler.runAfter(0, internal.llm.run, { kind: "digest", candidateId: c._id });
    return { started: pending.length };
  },
});

/** 화면 버튼: 다시 판단 (다이제스트부터). */
export const rejudge = action({
  args: { candidateId: v.id("candidates") },
  handler: async (ctx, { candidateId }): Promise<RunResult> => {
    const ownerId = await getOwnerId(ctx);
    const c = await ctx.runQuery(internal.candidates.getInternal, { id: candidateId });
    if (!c || c.ownerId !== ownerId) throw new Error("candidate not found");
    return await ctx.runAction(internal.llm.run, { kind: "digest", candidateId });
  },
});

/** 화면 버튼: 특정 채널 초안 (다시) 쓰기. */
export const redraft = action({
  args: { candidateId: v.id("candidates"), channels: v.array(v.string()) },
  handler: async (ctx, { candidateId, channels }): Promise<Record<string, RunResult>> => {
    const ownerId = await getOwnerId(ctx);
    const c = await ctx.runQuery(internal.candidates.getInternal, { id: candidateId });
    if (!c || c.ownerId !== ownerId) throw new Error("candidate not found");
    const out: Record<string, RunResult> = {};
    for (const ch of channels) out[ch] = await ctx.runAction(internal.llm.run, { kind: "draft", candidateId, channel: ch });
    return out;
  },
});
