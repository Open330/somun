import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { schema } from "../infra/db/index.js";
import type { Candidate, CandidateDetail, CandidateListItem, CandidateStatus, Channel, Decision, Draft, Evidence, FeedbackReason, Judgment, Publication, SignalKind } from "../shared/types.js";
import { emit, NotFoundError, type AppContext } from "./context.js";
import { getProfile } from "./profiles.js";
import { alreadyTold } from "./ledger.js";
import { crossLangNumberDiff } from "../core/lint.js";
import { splitJudgment } from "../core/judgment.js";

const DAY = 24 * 3600 * 1000;

export const toCandidate = (r: typeof schema.candidates.$inferSelect): Candidate => ({ id: r.id, type: r.type as Candidate["type"], title: r.title, repo: r.repo, key: r.key, evidence: r.evidence as Evidence, status: r.status as CandidateStatus, latestJudgmentId: r.latestJudgmentId ?? undefined, createdAt: r.createdAt, updatedAt: r.updatedAt });
export const toJudgment = (r: typeof schema.judgments.$inferSelect): Judgment => ({ id: r.id, candidateId: r.candidateId, scores: r.scores as Judgment["scores"], total: r.total, ...splitJudgment(r), decision: r.decision as Decision, suggestedChannels: r.suggestedChannels as Channel[], model: r.model, overriddenDecision: (r.overriddenDecision as "draft" | "drop" | null) ?? undefined, overrideReason: r.overrideReason ?? undefined, createdAt: r.createdAt });
export const toDraft = (r: typeof schema.drafts.$inferSelect): Draft => ({ id: r.id, candidateId: r.candidateId, channel: r.channel as Channel, lang: r.lang, version: r.version, title: r.title ?? undefined, body: r.body, mediaHint: r.mediaHint ?? undefined, lint: r.lint, status: r.status as Draft["status"], model: r.model, voice: r.voice ?? undefined, createdAt: r.createdAt, updatedAt: r.updatedAt });
export const toPublication = (r: typeof schema.publications.$inferSelect): Publication => ({ id: r.id, candidateId: r.candidateId, draftId: r.draftId ?? undefined, channel: r.channel as Channel, lang: r.lang ?? undefined, url: r.url, publishedAt: r.publishedAt, manualStats: r.manualStats ?? undefined, autoStats: r.autoStats ?? undefined, autoStatsAt: r.autoStatsAt ?? undefined });

export function getCandidateRow(ctx: AppContext, ownerId: string, id: number) {
  const row = ctx.db.select().from(schema.candidates).where(and(eq(schema.candidates.id, id), eq(schema.candidates.ownerId, ownerId))).get();
  if (!row) throw new NotFoundError("candidate");
  return row;
}

export function listInbox(ctx: AppContext, ownerId: string): CandidateListItem[] {
  const rows = ctx.db.select().from(schema.candidates).where(eq(schema.candidates.ownerId, ownerId)).orderBy(desc(schema.candidates.updatedAt)).limit(200).all();
  const jids = rows.map((r) => r.latestJudgmentId).filter((x): x is number => x !== null);
  const js = jids.length ? ctx.db.select().from(schema.judgments).where(inArray(schema.judgments.id, jids)).all() : [];
  const byId = new Map(js.map((j) => [j.id, toJudgment(j)]));
  return rows.map((r) => ({ ...toCandidate(r), judgment: r.latestJudgmentId ? byId.get(r.latestJudgmentId) ?? null : null }));
}

export function getCandidateDetail(ctx: AppContext, ownerId: string, id: number): CandidateDetail {
  const c = getCandidateRow(ctx, ownerId, id);
  const judgments = ctx.db.select().from(schema.judgments).where(eq(schema.judgments.candidateId, id)).orderBy(desc(schema.judgments.createdAt)).all().map(toJudgment);
  const drafts = ctx.db.select().from(schema.drafts).where(eq(schema.drafts.candidateId, id)).all().map(toDraft);
  const publications = ctx.db.select().from(schema.publications).where(eq(schema.publications.candidateId, id)).all().map(toPublication);
  const signals = ctx.db.select().from(schema.signals).where(eq(schema.signals.candidateId, id)).orderBy(desc(schema.signals.occurredAt)).limit(30).all().map((s) => ({ id: s.id, kind: s.kind as SignalKind, title: s.title, occurredAt: s.occurredAt }));
  return { candidate: toCandidate(c), judgments, drafts, publications, signals, profile: getProfile(ctx, ownerId, c.repo), told: alreadyTold(ctx, ownerId, c.repo, { excludeCandidateId: c.id, limit: 20 }), consistency: crossLangNumberDiff(drafts) };
}

