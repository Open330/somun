import { and, desc, eq, gte, isNotNull, ne } from "drizzle-orm";
import { schema } from "../infra/db/index.js";
import type { AppContext } from "./context.js";

/**
 * 변경 원장. 저장소별로 "이미 다이제스트한 변경"과 "발행한 변경"을 남긴다.
 * 다이제스트는 원장을 받아 같은 말을 되풀이하지 않고, 판단은 발행된 것을 새로움 감점에 쓴다.
 */
const DAY = 86400e3;

export function normalizeText(t: string): string {
  return t.toLowerCase().replace(/[`"'“”‘’.,;:!?()\[\]{}\/-]/g, " ").replace(/\s+/g, " ").trim();
}

/** 단어 집합 자카드. 같은 변경을 다른 문장으로 말한 것을 잡는다. */
export function similar(a: string, b: string): boolean {
  if (a === b) return true;
  const A = new Set(a.split(" ").filter((w) => w.length > 2)), B = new Set(b.split(" ").filter((w) => w.length > 2));
  if (A.size === 0 || B.size === 0) return false;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter) >= 0.6;
}

export function alreadyTold(ctx: AppContext, ownerId: string, repo: string, opts: { excludeCandidateId?: number; days?: number; limit?: number } = {}): { text: string; publishedAt?: number; publishedChannel?: string; candidateId?: number }[] {
  const since = Date.now() - (opts.days ?? 90) * DAY;
  const rows = ctx.db.select().from(schema.changeLedger).where(and(eq(schema.changeLedger.ownerId, ownerId), eq(schema.changeLedger.repo, repo), gte(schema.changeLedger.firstSeenAt, since))).orderBy(desc(schema.changeLedger.firstSeenAt)).limit(opts.limit ?? 40).all();
  return rows.filter((r) => opts.excludeCandidateId === undefined || r.candidateId !== opts.excludeCandidateId).map((r) => ({ text: r.text, publishedAt: r.publishedAt ?? undefined, publishedChannel: r.publishedChannel ?? undefined, candidateId: r.candidateId ?? undefined }));
}

export function alreadyPublished(ctx: AppContext, ownerId: string, repo: string, days = 180): string[] {
  const since = Date.now() - days * DAY;
  return ctx.db.select().from(schema.changeLedger).where(and(eq(schema.changeLedger.ownerId, ownerId), eq(schema.changeLedger.repo, repo), isNotNull(schema.changeLedger.publishedAt), gte(schema.changeLedger.firstSeenAt, since))).orderBy(desc(schema.changeLedger.publishedAt)).limit(30).all().map((r) => r.text);
}

/** 다이제스트 결과를 원장에 넣는다. 이미 있는 것(같은 뜻)은 건너뛴다. 반환: 새로 들어간 수. */
export function recordHighlights(ctx: AppContext, ownerId: string, repo: string, candidateId: number, highlights: string[], source?: string, at = Date.now()): number {
  const existing = ctx.db.select().from(schema.changeLedger).where(and(eq(schema.changeLedger.ownerId, ownerId), eq(schema.changeLedger.repo, repo))).all();
  let n = 0;
  for (const h of highlights) {
    const norm = normalizeText(h);
    if (!norm) continue;
    const dup = existing.find((e) => similar(e.normalized, norm));
    if (dup) {
      // 같은 변경이 이 글감에서도 나왔으면 후보 연결만 최신으로 (발행 표시가 이 글감을 따라가게).
      if (dup.candidateId !== candidateId && !dup.publishedAt) ctx.db.update(schema.changeLedger).set({ candidateId }).where(eq(schema.changeLedger.id, dup.id)).run();
      continue;
    }
    ctx.db.insert(schema.changeLedger).values({ ownerId, repo, text: h, normalized: norm, source: source ?? null, candidateId, firstSeenAt: at, publishedAt: null, publishedChannel: null }).run();
    existing.push({ id: -1, ownerId, repo, text: h, normalized: norm, source: source ?? null, candidateId, firstSeenAt: at, publishedAt: null, publishedChannel: null, disputedAt: null });
    n++;
  }
  return n;
}

/** 발행하면 그 글감의 변경들을 발행됨으로 표시한다. */
export function markPublished(ctx: AppContext, ownerId: string, candidateId: number, channel: string, at = Date.now()): number {
  return ctx.db.update(schema.changeLedger).set({ publishedAt: at, publishedChannel: channel }).where(and(eq(schema.changeLedger.ownerId, ownerId), eq(schema.changeLedger.candidateId, candidateId), ne(schema.changeLedger.firstSeenAt, -1))).run().changes;
}

/** 발행 기록을 지웠을 때. 그 글감에 남은 발행이 있으면 가장 최근 것으로, 없으면 "발행 안 됨"으로 되돌린다. */
export function unmarkPublished(ctx: AppContext, ownerId: string, candidateId: number, remaining?: { channel: string; publishedAt: number }): number {
  return ctx.db.update(schema.changeLedger).set({ publishedAt: remaining?.publishedAt ?? null, publishedChannel: remaining?.channel ?? null })
    .where(and(eq(schema.changeLedger.ownerId, ownerId), eq(schema.changeLedger.candidateId, candidateId), ne(schema.changeLedger.firstSeenAt, -1))).run().changes;
}

/** 이 저장소를 마지막으로 다이제스트한 시각. 수집의 커밋 창이 여기서 시작한다. */
export function lastDigestAt(ctx: AppContext, ownerId: string, repo: string): number | undefined {
  return ctx.db.select({ t: schema.changeLedger.firstSeenAt }).from(schema.changeLedger).where(and(eq(schema.changeLedger.ownerId, ownerId), eq(schema.changeLedger.repo, repo))).orderBy(desc(schema.changeLedger.firstSeenAt)).get()?.t;
}

/** 시작 시 한 번: 원장이 비어 있으면 기존 글감의 하이라이트로 채운다. */
export function backfillLedger(ctx: AppContext): number {
  const any = ctx.db.select({ id: schema.changeLedger.id }).from(schema.changeLedger).limit(1).get();
  if (any) return 0;
  let n = 0;
  const cands = ctx.db.select().from(schema.candidates).all().sort((a, b) => a.createdAt - b.createdAt);
  const introductionIds = new Set(ctx.db.select({ id: schema.drafts.id }).from(schema.drafts).where(eq(schema.drafts.purpose, "introduction")).all().map((d) => d.id));
  const pubs = ctx.db.select().from(schema.publications).all().filter((p) => !p.draftId || !introductionIds.has(p.draftId));
  for (const c of cands) {
    const ev = c.evidence as { highlights?: string[]; highlightsAt?: number };
    if (!ev.highlights?.length) continue;
    n += recordHighlights(ctx, c.ownerId, c.repo, c.id, ev.highlights, c.key, ev.highlightsAt ?? c.updatedAt);
    const p = pubs.find((x) => x.candidateId === c.id);
    if (p) markPublished(ctx, c.ownerId, c.id, p.channel, p.publishedAt);
  }
  return n;
}
