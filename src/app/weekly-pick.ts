import { and, desc, eq, inArray } from "drizzle-orm";
import { enabledTargets, type Channel } from "../core/channels.js";
import { schema } from "../infra/db/index.js";
import type { CandidateType, DraftStatus, Evidence, WeeklyPickView } from "../shared/types.js";
import { GenerationConflictError, type AppContext } from "./context.js";
import { digestCurrent, digestUsable, primaryTarget, queueStep } from "./pipeline.js";
import { getSettings, updateSettings } from "./settings.js";
import { hasBackgroundCapacity, SharedQuotaError } from "./shared-quota.js";

/**
 * 이번 주 한 편. 쌓인 글감 가운데 이번 주에 올릴 하나를 고르고, 초안이 없으면 기본 대상 하나만 준비한다.
 * 수동 모드에서도 돈다: 글감과 초안이 쌓이기만 하고 게시로 이어지지 않던 문제(운영: 3주간 게시 0건)를 고른 하나로 좁힌다.
 * 모델 호출은 고른 글감의 요약·초안 두 번뿐이고, 판단은 건너뛴다(이미 고른 글감이다).
 */

const DAY = 86_400_000;
/** 판단 전 글감의 기본 점수(10점 척도). 판단을 받은 글감은 판단 합계를 쓴다. 출시·이정표가 진행 중 묶음보다 알릴 거리가 분명하다. */
const TYPE_PRIOR: Record<CandidateType, number> = { release: 6, milestone: 5, "new-repo": 5, blog: 4, "in-progress": 4 };
const HISTORY = 8;

/** 한국 시간 월요일 00:00에 바뀌는 주(YYYY-MM-DD). 예약 실행은 그날 08:00 KST에 고른다. */
export function pickWeek(at: number): string {
  const d = new Date(at + 9 * 3600_000);
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY;
  return new Date(monday).toISOString().slice(0, 10);
}

type Ranked = { id: number; score: number; updatedAt: number; hasDraft: boolean };

/**
 * 고를 수 있는 글감을 점수 순으로. 이미 복사·게시한 글감(게시 확인 쪽에서 다룬다), 알릴 변경이 없다고 요약된 글감,
 * 같은 저장소의 이전 주 '진행 중' 묶음, 최근 recentDays보다 오래된 글감은 뺀다.
 */
export function rankForPick(ctx: AppContext, ownerId: string, now = Date.now()): Ranked[] {
  const s = getSettings(ctx, ownerId);
  const since = now - s.watch.recentDays * DAY;
  const rows = ctx.db.select().from(schema.candidates).where(and(eq(schema.candidates.ownerId, ownerId), inArray(schema.candidates.status, ["new", "judged", "drafted", "deferred"]))).all()
    .filter((c) => c.updatedAt >= since);
  if (!rows.length) return [];
  const drafts = ctx.db.select({ candidateId: schema.drafts.candidateId, status: schema.drafts.status }).from(schema.drafts).where(eq(schema.drafts.ownerId, ownerId)).all();
  const posted = new Set(ctx.db.select({ candidateId: schema.publications.candidateId }).from(schema.publications).where(eq(schema.publications.ownerId, ownerId)).all().map((p) => p.candidateId));
  const copied = new Set(drafts.filter((d) => d.status === "copied").map((d) => d.candidateId));
  const drafted = new Set(drafts.filter((d) => d.status !== "dropped").map((d) => d.candidateId));
  const judgmentIds = rows.flatMap((c) => (c.latestJudgmentId ? [c.latestJudgmentId] : []));
  const judgments = new Map(judgmentIds.length ? ctx.db.select().from(schema.judgments).where(inArray(schema.judgments.id, judgmentIds)).all().map((j) => [j.id, j]) : []);
  const newestInProgress = new Map<string, number>();
  for (const c of rows) if (c.type === "in-progress" && (newestInProgress.get(c.repo) ?? -1) < c.updatedAt) newestInProgress.set(c.repo, c.updatedAt);
  return rows
    .filter((c) => !posted.has(c.id) && !copied.has(c.id))
    .filter((c) => c.type !== "in-progress" || newestInProgress.get(c.repo) === c.updatedAt)
    .filter((c) => {
      const ev = c.evidence as Evidence;
      const j = c.latestJudgmentId ? judgments.get(c.latestJudgmentId) : undefined;
      return !(digestCurrent(c, j?.createdAt) && !ev.highlights?.some((h) => h.trim()));
    })
    .map((c) => {
      const j = c.latestJudgmentId ? judgments.get(c.latestJudgmentId) : undefined;
      const hasDraft = drafted.has(c.id);
      // 초안이 이미 있으면 모델을 더 쓰지 않고 바로 검토할 수 있어 조금 앞에 둔다.
      return { id: c.id, score: (j ? j.total : TYPE_PRIOR[c.type as CandidateType] ?? 4) + (hasDraft ? 1 : 0), updatedAt: c.updatedAt, hasDraft };
    })
    .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
}

