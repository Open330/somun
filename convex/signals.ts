import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { clusterKeyFor, type SignalLike } from "./lib/cluster";

const signalKind = v.union(
  v.literal("release"),
  v.literal("pr_merged"),
  v.literal("repo_created"),
  v.literal("readme_changed"),
  v.literal("star_milestone"),
  v.literal("download_milestone"),
  v.literal("blog_post"),
  v.literal("omp_session"),
);

/**
 * 신호 저장 + 후보 묶기. 같은 ref는 한 번만 저장한다.
 * 후보가 새로 생기면 status "new"로 두고, 판단은 llm.judgePending이 가져간다.
 */
export const ingest = internalMutation({
  args: {
    ownerId: v.string(),
    sourceId: v.id("sources"),
    signals: v.array(
      v.object({
        kind: signalKind,
        repo: v.string(),
        ref: v.string(),
        title: v.string(),
        payload: v.any(),
        occurredAt: v.number(),
      }),
    ),
    context: v.object({
      latestReleaseAt: v.optional(v.number()),
      repoCreatedAt: v.optional(v.number()),
      recentPrCount: v.optional(v.number()),
    }),
    evidence: v.any(),
  },
  handler: async (ctx, { ownerId, sourceId, signals, context, evidence }) => {
    let inserted = 0;
    const touched = new Set<string>();
    for (const s of signals) {
      const dup = await ctx.db.query("signals").withIndex("by_owner_ref", (q) => q.eq("ownerId", ownerId).eq("ref", s.ref)).unique();
      if (dup) continue;
      const cluster = clusterKeyFor(s as SignalLike, context);
      let candidateId = undefined;
      if (cluster) {
        let existing = await ctx.db.query("candidates").withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", cluster.key)).unique();
        const now = Date.now();
        // 연속 릴리스 병합: 같은 저장소의 열린 릴리스 후보가 10일 안에 있으면 새 후보 대신 그것을 최신 버전으로 갱신한다.
        if (!existing && cluster.type === "release") {
          const recent = await ctx.db.query("candidates").withIndex("by_owner_updated", (q) => q.eq("ownerId", ownerId)).order("desc").take(50);
          const mergeable = recent.find((c) => c.repo === s.repo && c.type === "release" && !["published", "dropped"].includes(c.status) && now - c.createdAt < 10 * 24 * 3600 * 1000);
          if (mergeable) {
            existing = mergeable;
            await ctx.db.patch(mergeable._id, { title: cluster.title, key: cluster.key });
          }
        }
        if (existing) {
          candidateId = existing._id;
          await ctx.db.patch(existing._id, { evidence: { ...existing.evidence, ...evidence }, updatedAt: now });
        } else {
          candidateId = await ctx.db.insert("candidates", {
            ownerId,
            type: cluster.type,
            title: cluster.title,
            repo: s.repo,
            key: cluster.key,
            evidence,
            status: "new",
            createdAt: now,
            updatedAt: now,
          });
        }
        touched.add(cluster.key);
      }
      await ctx.db.insert("signals", { ownerId, sourceId, ...s, candidateId });
      inserted++;
    }
    // 릴리스 후보에 직전 30일 PR을 붙인다 (릴리스 신호가 나중에 도착해도 동작).
    for (const key of touched) {
      if (!key.startsWith("release:")) continue;
      const cand = await ctx.db.query("candidates").withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", key)).unique();
      if (!cand) continue;
      const orphans = await ctx.db.query("signals").withIndex("by_owner_unassigned", (q) => q.eq("ownerId", ownerId).eq("candidateId", undefined)).collect();
      const titles: string[] = [];
      for (const o of orphans) {
        if (o.repo !== cand.repo || o.kind !== "pr_merged") continue;
        if (cand.updatedAt - o.occurredAt > 30 * 24 * 3600 * 1000) continue;
        await ctx.db.patch(o._id, { candidateId: cand._id });
        titles.push(o.title);
      }
      if (titles.length) {
        await ctx.db.patch(cand._id, { evidence: { ...cand.evidence, mergedPrTitles: [...(cand.evidence.mergedPrTitles ?? []), ...titles].slice(-20) } });
      }
    }
    return { inserted, candidates: [...touched] };
  },
});

export const latestForRepo = internalQuery({
  args: { ownerId: v.string(), repo: v.string() },
  handler: async (ctx, { ownerId, repo }) => {
    const rows = await ctx.db.query("signals").withIndex("by_owner_repo_time", (q) => q.eq("ownerId", ownerId).eq("repo", repo)).order("desc").take(50);
    const latestRelease = rows.find((r) => r.kind === "release");
    const recentPrCount = rows.filter((r) => r.kind === "pr_merged" && Date.now() - r.occurredAt < 7 * 24 * 3600 * 1000).length;
    const lastStar = rows.find((r) => r.kind === "star_milestone");
    const lastDownload = rows.find((r) => r.kind === "download_milestone");
    return {
      latestReleaseAt: latestRelease?.occurredAt,
      recentPrCount,
      lastStarThreshold: lastStar ? Number((lastStar.payload as { threshold?: number }).threshold ?? 0) : undefined,
      lastDownloadThreshold: lastDownload ? Number((lastDownload.payload as { threshold?: number }).threshold ?? 0) : undefined,
    };
  },
});
