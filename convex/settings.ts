import { v } from "convex/values";
import { mutation, query, internalQuery } from "./_generated/server";
import { getOwnerId } from "./owner";
import { channelValidator, llmConfigValidator, rubricScoresValidator } from "./schema";
import { DEFAULT_ENABLED_CHANNELS } from "./lib/channels";
import { DEFAULT_BANNED_PHRASES } from "./lib/lint";
import type { LlmConfig } from "./lib/providers";

export const DEFAULTS = {
  rubricWeights: { runnable: 1, numbers: 1, lesson: 1, novelty: 1, audience: 1 },
  draftThreshold: 6,
  deferThreshold: 4,
  enabledChannels: DEFAULT_ENABLED_CHANNELS,
  bannedPhrases: DEFAULT_BANNED_PHRASES,
  model: "gemini-3.5-flash-lite",
  llm: { provider: "gemini", model: "gemini-3.5-flash-lite" } as LlmConfig,
};

export const get = query({
  args: {},
  handler: async (ctx) => {
    const ownerId = await getOwnerId(ctx);
    const row = await ctx.db.query("settings").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).unique();
    const s = row ?? { ownerId, ...DEFAULTS, updatedAt: 0 };
    const llm: LlmConfig = s.llm ?? DEFAULTS.llm;
    // 키 원문은 화면에 보내지 않는다. 설정 여부와 끝 4자리만.
    return { ...s, llm: { ...llm, apiKey: undefined, apiKeySet: Boolean(llm.apiKey), apiKeyHint: llm.apiKey ? llm.apiKey.slice(-4) : undefined } };
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
    llm: v.optional(llmConfigValidator),
    /** llm을 보낼 때 apiKey를 비우면: true면 기존 키 유지, false면 삭제 */
    keepApiKey: v.optional(v.boolean()),
  },
  handler: async (ctx, { keepApiKey, ...patch }) => {
    const ownerId = await getOwnerId(ctx);
    const existing = await ctx.db.query("settings").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).unique();
    if (patch.llm && !patch.llm.apiKey && keepApiKey && existing?.llm?.apiKey) patch.llm = { ...patch.llm, apiKey: existing.llm.apiKey };
    const clean = Object.fromEntries(Object.entries(patch).filter(([, val]) => val !== undefined));
    if (existing) {
      await ctx.db.patch(existing._id, { ...clean, updatedAt: Date.now() });
      return existing._id;
    }
    return await ctx.db.insert("settings", { ownerId, ...DEFAULTS, ...clean, updatedAt: Date.now() });
  },
});