/**
 * 이번 주 한 편을 정한다. 이번 주에 이미 골랐으면 그대로 둔다. again이면 이번 주에 넘긴 글감을 빼고 다음 후보로 바꾼다.
 * 지난 주들에 고른 글감(history)은 다시 고르지 않는다. 이번 주에 넘긴 것(skipped)은 다음 주에는 다시 후보가 된다.
 * background는 예약 실행: 오늘 공유 한도에서 사용자 몫을 침범하지 않을 때만 초안을 준비한다.
 */
export function pickWeekly(ctx: AppContext, ownerId: string, opts: { now?: number; again?: boolean; background?: boolean } = {}): WeeklyPickView | null {
  const now = opts.now ?? Date.now();
  const week = pickWeek(now);
  const current = getSettings(ctx, ownerId).weeklyPick;
  const sameWeek = current?.week === week;
  if (sameWeek && !opts.again) {
    const view = weeklyPickView(ctx, ownerId, now);
    if (view) return view;
  }
  const history = !current ? [] : sameWeek ? current.history : [current.candidateId, ...current.history.filter((id) => id !== current.candidateId)].slice(0, HISTORY);
  const skipped = sameWeek && current ? [...new Set([...(current.skipped ?? []), ...(opts.again ? [current.candidateId] : [])])] : [];
  const best = rankForPick(ctx, ownerId, now).find((r) => !history.includes(r.id) && !skipped.includes(r.id) && !(sameWeek && opts.again && r.id === current?.candidateId));
  if (!best) return sameWeek ? weeklyPickView(ctx, ownerId, now) : null;
  updateSettings(ctx, ownerId, { weeklyPick: { candidateId: best.id, week, pickedAt: now, history, skipped, prepareAttempts: 0 } });
  ensurePrepared(ctx, ownerId, { now, background: Boolean(opts.background) });
  return weeklyPickView(ctx, ownerId, now);
}

/** 준비를 다시 시도하는 횟수. 한도·모델 실패로 건너뛴 준비는 매시간 정리에서 이어서 하되 같은 실패에 계속 쓰지 않는다. */
const PREPARE_ATTEMPTS = 3;

/**
 * 이번 주 한 편에 초안이 없으면 기본 대상 하나를 준비한다. 요약이 쓸 만하면 바로 초안, 아니면 요약 뒤 그 대상의 초안(판단은 건너뛴다).
 * 진행 중인 작업이 있거나, 이미 게시했거나, 시도 횟수를 넘겼거나, 자동 작업 몫이 모자라면(background) 하지 않는다.
 */
export function ensurePrepared(ctx: AppContext, ownerId: string, opts: { now?: number; background?: boolean } = {}): boolean {
  const now = opts.now ?? Date.now();
  const s = getSettings(ctx, ownerId);
  const pick = s.weeklyPick;
  const view = weeklyPickView(ctx, ownerId, now);
  if (!pick || !view || view.draft || view.preparing || view.posted || (pick.prepareAttempts ?? 0) >= PREPARE_ATTEMPTS) return false;
  const c = ctx.db.select().from(schema.candidates).where(and(eq(schema.candidates.id, pick.candidateId), eq(schema.candidates.ownerId, ownerId))).get();
  if (!c) return false;
  const j = c.latestJudgmentId ? ctx.db.select().from(schema.judgments).where(eq(schema.judgments.id, c.latestJudgmentId)).get() : undefined;
  const target = primaryTarget(ctx, ownerId, s, (j?.suggestedChannels ?? []) as Channel[], { allowLaunch: true });
  if (!target) return false;
  const usable = digestUsable(c, j?.createdAt);
  if (opts.background && !hasBackgroundCapacity(ctx, ownerId, usable ? 1 : 2, s.llm, now)) return false;
  try {
    if (usable) queueStep(ctx, ownerId, "draft", c.id, target.channel, target.lang, { background: opts.background });
    else queueStep(ctx, ownerId, "digest", c.id, undefined, undefined, { continuation: { targets: [target], ...(opts.background ? { background: true } : {}) }, background: opts.background });
  } catch (err) {
    // 이미 진행 중이거나 한도에 걸렸으면 고른 것만 남긴다. 사용자는 글감 화면에서 직접 초안을 쓸 수 있다.
    if (!(err instanceof GenerationConflictError) && !(err instanceof SharedQuotaError)) throw err;
    return false;
  }
  updateSettings(ctx, ownerId, { weeklyPick: { ...pick, prepareAttempts: (pick.prepareAttempts ?? 0) + 1 } });
  return true;
}

