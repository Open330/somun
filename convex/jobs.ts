import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { assertOwned, getOwnerId } from "./owner";
import { channelValidator } from "./schema";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { CHANNELS, type Channel } from "./lib/channels";
import { lintDraft } from "./lib/lint";

/**
 * LLM 작업 큐와 결과 적용.
 * 프로바이더가 직접 호출한 결과도, 로컬 워커가 돌려준 결과도 같은 apply* 로 들어온다.
 */

const kindValidator = v.union(v.literal("digest"), v.literal("judge"), v.literal("draft"));

export const enqueue = internalMutation({
  args: { ownerId: v.string(), kind: kindValidator, candidateId: v.id("candidates"), channel: v.optional(channelValidator), system: v.string(), user: v.string(), schemaJson: v.string() },
  handler: async (ctx, args) => {
    // 같은 후보·종류·채널의 미처리 작업이 있으면 중복 생성하지 않는다.
    const open = await ctx.db.query("llmJobs").withIndex("by_candidate", (q) => q.eq("candidateId", args.candidateId)).collect();
    const dup = open.find((j) => j.kind === args.kind && j.channel === args.channel && (j.status === "pending" || j.status === "claimed"));
    if (dup) return dup._id;
    return await ctx.db.insert("llmJobs", { ...args, status: "pending", createdAt: Date.now() });
  },
});

/** 워커용: 내 대기 작업. */
export const pending = query({
  args: {},
  handler: async (ctx) => {
    const ownerId = await getOwnerId(ctx);
    return await ctx.db.query("llmJobs").withIndex("by_owner_status", (q) => q.eq("ownerId", ownerId).eq("status", "pending")).take(20);
  },
});

export const claim = mutation({
  args: { id: v.id("llmJobs"), runner: v.string() },
  handler: async (ctx, { id, runner }) => {
    const ownerId = await getOwnerId(ctx);
    const j = await ctx.db.get(id);
    assertOwned(j, ownerId, "job");
    if (j.status !== "pending") return false;
    await ctx.db.patch(id, { status: "claimed", runner, claimedAt: Date.now() });
    return true;
  },
});

export const complete = mutation({
  args: { id: v.id("llmJobs"), resultJson: v.optional(v.string()), error: v.optional(v.string()), model: v.optional(v.string()) },
  handler: async (ctx, { id, resultJson, error, model }) => {
    const ownerId = await getOwnerId(ctx);
    const j = await ctx.db.get(id);
    assertOwned(j, ownerId, "job");
    if (error || !resultJson) {
      await ctx.db.patch(id, { status: "failed", error: error ?? "no result", finishedAt: Date.now() });
      return { applied: false };
    }
    await ctx.db.patch(id, { status: "done", resultJson, finishedAt: Date.now() });
    const label = `local:${j.runner ?? "agent"}${model ? `/${model}` : ""}`;
    await applyResult(ctx, { kind: j.kind, candidateId: j.candidateId, channel: j.channel, result: JSON.parse(resultJson), model: label });
    return { applied: true };
  },
});

export const listForCandidate = internalQuery({
  args: { candidateId: v.id("candidates") },
  handler: async (ctx, { candidateId }) => await ctx.db.query("llmJobs").withIndex("by_candidate", (q) => q.eq("candidateId", candidateId)).collect(),
});

export const apply = internalMutation({
  args: { kind: kindValidator, candidateId: v.id("candidates"), channel: v.optional(channelValidator), resultJson: v.string(), model: v.string() },
  handler: async (ctx, { kind, candidateId, channel, resultJson, model }) => await applyResult(ctx, { kind, candidateId, channel, result: JSON.parse(resultJson), model }),
});

type Applied = { kind: string; decision?: string; total?: number; draftId?: Id<"drafts">; highlights?: number };

