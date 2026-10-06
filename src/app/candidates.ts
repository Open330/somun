import { and, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { inWindow } from "../core/cluster.js";
import { schema } from "../infra/db/index.js";
import type { Candidate, CandidateDetail, CandidateListItem, CandidateStatus, Channel, Decision, Draft, Evidence, FeedbackReason, Judgment, Publication, SignalKind } from "../shared/types.js";
import { emit, NotFoundError, type AppContext } from "./context.js";
import { getProfile } from "./profiles.js";
import { alreadyTold } from "./ledger.js";
import { crossLangNumberDiff } from "../core/lint.js";

const DAY = 24 * 3600 * 1000;

export const toCandidate = (r: typeof schema.candidates.$inferSelect): Candidate => ({ id: r.id, type: r.type as Candidate["type"], title: r.title, repo: r.repo, key: r.key, evidence: r.evidence as Evidence, status: r.status as CandidateStatus, latestJudgmentId: r.latestJudgmentId ?? undefined, createdAt: r.createdAt, updatedAt: r.updatedAt });
export const toJudgment = (r: typeof schema.judgments.$inferSelect): Judgment => ({ id: r.id, candidateId: r.candidateId, scores: r.scores as Judgment["scores"], total: r.total, reasoning: r.reasoning, angle: r.angle ?? undefined, decision: r.decision as Decision, suggestedChannels: r.suggestedChannels as Channel[], model: r.model, overriddenDecision: (r.overriddenDecision as "draft" | "drop" | "defer" | null) ?? undefined, overrideReason: r.overrideReason ?? undefined, createdAt: r.createdAt });
export const toDraft = (r: typeof schema.drafts.$inferSelect): Draft => ({ purpose: r.purpose ?? undefined, id: r.id, candidateId: r.candidateId, channel: r.channel as Channel, lang: r.lang, version: r.version, title: r.title ?? undefined, body: r.body, mediaHint: r.mediaHint ?? undefined, lint: r.lint, status: r.status as Draft["status"], model: r.model, voice: r.voice ?? undefined, createdAt: r.createdAt, updatedAt: r.updatedAt });
export const toPublication = (r: typeof schema.publications.$inferSelect): Publication => ({ id: r.id, candidateId: r.candidateId, draftId: r.draftId ?? undefined, channel: r.channel as Channel, lang: r.lang ?? undefined, url: r.url, publishedAt: r.publishedAt, manualStats: r.manualStats ?? undefined, autoStats: r.autoStats ?? undefined, autoStatsAt: r.autoStatsAt ?? undefined });

export function getCandidateRow(ctx: AppContext, ownerId: string, id: number) {
  const row = ctx.db.select().from(schema.candidates).where(and(eq(schema.candidates.id, id), eq(schema.candidates.ownerId, ownerId))).get();
  if (!row) throw new NotFoundError("candidate");
  return row;
}

/** 채널·언어마다 최신 유효 버전만 검토 대상으로 센다. 연결할 초안 ID가 없는 과거 게시 기록은 새 초안을 덮지 않는다. */
function unpublishedCount(drafts: { id: number; channel: string; lang: string; version: number; status: string }[], publications: Pick<Publication, "draftId">[]): number {
  const latest = new Map<string, (typeof drafts)[number]>();
  for (const draft of drafts) {
    if (draft.status === "dropped") continue;
    const key = `${draft.channel}:${draft.lang}`;
    if (!latest.has(key) || latest.get(key)!.version < draft.version) latest.set(key, draft);
  }
  const published = new Set(publications.map((p) => p.draftId));
  return [...latest.values()].filter((d) => !published.has(d.id)).length;
}

export function listInbox(ctx: AppContext, ownerId: string): CandidateListItem[] {
  const rows = ctx.db.select().from(schema.candidates).where(eq(schema.candidates.ownerId, ownerId)).orderBy(desc(schema.candidates.updatedAt), desc(schema.candidates.id)).all();
  if (!rows.length) return [];
  // 소유자별 일괄 조회: 글감 수와 무관하게 쿼리 수를 유지하고 IN 인자 개수 제한도 피한다.
  const drafts = ctx.db.select({ id: schema.drafts.id, candidateId: schema.drafts.candidateId, channel: schema.drafts.channel, lang: schema.drafts.lang, version: schema.drafts.version, status: schema.drafts.status }).from(schema.drafts).where(eq(schema.drafts.ownerId, ownerId)).all();
  const publications = ctx.db.select({ candidateId: schema.publications.candidateId, draftId: schema.publications.draftId }).from(schema.publications).where(eq(schema.publications.ownerId, ownerId)).all();
  const draftsByCandidate = new Map<number, typeof drafts>();
  for (const draft of drafts) {
    const group = draftsByCandidate.get(draft.candidateId) ?? [];
    group.push(draft); draftsByCandidate.set(draft.candidateId, group);
  }
  const publicationsByCandidate = new Map<number, Pick<Publication, "draftId">[]>();
  for (const publication of publications) {
    const group = publicationsByCandidate.get(publication.candidateId) ?? [];
    group.push({ draftId: publication.draftId ?? undefined }); publicationsByCandidate.set(publication.candidateId, group);
  }
  let completedCount = 0;
  const selected = rows.map((r) => ({ ...toCandidate(r), unpublishedDraftCount: unpublishedCount(draftsByCandidate.get(r.id) ?? [], publicationsByCandidate.get(r.id) ?? []) }))
    .filter((c) => {
      if (["new", "judged", "drafted"].includes(c.status) || (c.status === "published" && c.unpublishedDraftCount > 0)) return true;
      return completedCount++ < 200;
    });
  const js = ctx.db.select().from(schema.judgments).where(and(eq(schema.judgments.ownerId, ownerId), inArray(schema.judgments.id, ctx.db.select({ id: schema.candidates.latestJudgmentId }).from(schema.candidates).where(eq(schema.candidates.ownerId, ownerId))))).all();
  const byId = new Map(js.map((j) => [j.id, toJudgment(j)]));
  return selected.map((c) => ({ ...c, judgment: c.latestJudgmentId ? byId.get(c.latestJudgmentId) ?? null : null }));
}

export function getCandidateDetail(ctx: AppContext, ownerId: string, id: number): CandidateDetail {
  const c = getCandidateRow(ctx, ownerId, id);
  const judgments = ctx.db.select().from(schema.judgments).where(eq(schema.judgments.candidateId, id)).orderBy(desc(schema.judgments.createdAt)).all().map(toJudgment);
  const drafts = ctx.db.select().from(schema.drafts).where(eq(schema.drafts.candidateId, id)).all().map(toDraft);
  const publications = ctx.db.select().from(schema.publications).where(eq(schema.publications.candidateId, id)).all().map(toPublication);
  const signals = ctx.db.select().from(schema.signals).where(eq(schema.signals.candidateId, id)).orderBy(desc(schema.signals.occurredAt)).limit(30).all().map((s) => ({ id: s.id, kind: s.kind as SignalKind, title: s.title, occurredAt: s.occurredAt }));
  return { candidate: toCandidate(c), unpublishedDraftCount: unpublishedCount(drafts, publications), judgments, drafts, publications, signals, profile: getProfile(ctx, ownerId, c.repo), told: alreadyTold(ctx, ownerId, c.repo, { excludeCandidateId: c.id, limit: 20 }), consistency: crossLangNumberDiff(drafts) };
}

export function setCandidateStatus(ctx: AppContext, ownerId: string, id: number, status: CandidateStatus): void {
  const c = getCandidateRow(ctx, ownerId, id);
  // 판단이 "초안"이라 한 글감을 사용자가 보류하면 그것도 판단 번복이다. 다음 판단이 사용자의 기준을 알도록 남긴다.
  const judgment = c.latestJudgmentId ? ctx.db.select().from(schema.judgments).where(eq(schema.judgments.id, c.latestJudgmentId)).get() : undefined;
  if (status === "deferred" && judgment && judgment.decision === "draft" && !judgment.overriddenDecision) {
    ctx.db.update(schema.judgments).set({ overriddenDecision: "defer", overrideReason: "deferred by editor" }).where(eq(schema.judgments.id, judgment.id)).run();
    ctx.db.insert(schema.feedback).values({ ownerId, targetType: "judgment", targetId: String(judgment.id), reason: "other", note: "deferred by editor", createdAt: Date.now() }).run();
  }
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

/**
 * 최근의 판단 번복. 글감 제목·점수·판단·사용자의 결정을 함께 넘겨, 판단이 "어떤 글감을 왜 뒤집었는지"를 보고 기준을 맞추게 한다.
 * (예전에는 "other: manual draft request" 한 줄만 남아 무엇을 뒤집었는지 알 수 없었다.) 가중치는 자동으로 바꾸지 않는다.
 */
export function recentOverrides(ctx: AppContext, ownerId: string, limit = 5): string[] {
  const rows = ctx.db.select({ j: schema.judgments, title: schema.candidates.title }).from(schema.judgments).innerJoin(schema.candidates, eq(schema.candidates.id, schema.judgments.candidateId))
    .where(and(eq(schema.judgments.ownerId, ownerId), isNotNull(schema.judgments.overriddenDecision))).orderBy(desc(schema.judgments.id)).limit(limit).all();
  return rows.map(({ j, title }) => {
    const s = j.scores as Record<string, number>;
    const scores = ["runnable", "numbers", "lesson", "novelty", "audience"].map((k) => `${k} ${s[k] ?? 0}`).join(", ");
    const why = j.overrideReason && j.overrideReason !== "manual draft request" ? ` (${j.overrideReason})` : "";
    return `"${title}": you said ${j.decision} (${j.total}/10; ${scores}) → editor chose ${j.overriddenDecision}${why}`;
  });
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
    // 지난 창의 글감은 자기 릴리스를 설명한다. 새 릴리스의 버전·노트로 덮어쓰지 않는다.
    const past = !inWindow(c.createdAt, Date.now());
    const merged: Evidence = { ...cur, ...defined, ...(past ? { version: cur.version, releaseNotes: cur.releaseNotes, commitSubjects: cur.commitSubjects } : {}), limitations, limitationsSource, highlights: cur.highlights, highlightsAt: cur.highlightsAt, ompSummary: cur.ompSummary ?? incoming.ompSummary, windowReleaseNotes: cur.windowReleaseNotes };
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
