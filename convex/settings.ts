import { v } from "convex/values";
import { mutation, query, internalQuery } from "./_generated/server";
import { getOwnerId } from "./owner";
import { channelValidator, rubricScoresValidator } from "./schema";
import { DEFAULT_ENABLED_CHANNELS } from "./lib/channels";
import { DEFAULT_BANNED_PHRASES } from "./lib/lint";

export const DEFAULTS = {
  rubricWeights: { runnable: 1, numbers: 1, lesson: 1, novelty: 1, audience: 1 },
  draftThreshold: 6,
  deferThreshold: 4,
  enabledChannels: DEFAULT_ENABLED_CHANNELS,
  bannedPhrases: DEFAULT_BANNED_PHRASES,
  model: "claude-opus-5",
};

export const get = query({
  args: {},
  handler: async (ctx) => {
    const ownerId = await getOwnerId(ctx);
    const row = await ctx.db.query("settings").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).unique();
    return row ?? { ownerId, ...DEFAULTS, updatedAt: 0 };
  },
});

export const getForOwner = internalQuery({
  args: { ownerId: v.string() },
  handler: async (ctx, { ownerId }) => {
    const row = await ctx.db.query("settings").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).unique();
    return row ?? { ownerId, ...DEFAULTS, updatedAt: 0 };
  },
});

export const update = mutation({
  args: {
    rubricWeights: v.optional(rubricScoresValidator),
    draftThreshold: v.optional(v.number()),
    deferThreshold: v.optional(v.number()),
    enabledChannels: v.optional(v.array(channelValidator)),
    bannedPhrases: v.optional(v.array(v.string())),
    model: v.optional(v.string()),
  },
  handler: async (ctx, patch) => {
    const ownerId = await getOwnerId(ctx);
    const existing = await ctx.db.query("settings").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).unique();
    const clean = Object.fromEntries(Object.entries(patch).filter(([, val]) => val !== undefined));
    if (existing) {
      await ctx.db.patch(existing._id, { ...clean, updatedAt: Date.now() });
      return existing._id;
    }
    return await ctx.db.insert("settings", { ownerId, ...DEFAULTS, ...clean, updatedAt: Date.now() });
  },
});