/** 결과를 후보에 반영한다. 판단이 "draft"면 초안 작업을 예약한다. */
async function applyResult(ctx: MutationCtx, args: { kind: "digest" | "judge" | "draft"; candidateId: Id<"candidates">; channel?: Channel; result: unknown; model: string }): Promise<Applied> {
  const c = await ctx.db.get(args.candidateId);
  if (!c) throw new Error("candidate not found");
  const settings = (await ctx.db.query("settings").withIndex("by_owner", (q) => q.eq("ownerId", c.ownerId)).unique()) ?? null;
  const now = Date.now();

  if (args.kind === "digest") {
    const r = args.result as { highlights?: unknown; limitations?: unknown };
    const strs = (x: unknown, n: number) => (Array.isArray(x) ? x.filter((h): h is string => typeof h === "string" && h.trim().length > 0).slice(0, n) : []);
    const highlights = strs(r.highlights, 8);
    const found = strs(r.limitations, 3);
    const limitations = c.evidence.limitations?.length ? c.evidence.limitations : found;
    await ctx.db.patch(c._id, { evidence: { ...c.evidence, highlights, highlightsAt: now, limitations }, updatedAt: now });
    // 다이제스트 뒤에는 판단으로 이어진다.
    await ctx.scheduler.runAfter(0, internal.llm.run, { kind: "judge", candidateId: c._id });
    return { kind: "digest", highlights: highlights.length };
  }

  if (args.kind === "judge") {
    const r = args.result as { scores: Record<string, number>; reasoning: string; suggestedChannels: string[]; angle?: string };
    const clamp = (n: unknown) => Math.max(0, Math.min(2, Math.round(Number(n) || 0)));
    const scores = { runnable: clamp(r.scores?.runnable), numbers: clamp(r.scores?.numbers), lesson: clamp(r.scores?.lesson), novelty: clamp(r.scores?.novelty), audience: clamp(r.scores?.audience) };
    const w = settings?.rubricWeights ?? { runnable: 1, numbers: 1, lesson: 1, novelty: 1, audience: 1 };
    const total = scores.runnable * w.runnable + scores.numbers * w.numbers + scores.lesson * w.lesson + scores.novelty * w.novelty + scores.audience * w.audience;
    const draftT = settings?.draftThreshold ?? 6;
    const deferT = settings?.deferThreshold ?? 4;
    const decision = total >= draftT ? "draft" : total >= deferT ? "defer" : "ask";
    const enabled = settings?.enabledChannels ?? ["x_en", "x_ko", "linkedin_ko", "show_hn", "show_gn"];
    const suggested = (Array.isArray(r.suggestedChannels) ? r.suggestedChannels : []).filter((ch): ch is Channel => (enabled as string[]).includes(ch));
    const reasoning = r.angle ? `${r.reasoning}\n\n각도: ${r.angle}` : String(r.reasoning ?? "");
    const jid = await ctx.db.insert("judgments", { ownerId: c.ownerId, candidateId: c._id, scores, total, reasoning, decision, suggestedChannels: suggested, model: args.model, createdAt: now });
    await ctx.db.patch(c._id, { latestJudgmentId: jid, status: decision === "defer" ? "deferred" : "judged", updatedAt: now });
    if (decision === "draft") {
      for (const ch of suggested.length ? suggested : (enabled as Channel[])) await ctx.scheduler.runAfter(0, internal.llm.run, { kind: "draft", candidateId: c._id, channel: ch });
    }
    return { kind: "judge", decision, total };
  }

  // draft
  const channel = args.channel;
  if (!channel) throw new Error("draft needs a channel");
  const r = args.result as { title?: string; body?: string };
  const spec = CHANNELS[channel];
  const title = spec.hasTitle ? String(r.title ?? "").trim() || undefined : undefined;
  const body = String(r.body ?? "").trim();
  if (!body) throw new Error("empty draft body");
  const prev = await ctx.db.query("drafts").withIndex("by_candidate", (q) => q.eq("candidateId", c._id)).collect();
  const version = prev.filter((d) => d.channel === channel).length + 1;
  const draftId = await ctx.db.insert("drafts", {
    ownerId: c.ownerId, candidateId: c._id, channel, version, title, body,
    mediaHint: spec.mediaHint || undefined,
    lint: lintDraft(channel, title, body, settings?.bannedPhrases),
    status: "proposed", model: args.model, createdAt: now, updatedAt: now,
  });
  await ctx.db.patch(c._id, { status: "drafted", updatedAt: now });
  return { kind: "draft", draftId };
}
