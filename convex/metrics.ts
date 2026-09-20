import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const snapshot = internalMutation({
  args: {
    ownerId: v.string(),
    repo: v.string(),
    stars: v.number(),
    forks: v.number(),
    viewsUniques14d: v.optional(v.number()),
    referrers: v.optional(v.array(v.object({ referrer: v.string(), uniques: v.number() }))),
    npmDownloadsMonth: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // 같은 날 두 번 찍지 않는다.
    const last = await ctx.db.query("metricSnapshots").withIndex("by_owner_repo_time", (q) => q.eq("ownerId", args.ownerId).eq("repo", args.repo)).order("desc").first();
    if (last && Date.now() - last.at < 20 * 3600 * 1000) {
      await ctx.db.patch(last._id, { ...args, at: last.at });
      return last._id;
    }
    return await ctx.db.insert("metricSnapshots", { ...args, at: Date.now() });
  },
});

export const lastForRepo = internalQuery({
  args: { ownerId: v.string(), repo: v.string() },
  handler: async (ctx, { ownerId, repo }) =>
    await ctx.db.query("metricSnapshots").withIndex("by_owner_repo_time", (q) => q.eq("ownerId", ownerId).eq("repo", repo)).order("desc").first(),
});
