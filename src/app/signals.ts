import { and, desc, eq, isNull } from "drizzle-orm";
import { clusterKeyFor, type SignalLike } from "../core/cluster.js";
import { schema } from "../infra/db/index.js";
import type { Evidence, SignalKind } from "../shared/types.js";
import { emit, type AppContext } from "./context.js";

const DAY = 24 * 3600 * 1000;

export type IncomingSignal = { kind: SignalKind; repo: string; ref: string; title: string; payload: Record<string, unknown>; occurredAt: number };
export type ClusterContext = { latestReleaseAt?: number; repoCreatedAt?: number; recentPrCount?: number };

/** 신호 저장 + 후보 묶기. 같은 ref는 한 번만. 연속 릴리스는 10일 내 열린 릴리스 후보에 병합. */
export function ingestSignals(ctx: AppContext, ownerId: string, sourceId: number, incoming: IncomingSignal[], cluster: ClusterContext, evidence: Evidence): { inserted: number; candidates: string[] } {
  let inserted = 0;
  const touched = new Set<string>();
  const now = Date.now();
  ctx.db.transaction((tx) => {
    for (const s of incoming) {
      const dup = tx.select({ id: schema.signals.id }).from(schema.signals).where(and(eq(schema.signals.ownerId, ownerId), eq(schema.signals.ref, s.ref))).get();
      if (dup) continue;
      const ck = clusterKeyFor(s as SignalLike, cluster);
      let candidateId: number | null = null;
      if (ck) {
        let existing = tx.select().from(schema.candidates).where(and(eq(schema.candidates.ownerId, ownerId), eq(schema.candidates.key, ck.key))).get();
        if (!existing && ck.type === "release") {
          const mergeable = tx.select().from(schema.candidates).where(and(eq(schema.candidates.ownerId, ownerId), eq(schema.candidates.repo, s.repo), eq(schema.candidates.type, "release"))).all()
            .find((c) => !["published", "dropped"].includes(c.status) && now - c.createdAt < 10 * DAY);
          if (mergeable) {
            // 최신 태그일 때만 이름을 바꾼다 (GitHub는 최신 릴리스부터 주므로 뒤에 오는 옛 태그로 덮어쓰지 않게).
            const oldTag = mergeable.key.split("@")[1] ?? "";
            const newTag = ck.key.split("@")[1] ?? "";
            const newer = newTag.localeCompare(oldTag, undefined, { numeric: true }) > 0;
            if (newer) tx.update(schema.candidates).set({ title: ck.title, key: ck.key }).where(eq(schema.candidates.id, mergeable.id)).run();
            existing = newer ? { ...mergeable, title: ck.title, key: ck.key } : mergeable;
          }
        }
        if (existing) {
          candidateId = existing.id;
          tx.update(schema.candidates).set({ evidence: { ...(existing.evidence as Evidence), ...evidence } as Record<string, unknown>, updatedAt: now }).where(eq(schema.candidates.id, existing.id)).run();
        } else {
          candidateId = Number(tx.insert(schema.candidates).values({ ownerId, type: ck.type, title: ck.title, repo: s.repo, key: ck.key, evidence: evidence as Record<string, unknown>, status: "new", createdAt: now, updatedAt: now }).run().lastInsertRowid);
        }
        touched.add(ck.key);
      }
      tx.insert(schema.signals).values({ ownerId, sourceId, kind: s.kind, repo: s.repo, ref: s.ref, title: s.title, payload: s.payload, occurredAt: s.occurredAt, candidateId }).run();
      inserted++;
    }
    // 릴리스 후보에 직전 30일의 고아 PR을 붙인다.
    for (const key of touched) {
      if (!key.startsWith("release:")) continue;
      const cand = tx.select().from(schema.candidates).where(and(eq(schema.candidates.ownerId, ownerId), eq(schema.candidates.key, key))).get();
      if (!cand) continue;
      const orphans = tx.select().from(schema.signals).where(and(eq(schema.signals.ownerId, ownerId), eq(schema.signals.repo, cand.repo), eq(schema.signals.kind, "pr_merged"), isNull(schema.signals.candidateId))).all();
      const titles: string[] = [];
      for (const o of orphans) {
        if (cand.updatedAt - o.occurredAt > 30 * DAY) continue;
        tx.update(schema.signals).set({ candidateId: cand.id }).where(eq(schema.signals.id, o.id)).run();
        titles.push(o.title);
      }
      if (titles.length) {
        const ev = cand.evidence as Evidence;
        tx.update(schema.candidates).set({ evidence: { ...ev, mergedPrTitles: [...(ev.mergedPrTitles ?? []), ...titles].slice(-20) } as Record<string, unknown> }).where(eq(schema.candidates.id, cand.id)).run();
      }
    }
  });
  if (inserted) emit(ctx, ownerId, { resource: "candidates" });
  return { inserted, candidates: [...touched] };
}

export function latestForRepo(ctx: AppContext, ownerId: string, repo: string) {
  const rows = ctx.db.select().from(schema.signals).where(and(eq(schema.signals.ownerId, ownerId), eq(schema.signals.repo, repo))).orderBy(desc(schema.signals.occurredAt)).limit(50).all();
  const latestRelease = rows.find((r) => r.kind === "release");
  const num = (r: typeof rows[number] | undefined) => (r ? Number((r.payload as { threshold?: number })?.threshold ?? 0) : undefined);
  return {
    latestReleaseAt: latestRelease?.occurredAt,
    recentPrCount: rows.filter((r) => r.kind === "pr_merged" && Date.now() - r.occurredAt < 7 * DAY).length,
    lastStarThreshold: num(rows.find((r) => r.kind === "star_milestone")),
    lastDownloadThreshold: num(rows.find((r) => r.kind === "download_milestone")),
  };
}
