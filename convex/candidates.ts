import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { assertOwned, getOwnerId } from "./owner";
import { candidateStatusValidator } from "./schema";

export const inbox = query({
  args: {},
  handler: async (ctx) => {
    const ownerId = await getOwnerId(ctx);
    const rows = await ctx.db.query("candidates").withIndex("by_owner_updated", (q) => q.eq("ownerId", ownerId)).order("desc").take(200);
    const out = [];
    for (const c of rows) {
      const judgment = c.latestJudgmentId ? await ctx.db.get(c.latestJudgmentId) : null;
      out.push({ ...c, judgment });
    }
    return out;
  },
});

export const get = query({
  args: { id: v.id("candidates") },
  handler: async (ctx, { id }) => {
    const ownerId = await getOwnerId(ctx);
    const c = await ctx.db.get(id);
    assertOwned(c, ownerId, "candidate");
    const judgments = await ctx.db.query("judgments").withIndex("by_candidate", (q) => q.eq("candidateId", id)).order("desc").collect();
    const drafts = await ctx.db.query("drafts").withIndex("by_candidate", (q) => q.eq("candidateId", id)).collect();
    const publications = await ctx.db.query("publications").withIndex("by_candidate", (q) => q.eq("candidateId", id)).collect();
    const signals = await ctx.db.query("signals").withIndex("by_owner_repo_time", (q) => q.eq("ownerId", ownerId).eq("repo", c.repo)).order("desc").take(30);
    return { candidate: c, judgments, drafts, publications, signals: signals.filter((s) => s.candidateId === id) };
  },
});

export const setStatus = mutation({
  args: { id: v.id("candidates"), status: candidateStatusValidator },
  handler: async (ctx, { id, status }) => {
    const ownerId = await getOwnerId(ctx);
    const c = await ctx.db.get(id);
    assertOwned(c, ownerId, "candidate");
    await ctx.db.patch(id, { status, updatedAt: Date.now() });
  },
});

/** 판단 오버라이드. 사유는 feedback에도 남는다 (루브릭 조정의 원천). */
export const override = mutation({
  args: {
    id: v.id("candidates"),
    decision: v.union(v.literal("draft"), v.literal("drop")),
    reason: v.union(v.literal("wrong_facts"), v.literal("voice"), v.literal("wrong_channel"), v.literal("not_yet"), v.literal("not_worth"), v.literal("other")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { id, decision, reason, note }) => {
    const ownerId = await getOwnerId(ctx);
    const c = await ctx.db.get(id);
    assertOwned(c, ownerId, "candidate");
    if (c.latestJudgmentId) await ctx.db.patch(c.latestJudgmentId, { overriddenDecision: decision, overrideReason: note ?? reason });
    await ctx.db.insert("feedback", { ownerId, targetType: "judgment", targetId: String(c.latestJudgmentId ?? id), reason, note, createdAt: Date.now() });
    await ctx.db.patch(id, { status: decision === "drop" ? "dropped" : "judged", updatedAt: Date.now() });
    return decision;
  },
});

export const listByStatus = internalQuery({
  args: { status: candidateStatusValidator, ownerId: v.optional(v.string()) },
  handler: async (ctx, { status, ownerId }) => {
    if (ownerId) return await ctx.db.query("candidates").withIndex("by_owner_status", (q) => q.eq("ownerId", ownerId).eq("status", status)).collect();
    const all = await ctx.db.query("candidates").collect();
    return all.filter((c) => c.status === status);
  },
});

export const getInternal = internalQuery({
  args: { id: v.id("candidates") },
  handler: async (ctx, { id }) => await ctx.db.get(id),
});

export const getJudgment = internalQuery({
  args: { id: v.id("judgments") },
  handler: async (ctx, { id }) => await ctx.db.get(id),
});

export const recentPublishedTitles = internalQuery({
  args: { ownerId: v.string(), days: v.number() },
  handler: async (ctx, { ownerId, days }) => {
    const since = Date.now() - days * 24 * 3600 * 1000;
    const pubs = await ctx.db.query("publications").withIndex("by_owner_time", (q) => q.eq("ownerId", ownerId).gte("publishedAt", since)).collect();
    const titles: string[] = [];
    for (const p of pubs) {
      const c = await ctx.db.get(p.candidateId);
      if (c) titles.push(`${c.title} (${p.channel})`);
    }
    return titles;
  },
});

/** 수집 때마다 열린 후보의 기본 사실(스타, 버전, 한계, 커밋 제목 등)을 최신으로. 다이제스트 결과는 지우지 않는다. */
export const refreshEvidence = internalMutation({
  args: { ownerId: v.string(), repo: v.string(), evidence: v.any() },
  handler: async (ctx, { ownerId, repo, evidence }) => {
    const rows = await ctx.db.query("candidates").withIndex("by_owner_updated", (q) => q.eq("ownerId", ownerId)).order("desc").take(100);
    let n = 0;
    for (const c of rows) {
      if (c.repo !== repo || ["dropped", "published"].includes(c.status)) continue;
      const incoming = evidence as Record<string, unknown>;
      const keepLimits = c.evidence.limitations?.length && !(incoming.limitations as string[] | undefined)?.length;
      await ctx.db.patch(c._id, { evidence: { ...c.evidence, ...incoming, limitations: keepLimits ? c.evidence.limitations : (incoming.limitations as string[] | undefined), highlights: c.evidence.highlights, highlightsAt: c.evidence.highlightsAt, ompSummary: c.evidence.ompSummary ?? (incoming.ompSummary as string | undefined) } });
      n++;
    }
    return n;
  },
});