/** 이번 주에 고른 것만 보여준다(지난주 것을 이번 주 한 편이라고 하지 않는다). */
export function weeklyPickView(ctx: AppContext, ownerId: string, now = Date.now()): WeeklyPickView | null {
  const pick = getSettings(ctx, ownerId).weeklyPick;
  if (!pick || pick.week !== pickWeek(now)) return null;
  const c = ctx.db.select().from(schema.candidates).where(and(eq(schema.candidates.id, pick.candidateId), eq(schema.candidates.ownerId, ownerId))).get();
  if (!c || c.status === "dropped") return null;
  const j = c.latestJudgmentId ? ctx.db.select().from(schema.judgments).where(eq(schema.judgments.id, c.latestJudgmentId)).get() : undefined;
  const draft = ctx.db.select().from(schema.drafts).where(and(eq(schema.drafts.ownerId, ownerId), eq(schema.drafts.candidateId, c.id))).orderBy(desc(schema.drafts.updatedAt), desc(schema.drafts.id)).all().find((d) => d.status !== "dropped");
  const preparing = ctx.db.select({ status: schema.llmJobs.status }).from(schema.llmJobs).where(and(eq(schema.llmJobs.ownerId, ownerId), eq(schema.llmJobs.candidateId, c.id))).all().some((row) => row.status === "pending" || row.status === "claimed");
  const posted = Boolean(ctx.db.select({ id: schema.publications.id }).from(schema.publications).where(and(eq(schema.publications.ownerId, ownerId), eq(schema.publications.candidateId, c.id))).get());
  return {
    candidateId: c.id, week: pick.week, pickedAt: pick.pickedAt, title: c.title, repo: c.repo, type: c.type as CandidateType,
    total: j?.total, reason: j?.reasoning.split("\n")[0] || (c.evidence as Evidence).highlights?.[0],
    draft: draft ? { id: draft.id, channel: draft.channel as Channel, lang: draft.lang, status: draft.status as DraftStatus } : undefined,
    preparing, posted,
  };
}

const ownersWithChannels = (ctx: AppContext) =>
  ctx.db.select({ ownerId: schema.settings.ownerId }).from(schema.settings).all().map((r) => r.ownerId).filter((id) => { const s = getSettings(ctx, id); return enabledTargets(s.channelLangs, s.customChannels).length > 0; });

/** 월요일 아침 예약 실행(수집과 한도 초기화 뒤). 채널을 켠 모든 계정에 대해 이번 주 한 편을 정한다. */
export function pickWeeklyAll(ctx: AppContext, now = Date.now()): number {
  let n = 0;
  for (const ownerId of ownersWithChannels(ctx)) {
    try { if (pickWeekly(ctx, ownerId, { now, background: true })) n++; }
    catch (err) { ctx.log.warn({ ownerId, err: (err as Error).message }, "weekly pick failed"); }
  }
  return n;
}

/** 매시간 정리. 준비를 건너뛰었거나 실패한 이번 주 한 편의 초안을 다시 준비한다. */
export function prepareWeeklyPicks(ctx: AppContext, now = Date.now()): number {
  let n = 0;
  for (const ownerId of ownersWithChannels(ctx)) {
    try { if (ensurePrepared(ctx, ownerId, { now, background: true })) n++; }
    catch (err) { ctx.log.warn({ ownerId, err: (err as Error).message }, "weekly pick preparation failed"); }
  }
  return n;
}
