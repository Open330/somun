import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { assertOwned, getOwnerId } from "./owner";
import { channelValidator } from "./schema";

export const list = query({
  args: { channel: v.optional(channelValidator) },
  handler: async (ctx, { channel }) => {
    const ownerId = await getOwnerId(ctx);
    if (channel) {
      const rows = await ctx.db.query("examples").withIndex("by_owner_channel_active", (q) => q.eq("ownerId", ownerId).eq("channel", channel)).collect();
      return rows;
    }
    const all = await ctx.db.query("examples").collect();
    return all.filter((e) => e.ownerId === ownerId);
  },
});

export const add = mutation({
  args: { channel: channelValidator, lang: v.union(v.literal("ko"), v.literal("en")), title: v.optional(v.string()), body: v.string(), note: v.optional(v.string()), source: v.optional(v.union(v.literal("seed"), v.literal("approved"))) },
  handler: async (ctx, { channel, lang, title, body, note, source }) => {
    const ownerId = await getOwnerId(ctx);
    return await ctx.db.insert("examples", { ownerId, channel, lang, title, body, note, source: source ?? "approved", active: true, createdAt: Date.now() });
  },
});

export const setActive = mutation({
  args: { id: v.id("examples"), active: v.boolean() },
  handler: async (ctx, { id, active }) => {
    const ownerId = await getOwnerId(ctx);
    const e = await ctx.db.get(id);
    assertOwned(e, ownerId, "example");
    await ctx.db.patch(id, { active });
  },
});

export const remove = mutation({
  args: { id: v.id("examples") },
  handler: async (ctx, { id }) => {
    const ownerId = await getOwnerId(ctx);
    const e = await ctx.db.get(id);
    assertOwned(e, ownerId, "example");
    await ctx.db.delete(id);
  },
});
