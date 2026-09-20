import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { getOwnerId } from "./owner";

/**
 * oh-my-prompt(omp) 세션 요약 수신. 로컬 omp.db를 읽는 scripts/omp-sync.mjs가 호출한다.
 * 세션은 단독 후보가 되지 않고, 같은 저장소의 열린 후보에 ompSummary 근거로 붙는다.
 */
export const ingestSessions = mutation({
  args: {
    repos: v.array(
      v.object({
        repo: v.string(),
        summary: v.string(),
        sessions: v.array(v.object({ sessionId: v.string(), source: v.string(), startedAt: v.number(), promptCount: v.number(), topic: v.string() })),
      }),
    ),
  },
  handler: async (ctx, { repos }) => {
    const ownerId = await getOwnerId(ctx);
    const sources = await ctx.db.query("sources").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).collect();
    let source = sources.find((s) => s.kind === "omp");
    const sourceId = source?._id ?? (await ctx.db.insert("sources", { ownerId, kind: "omp", config: { targets: ["local"] }, enabled: true }));
    let attached = 0;
    let inserted = 0;
    for (const r of repos) {
      for (const s of r.sessions) {
        const ref = `omp:session:${s.sessionId}`;
        const dup = await ctx.db.query("signals").withIndex("by_owner_ref", (q) => q.eq("ownerId", ownerId).eq("ref", ref)).unique();
        if (dup) continue;
        await ctx.db.insert("signals", { ownerId, sourceId, kind: "omp_session", repo: r.repo, ref, title: s.topic, payload: s, occurredAt: s.startedAt });
        inserted++;
      }
      const open = await ctx.db.query("candidates").withIndex("by_owner_updated", (q) => q.eq("ownerId", ownerId)).order("desc").take(100);
      for (const c of open) {
        if (c.repo !== r.repo || ["dropped", "published"].includes(c.status)) continue;
        await ctx.db.patch(c._id, { evidence: { ...c.evidence, ompSummary: r.summary }, updatedAt: Date.now() });
        attached++;
      }
    }
    await ctx.db.patch(sourceId, { lastPolledAt: Date.now() });
    return { inserted, attached };
  },
});