export function setCandidateStatus(ctx: AppContext, ownerId: string, id: number, status: CandidateStatus): void {
  getCandidateRow(ctx, ownerId, id);
  ctx.db.update(schema.candidates).set({ status, updatedAt: Date.now() }).where(eq(schema.candidates.id, id)).run();
  emit(ctx, ownerId, { resource: "candidates", id });
}

/** 판단 오버라이드. 사유는 feedback에 남아 다음 판단 프롬프트에 들어간다. */
export function overrideJudgment(ctx: AppContext, ownerId: string, id: number, decision: "draft" | "drop", reason: FeedbackReason, note?: string): void {
  const c = getCandidateRow(ctx, ownerId, id);
  if (c.latestJudgmentId) ctx.db.update(schema.judgments).set({ overriddenDecision: decision, overrideReason: note ?? reason }).where(eq(schema.judgments.id, c.latestJudgmentId)).run();
  ctx.db.insert(schema.feedback).values({ ownerId, targetType: "judgment", targetId: String(c.latestJudgmentId ?? id), reason, note: note ?? null, createdAt: Date.now() }).run();
  ctx.db.update(schema.candidates).set({ status: decision === "drop" ? "dropped" : "judged", updatedAt: Date.now() }).where(eq(schema.candidates.id, id)).run();
  emit(ctx, ownerId, { resource: "candidates", id });
}

export function listByStatus(ctx: AppContext, status: CandidateStatus, ownerId?: string) {
  const where = ownerId ? and(eq(schema.candidates.status, status), eq(schema.candidates.ownerId, ownerId)) : eq(schema.candidates.status, status);
  return ctx.db.select().from(schema.candidates).where(where).all();
}

export function recentPublishedTitles(ctx: AppContext, ownerId: string, days: number): string[] {
  const since = Date.now() - days * DAY;
  const pubs = ctx.db.select().from(schema.publications).where(and(eq(schema.publications.ownerId, ownerId), gte(schema.publications.publishedAt, since))).all();
  return pubs.map((p) => {
    const c = ctx.db.select().from(schema.candidates).where(eq(schema.candidates.id, p.candidateId)).get();
    return c ? `${c.title} (${p.channel})` : null;
  }).filter((x): x is string => Boolean(x));
}

/** 수집마다 열린 후보의 기본 사실을 최신으로. 다이제스트·omp 요약은 지우지 않는다. */
export function refreshEvidence(ctx: AppContext, ownerId: string, repo: string, incoming: Evidence): number {
  const rows = ctx.db.select().from(schema.candidates).where(and(eq(schema.candidates.ownerId, ownerId), eq(schema.candidates.repo, repo))).all();
  let n = 0;
  for (const c of rows) {
    if (["dropped", "published"].includes(c.status)) continue;
    const cur = c.evidence as Evidence;
    // README에서 온 한계는 README 결과로 통째로 바꾼다(빈 것도 반영). 다이제스트가 채운 한계만 README가 비어 있을 때 지킨다.
    const keepDigest = cur.limitationsSource === "digest" && !incoming.limitations?.length;
    const limitations = keepDigest ? cur.limitations : incoming.limitations;
    const limitationsSource = keepDigest ? "digest" as const : incoming.limitationsSource ?? "readme" as const;
    // 값이 없는 필드(일시적 조회 실패)는 기존 사실을 지우지 않는다.
    const defined = Object.fromEntries(Object.entries(incoming).filter(([, v]) => v !== undefined)) as Partial<Evidence>;
    const merged: Evidence = { ...cur, ...defined, limitations, limitationsSource, highlights: cur.highlights, highlightsAt: cur.highlightsAt, ompSummary: cur.ompSummary ?? incoming.ompSummary };
    ctx.db.update(schema.candidates).set({ evidence: merged as Record<string, unknown> }).where(eq(schema.candidates.id, c.id)).run();
    n++;
  }
  return n;
}

/**
 * 구 글감(신호 종류별 키: release:/milestone:/in-progress:/new-repo:)을 저장소 × 10일 창으로 합친다.
 * 한 번만 돌고(키가 repo:/blog:로 시작하면 건너뜀) 되돌릴 수 없으므로 시작 시 백업 뒤에 부른다.
 */
