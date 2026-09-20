import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { assertOwned, getOwnerId } from "./owner";
import { channelValidator } from "./schema";

export const register = mutation({
  args: { candidateId: v.id("candidates"), draftId: v.optional(v.id("drafts")), channel: channelValidator, url: v.string() },
  handler: async (ctx, { candidateId, draftId, channel, url }) => {
    const ownerId = await getOwnerId(ctx);
    const c = await ctx.db.get(candidateId);
    assertOwned(c, ownerId, "candidate");
    const id = await ctx.db.insert("publications", { ownerId, candidateId, draftId, channel, url, publishedAt: Date.now() });
    await ctx.db.patch(candidateId, { status: "published", updatedAt: Date.now() });
    if (draftId) await ctx.db.patch(draftId, { status: "copied", updatedAt: Date.now() });
    return id;
  },
});

export const setManualStats = mutation({
  args: { id: v.id("publications"), likes: v.optional(v.number()), comments: v.optional(v.number()), reposts: v.optional(v.number()) },
  handler: async (ctx, { id, ...stats }) => {
    const ownerId = await getOwnerId(ctx);
    const p = await ctx.db.get(id);
    assertOwned(p, ownerId, "publication");
    await ctx.db.patch(id, { manualStats: stats });
  },
});

/** 발행물 목록 + 발행 전후 지표. Published 화면용. */
export const listWithMetrics = query({
  args: {},
  handler: async (ctx) => {
    const ownerId = await getOwnerId(ctx);
    const pubs = await ctx.db.query("publications").withIndex("by_owner_time", (q) => q.eq("ownerId", ownerId)).order("desc").take(100);
    const out = [];
    for (const p of pubs) {
      const c = await ctx.db.get(p.candidateId);
      if (!c) continue;
      const snaps = await ctx.db.query("metricSnapshots").withIndex("by_owner_repo_time", (q) => q.eq("ownerId", ownerId).eq("repo", c.repo)).order("desc").take(60);
      const before = snaps.filter((s) => s.at <= p.publishedAt).slice(0, 7);
      const after = snaps.filter((s) => s.at > p.publishedAt);
      const baseline = before[0]?.stars;
      const latest = after[0]?.stars ?? snaps[0]?.stars;
      out.push({ ...p, candidateTitle: c.title, repo: c.repo, baselineStars: baseline, latestStars: latest, series: snaps.slice(0, 30).reverse().map((s) => ({ at: s.at, stars: s.stars, uniques: s.viewsUniques14d, downloads: s.npmDownloadsMonth })) });
    }
    return out;
  },
});
