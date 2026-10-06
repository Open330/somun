import { and, desc, eq, isNull } from "drizzle-orm";
import { clusterKeyFor, inWindow, strongerType, windowKey, type CandidateType, type SignalLike } from "../core/cluster.js";
import { schema } from "../infra/db/index.js";
import type { Evidence, SignalKind } from "../shared/types.js";
import { emit, type AppContext } from "./context.js";
import { uniqueKey } from "./candidates.js";

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
        // 블로그 글은 저장소가 아니라 글 단위. 나머지는 저장소 × 10일 창 하나에 모은다.
        const existing = ck.type === "blog"
          ? tx.select().from(schema.candidates).where(and(eq(schema.candidates.ownerId, ownerId), eq(schema.candidates.key, ck.key))).get()
          : tx.select().from(schema.candidates).where(and(eq(schema.candidates.ownerId, ownerId), eq(schema.candidates.repo, s.repo))).all()
              .filter((c) => !["published", "dropped"].includes(c.status) && inWindow(c.createdAt, now))
              .sort((a, b) => b.createdAt - a.createdAt)[0];
        const milestone = s.kind === "star_milestone" || s.kind === "download_milestone"
          ? { metric: (s.kind === "star_milestone" ? "stars" : "downloads") as "stars" | "downloads", threshold: Number(s.payload.threshold ?? 0), at: s.occurredAt }
          : null;
        if (existing) {
          candidateId = existing.id;
          const cur = existing.evidence as Evidence;
          const ms = milestone ? [...(cur.milestones ?? []).filter((m) => !(m.metric === milestone.metric && m.threshold === milestone.threshold)), milestone] : cur.milestones;
          const type = strongerType(existing.type as CandidateType, ck.type);
          // 더 강한 신호가 오면 제목이 바뀐다. 같은 등급의 릴리스는 최신 태그일 때만.
          let title = existing.title;
          if (type !== existing.type) title = ck.title;
          else if (ck.type === "release" && existing.type === "release") {
            // 비교 기준은 지금 제목의 태그. evidence.version은 수집 시점의 값이라 이번 묶음의 다른 릴리스와 어긋날 수 있다.
            const oldTag = existing.title.split(" ").pop() ?? cur.version ?? "";
            const newTag = String(s.payload.tag ?? "");
            if (newTag.localeCompare(oldTag, undefined, { numeric: true }) > 0) title = ck.title;
          }
          // 판단 뒤에 더 강한 신호(새 릴리스·유형 승격)가 합쳐지면 예전 판단이 지금 내용을 설명하지 못한다. 다시 판단받도록 되돌린다.
          // 초안이 있는 후보는 사용자의 검토 중 작업을 건드리지 않도록 그대로 둔다.
          const reopened = (type !== existing.type || title !== existing.title) && ["judged", "deferred"].includes(existing.status);
          tx.update(schema.candidates).set({ ...(reopened ? { status: "new" as const } : {}), type, title, evidence: { ...cur, ...Object.fromEntries(Object.entries(evidence).filter(([, v]) => v !== undefined)), milestones: ms, highlights: cur.highlights, highlightsAt: cur.highlightsAt, limitations: cur.limitationsSource === "digest" && !evidence.limitations?.length ? cur.limitations : evidence.limitations, limitationsSource: cur.limitationsSource === "digest" && !evidence.limitations?.length ? "digest" : evidence.limitationsSource } as Record<string, unknown>, updatedAt: now }).where(eq(schema.candidates.id, existing.id)).run();
          touched.add(existing.key);
        } else {
          const key = ck.type === "blog" ? ck.key : uniqueKey(tx, ownerId, windowKey(s.repo, now));
          const ev: Evidence = { ...evidence, milestones: milestone ? [milestone] : undefined };
          candidateId = Number(tx.insert(schema.candidates).values({ ownerId, type: ck.type, title: ck.title, repo: s.repo, key, evidence: ev as Record<string, unknown>, status: "new", createdAt: now, updatedAt: now }).run().lastInsertRowid);
          touched.add(key);
        }
      }
      tx.insert(schema.signals).values({ ownerId, sourceId, kind: s.kind, repo: s.repo, ref: s.ref, title: s.title, payload: s.payload, occurredAt: s.occurredAt, candidateId }).run();
      inserted++;
    }
    for (const key of touched) {
      const cand = tx.select().from(schema.candidates).where(and(eq(schema.candidates.ownerId, ownerId), eq(schema.candidates.key, key))).get();
      // 릴리스는 직전 30일, 진행 중 글감은 그것을 만든 최근 7일의 PR을 함께 묶는다(앞서 수집돼 고아로 남은 PR 포함).
      const span = cand?.type === "release" ? 30 * DAY : cand?.type === "in-progress" ? 7 * DAY : 0;
      if (!cand || !span) continue;
      const orphans = tx.select().from(schema.signals).where(and(eq(schema.signals.ownerId, ownerId), eq(schema.signals.repo, cand.repo), eq(schema.signals.kind, "pr_merged"), isNull(schema.signals.candidateId))).all();
      const titles: string[] = [];
      for (const o of orphans) {
        if (cand.updatedAt - o.occurredAt > span) continue;
        // 최근 릴리스에 이미 들어간 PR(릴리스 시점 이전)은 진행 중 작업이 아니다.
        if (cand.type === "in-progress" && cluster.latestReleaseAt !== undefined && o.occurredAt <= cluster.latestReleaseAt) continue;
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
    /** 최근 7일에 이미 저장한 PR(ref·머지 시각). 수집할 때마다 같은 PR을 다시 받아 오므로 개수는 ref로 중복을 빼고 센다. */
    recentPrs: rows.filter((r) => r.kind === "pr_merged" && Date.now() - r.occurredAt < 7 * DAY).map((r) => ({ ref: r.ref, at: r.occurredAt })),
    lastStarThreshold: num(rows.find((r) => r.kind === "star_milestone")),
    lastDownloadThreshold: num(rows.find((r) => r.kind === "download_milestone")),
  };
}