export function migrateLegacyCandidates(ctx: AppContext): { merged: number; renamed: number } {
  const legacy = ctx.db.select().from(schema.candidates).all().filter((c) => !c.key.startsWith("repo:") && !c.key.startsWith("blog:"));
  if (legacy.length === 0) return { merged: 0, renamed: 0 };
  let merged = 0, renamed = 0;
  const RANK: Record<string, number> = { release: 4, "new-repo": 3, "in-progress": 2, milestone: 1 };
  ctx.db.transaction((tx) => {
    const groups = new Map<string, typeof legacy>();
    for (const c of legacy) { const k = `${c.ownerId}|${c.repo}`; groups.set(k, [...(groups.get(k) ?? []), c]); }
    for (const rows of groups.values()) {
      // 닫힌 것(버림·발행)은 합치지 않고 키만 바꾼다.
      const closed = rows.filter((c) => ["dropped", "published"].includes(c.status));
      const open = rows.filter((c) => !["dropped", "published"].includes(c.status)).sort((a, b) => a.createdAt - b.createdAt);
      for (const c of closed) { tx.update(schema.candidates).set({ key: uniqueKey(tx, c.ownerId, `repo:${c.repo}:${new Date(c.createdAt).toISOString().slice(0, 10)}`) }).where(eq(schema.candidates.id, c.id)).run(); renamed++; }
      // 10일 창으로 묶는다.
      const windows: (typeof open)[] = [];
      for (const c of open) { const w = windows.at(-1); if (w && c.createdAt - w[0].createdAt < 10 * DAY) w.push(c); else windows.push([c]); }
      for (const w of windows) {
        const counted = w.map((c) => ({ c, drafts: tx.select().from(schema.drafts).where(eq(schema.drafts.candidateId, c.id)).all() }));
        counted.sort((a, b) => b.drafts.length - a.drafts.length || (RANK[b.c.type] ?? 0) - (RANK[a.c.type] ?? 0) || b.c.createdAt - a.c.createdAt);
        const keeper = counted[0].c;
        const strongest = w.reduce((t, c) => ((RANK[c.type] ?? 0) > (RANK[t.type] ?? 0) ? c : t), keeper);
        const milestones = w.filter((c) => c.type === "milestone").map((c) => { const [metric, th] = (c.key.split("#")[1] ?? "stars-0").split("-"); return { metric: metric as "stars" | "downloads", threshold: Number(th), at: c.createdAt }; });
        const ev = keeper.evidence as Evidence;
        const highlights = ev.highlights?.length ? ev.highlights : (w.map((c) => (c.evidence as Evidence).highlights).find((h) => h?.length) ?? undefined);
        let nextVersion = Math.max(0, ...counted[0].drafts.map((d) => d.version)) + 1;
        for (const { c, drafts } of counted.slice(1)) {
          tx.update(schema.signals).set({ candidateId: keeper.id }).where(eq(schema.signals.candidateId, c.id)).run();
          for (const d of drafts) tx.update(schema.drafts).set({ candidateId: keeper.id, version: nextVersion++ }).where(eq(schema.drafts.id, d.id)).run();
          tx.update(schema.judgments).set({ candidateId: keeper.id }).where(eq(schema.judgments.candidateId, c.id)).run();
          tx.update(schema.publications).set({ candidateId: keeper.id }).where(eq(schema.publications.candidateId, c.id)).run();
          tx.delete(schema.llmJobs).where(eq(schema.llmJobs.candidateId, c.id)).run();
          tx.delete(schema.candidates).where(eq(schema.candidates.id, c.id)).run();
          merged++;
        }
        const latestJ = tx.select().from(schema.judgments).where(eq(schema.judgments.candidateId, keeper.id)).orderBy(desc(schema.judgments.createdAt)).get();
        const status = counted[0].drafts.length || counted.slice(1).some((x) => x.drafts.length) ? "drafted" : keeper.status;
        tx.update(schema.candidates).set({
          key: uniqueKey(tx, keeper.ownerId, `repo:${keeper.repo}:${new Date(w[0].createdAt).toISOString().slice(0, 10)}`),
          type: strongest.type, title: strongest.type === keeper.type ? keeper.title : strongest.title,
          evidence: { ...ev, highlights, highlightsAt: highlights ? ev.highlightsAt ?? Date.now() : ev.highlightsAt, milestones: milestones.length ? milestones : ev.milestones } as Record<string, unknown>,
          latestJudgmentId: latestJ?.id ?? keeper.latestJudgmentId, status, updatedAt: Date.now(),
        }).where(eq(schema.candidates.id, keeper.id)).run();
        renamed++;
      }
    }
  });
  return { merged, renamed };
}

export type Tx = Parameters<Parameters<AppContext["db"]["transaction"]>[0]>[0];
/** 같은 날 창이 닫히고 다시 열리면 키가 겹친다. 접미사로 피한다. */
export function uniqueKey(tx: Tx, ownerId: string, base: string): string {
  let key = base;
  for (let i = 2; i < 100; i++) {
    const hit = tx.select({ id: schema.candidates.id }).from(schema.candidates).where(and(eq(schema.candidates.ownerId, ownerId), eq(schema.candidates.key, key))).get();
    if (!hit) return key;
    key = `${base}#${i}`;
  }
  return `${base}#${Date.now()}`;
}
