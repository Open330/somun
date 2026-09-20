import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { getOwnerId } from "./owner";
import { channelValidator } from "./schema";

/** seeds/ 디렉터리의 best-practice 코퍼스를 examples(source=seed)로 넣는다. 같은 본문은 다시 넣지 않는다. */
export const importExamples = mutation({
  args: {
    items: v.array(v.object({ channel: channelValidator, lang: v.union(v.literal("ko"), v.literal("en")), title: v.optional(v.string()), body: v.string(), note: v.optional(v.string()) })),
  },
  handler: async (ctx, { items }) => {
    const ownerId = await getOwnerId(ctx);
    const existing = await ctx.db.query("examples").collect();
    const seen = new Set(existing.filter((e) => e.ownerId === ownerId).map((e) => e.body));
    let inserted = 0;
    for (const it of items) {
      if (seen.has(it.body)) continue;
      await ctx.db.insert("examples", { ownerId, ...it, source: "seed", active: true, createdAt: Date.now() });
      seen.add(it.body);
      inserted++;
    }
    return { inserted };
  },
});
