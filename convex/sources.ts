import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { getOwnerId, assertOwned } from "./owner";

const kindValidator = v.union(v.literal("github"), v.literal("npm"), v.literal("blog"), v.literal("omp"));

export const list = query({
  args: {},
  handler: async (ctx) => {
    const ownerId = await getOwnerId(ctx);
    return await ctx.db.query("sources").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).collect();
  },
});

export const upsert = mutation({
  args: {
    id: v.optional(v.id("sources")),
    kind: kindValidator,
    targets: v.array(v.string()),
    options: v.optional(v.record(v.string(), v.string())),
    enabled: v.boolean(),
  },
  handler: async (ctx, { id, kind, targets, options, enabled }) => {
    const ownerId = await getOwnerId(ctx);
    if (id) {
      const doc = await ctx.db.get(id);
      assertOwned(doc, ownerId, "source");
      await ctx.db.patch(id, { kind, config: { targets, options }, enabled });
      return id;
    }
    return await ctx.db.insert("sources", { ownerId, kind, config: { targets, options }, enabled });
  },
});

export const remove = mutation({
  args: { id: v.id("sources") },
  handler: async (ctx, { id }) => {
    const ownerId = await getOwnerId(ctx);
    const doc = await ctx.db.get(id);
    assertOwned(doc, ownerId, "source");
    await ctx.db.delete(id);
  },
});

/** 크론과 수동 수집이 공유하는 목록. ownerId를 주면 그 소유자 것만. */
export const listEnabled = internalQuery({
  args: { ownerId: v.optional(v.string()), kind: v.optional(kindValidator) },
  handler: async (ctx, { ownerId, kind }) => {
    const rows = ownerId
      ? await ctx.db.query("sources").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).collect()
      : await ctx.db.query("sources").collect();
    return rows.filter((r) => r.enabled && (!kind || r.kind === kind));
  },
});

export const markPolled = internalMutation({
  args: { id: v.id("sources"), error: v.optional(v.string()) },
  handler: async (ctx, { id, error }) => {
    await ctx.db.patch(id, { lastPolledAt: Date.now(), lastError: error });
  },
});
