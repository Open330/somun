import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { assertOwned, getOwnerId } from "./owner";
import { channelValidator } from "./schema";
import { lintDraft } from "./lib/lint";
import { CHANNELS } from "./lib/channels";

export const listByCandidate = query({
  args: { candidateId: v.id("candidates") },
  handler: async (ctx, { candidateId }) => {
    const ownerId = await getOwnerId(ctx);
    const c = await ctx.db.get(candidateId);
    assertOwned(c, ownerId, "candidate");
    return await ctx.db.query("drafts").withIndex("by_candidate", (q) => q.eq("candidateId", candidateId)).collect();
  },
});

export const record = internalMutation({
  args: {
    candidateId: v.id("candidates"),
    channel: channelValidator,
    title: v.optional(v.string()),
    body: v.string(),
    model: v.string(),
    bannedPhrases: v.array(v.string()),
  },
  handler: async (ctx, { candidateId, channel, title, body, model, bannedPhrases }) => {
    const c = await ctx.db.get(candidateId);
    if (!c) throw new Error("candidate not found");
    const prev = await ctx.db.query("drafts").withIndex("by_candidate", (q) => q.eq("candidateId", candidateId)).collect();
    const version = prev.filter((d) => d.channel === channel).length + 1;
    const now = Date.now();
    const id = await ctx.db.insert("drafts", {
      ownerId: c.ownerId,
      candidateId,
      channel,
      version,
      title,
      body,
      mediaHint: CHANNELS[channel].mediaHint || undefined,
      lint: lintDraft(channel, title, body, bannedPhrases),
      status: "proposed",
      model,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(candidateId, { status: "drafted", updatedAt: now });
    return id;
  },
});

/**
 * 수정 후 복사. before/after diff를 저장하고, 수정본을 사용자 문체 예시로 승격한다.
 * 같은 채널의 시드 예시는 승인 예시가 5개 이상 쌓이면 비활성화된다.
 */
export const saveEdit = mutation({
  args: { id: v.id("drafts"), title: v.optional(v.string()), body: v.string(), markCopied: v.boolean() },
  handler: async (ctx, { id, title, body, markCopied }) => {
    const ownerId = await getOwnerId(ctx);
    const d = await ctx.db.get(id);
    assertOwned(d, ownerId, "draft");
    const settings = await ctx.db.query("settings").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).unique();
    const changed = d.body !== body || (d.title ?? "") !== (title ?? "");
    const now = Date.now();
    let promotedExampleId = undefined;
    if (changed) {
      promotedExampleId = await ctx.db.insert("examples", {
        ownerId,
        channel: d.channel,
        lang: CHANNELS[d.channel].lang,
        title,
        body,
        source: "edited",
        note: `candidate ${d.candidateId} v${d.version}`,
        active: true,
        createdAt: now,
      });
      await ctx.db.insert("draftEdits", { ownerId, draftId: id, channel: d.channel, before: d.body, after: body, promotedExampleId, createdAt: now });
      await retireSeeds(ctx, ownerId, d.channel);
    } else if (markCopied) {
      // 그대로 복사 = 승인. 승인 예시로 저장.
      await ctx.db.insert("examples", { ownerId, channel: d.channel, lang: CHANNELS[d.channel].lang, title, body, source: "approved", active: true, createdAt: now });
      await retireSeeds(ctx, ownerId, d.channel);
    }
    await ctx.db.patch(id, {
      title,
      body,
      lint: lintDraft(d.channel, title, body, settings?.bannedPhrases),
      status: markCopied ? "copied" : changed ? "edited" : d.status,
      updatedAt: now,
    });
    return { promotedExampleId };
  },
});

async function retireSeeds(ctx: { db: any }, ownerId: string, channel: string) {
  const active = await ctx.db.query("examples").withIndex("by_owner_channel_active", (q: any) => q.eq("ownerId", ownerId).eq("channel", channel).eq("active", true)).collect();
  const own = active.filter((e: any) => e.source !== "seed");
  if (own.length >= 5) for (const s of active.filter((e: any) => e.source === "seed")) await ctx.db.patch(s._id, { active: false });
}

export const drop = mutation({
  args: {
    id: v.id("drafts"),
    reason: v.union(v.literal("wrong_facts"), v.literal("voice"), v.literal("wrong_channel"), v.literal("not_yet"), v.literal("not_worth"), v.literal("other")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { id, reason, note }) => {
    const ownerId = await getOwnerId(ctx);
    const d = await ctx.db.get(id);
    assertOwned(d, ownerId, "draft");
    await ctx.db.patch(id, { status: "dropped", updatedAt: Date.now() });
    await ctx.db.insert("feedback", { ownerId, targetType: "draft", targetId: String(id), reason, note, createdAt: Date.now() });
  },
});

export const examplesFor = internalQuery({
  args: { ownerId: v.string(), channel: channelValidator, limit: v.number() },
  handler: async (ctx, { ownerId, channel, limit }) => {
    const rows = await ctx.db.query("examples").withIndex("by_owner_channel_active", (q) => q.eq("ownerId", ownerId).eq("channel", channel).eq("active", true)).order("desc").take(50);
    // 사용자 예시 우선, 그 다음 시드
    const own = rows.filter((r) => r.source !== "seed");
    const seed = rows.filter((r) => r.source === "seed");
    return [...own, ...seed].slice(0, limit);
  },
});

export const recentFeedback = internalQuery({
  args: { ownerId: v.string(), limit: v.number() },
  handler: async (ctx, { ownerId, limit }) => {
    return await ctx.db.query("feedback").withIndex("by_owner_time", (q) => q.eq("ownerId", ownerId)).order("desc").take(limit);
  },
});
