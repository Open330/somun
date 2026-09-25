import { and, desc, eq, inArray } from "drizzle-orm";
import { groundingText, factsBlock } from "../core/prompts.js";
import { voiceGuideFor } from "../core/voice.js";
import { schema } from "../infra/db/index.js";
import type { Draft, Evidence } from "../shared/types.js";
import { renderUnsettled, type RenderStatus, type RenderView, type VideoAspect, type VideoBrief, type VideoDuration, type VideoItem } from "../shared/video.js";
import { getCandidateRow, toDraft } from "./candidates.js";
import { GenerationConflictError, NotFoundError, UnavailableError, type AppContext } from "./context.js";
import { getProfile } from "./profiles.js";
import { getSettings } from "./settings.js";

/**
 * 글감 → 짧은 영상. somun은 기획서(근거 사실, 검수한 초안, 문체)를 만들어 영상 서버에 맡기고 상태만 따라간다.
 * 연출은 사용자의 컴퓨터에서 bridge가 띄운 Claude Code가 하고, 렌더는 영상 서버가 한다.
 * 화면에 나오는 숫자는 영상 서버가 초안과 같은 근거(groundingText)로 검사한다.
 */
const OPEN = ["queued", "working"];
/** 한 계정이 동시에 기다리게 할 수 있는 영상 수. 모델 호출은 사용자 구독이지만 렌더는 서버 CPU다. */
const MAX_OPEN_PER_OWNER = 2;
/** 대본으로 쓸 초안: 검수한 것 먼저, 짧은 채널 먼저. */
const STATUS_RANK: Record<string, number> = { copied: 0, edited: 1, proposed: 2 };
const CHANNEL_RANK = ["x", "threads", "linkedin", "show_gn", "show_hn", "blog"];

export const videoEnabled = (ctx: AppContext) => Boolean(ctx.env.video);

const toItem = (r: typeof schema.videos.$inferSelect): VideoItem => ({
  id: r.id, candidateId: r.candidateId, draftId: r.draftId ?? undefined, lang: r.lang, durationSec: r.durationSec, aspect: r.aspect as VideoAspect,
  status: r.status as VideoItem["status"], phase: r.phase, note: r.note ?? undefined, error: r.error ?? undefined, createdAt: r.createdAt, updatedAt: r.updatedAt,
});

/** 대본 초안을 고른다. draftId가 있으면 그것(이 글감의 것이어야 한다), 없으면 가장 검수된 짧은 채널 초안. */
export function pickScriptDraft(drafts: Draft[], lang: string, draftId?: number): Draft | undefined {
  if (draftId !== undefined) {
    const d = drafts.find((x) => x.id === draftId);
    if (!d) throw new NotFoundError("draft");
    return d;
  }
  const usable = drafts.filter((d) => d.status !== "dropped");
  const rank = (d: Draft) => [d.lang === lang ? 0 : 1, STATUS_RANK[d.status] ?? 3, CHANNEL_RANK.indexOf(d.channel) < 0 ? 9 : CHANNEL_RANK.indexOf(d.channel), -d.version];
  return usable.sort((a, b) => { const ra = rank(a), rb = rank(b); for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i]; return 0; })[0];
}

export function buildVideoBrief(ctx: AppContext, ownerId: string, candidateId: number, opts: { durationSec: VideoDuration; aspect: VideoAspect; draftId?: number }): { brief: VideoBrief; draftId?: number } {
  const c = getCandidateRow(ctx, ownerId, candidateId);
  const settings = getSettings(ctx, ownerId);
  const profile = getProfile(ctx, ownerId, c.repo)?.profile;
  const ev = c.evidence as Evidence;
  const cand = { title: c.title, type: c.type, evidence: ev };
  const drafts = ctx.db.select().from(schema.drafts).where(and(eq(schema.drafts.candidateId, c.id), eq(schema.drafts.ownerId, ownerId))).all().map(toDraft);
  const preferred = settings.ui?.locale ?? "ko";
  const draft = pickScriptDraft(drafts, preferred, opts.draftId);
  const lang = draft?.lang ?? preferred;
  const brief: VideoBrief = {
    project: ev.repo.split("/").pop() || ev.repo,
    repoUrl: ev.repoUrl,
    lang,
    durationSec: opts.durationSec,
    aspect: opts.aspect,
    headline: c.title,
    facts: factsBlock(cand, profile),
    grounding: groundingText(cand, profile),
    script: draft ? [draft.title, draft.body].filter(Boolean).join("\n\n") : undefined,
    voice: voiceGuideFor(settings.voice, lang),
    bannedPhrases: settings.bannedPhrases,
  };
  return { brief, draftId: draft?.id };
}

export async function requestVideo(ctx: AppContext, ownerId: string, candidateId: number, opts: { durationSec: VideoDuration; aspect: VideoAspect; draftId?: number }): Promise<VideoItem> {
  const client = ctx.env.video;
  if (!client) throw new NotFoundError("video server");
  const open = ctx.db.select().from(schema.videos).where(and(eq(schema.videos.ownerId, ownerId), inArray(schema.videos.status, OPEN))).all();
  if (open.length >= MAX_OPEN_PER_OWNER) throw new GenerationConflictError(`${open.length} videos are already in progress`);
  const { brief, draftId } = buildVideoBrief(ctx, ownerId, candidateId, opts);
  let render: RenderView;
  try {
    render = await client.create(ownerId, brief);
  } catch (err) {
    ctx.log.warn({ err: (err as Error).message }, "video server create failed");
    throw new UnavailableError("the video server is not reachable");
  }
  const now = Date.now();
  const id = Number(ctx.db.insert(schema.videos).values({ ownerId, candidateId, draftId: draftId ?? null, renderId: render.id, lang: brief.lang, durationSec: brief.durationSec, aspect: brief.aspect, status: render.status, phase: render.phase, createdAt: now, updatedAt: now }).run().lastInsertRowid);
  return toItem(ctx.db.select().from(schema.videos).where(eq(schema.videos.id, id)).get()!);
}

/** 글감의 영상. 진행 중인 것은 영상 서버에서 상태를 새로 받는다(닿지 않으면 마지막 상태 그대로). */
export async function listVideos(ctx: AppContext, ownerId: string, candidateId: number): Promise<VideoItem[]> {
  getCandidateRow(ctx, ownerId, candidateId);
  const rows = ctx.db.select().from(schema.videos).where(and(eq(schema.videos.ownerId, ownerId), eq(schema.videos.candidateId, candidateId))).orderBy(desc(schema.videos.createdAt)).all();
  const client = ctx.env.video;
  if (client) {
    await Promise.all(rows.filter((r) => renderUnsettled({ status: r.status as RenderStatus, phase: r.phase })).map(async (r) => {
      const view = await client.get(r.renderId).catch(() => undefined);
      if (view === undefined) return;
      const next = view ?? { status: "failed" as const, phase: "", note: undefined, error: "the render is gone from the video server" };
      if (next.status === r.status && next.phase === r.phase && (next.note ?? null) === r.note) return;
      const patch = { status: next.status, phase: next.phase, note: next.note ?? null, error: next.error ?? null, updatedAt: Date.now() };
      ctx.db.update(schema.videos).set(patch).where(eq(schema.videos.id, r.id)).run();
      Object.assign(r, patch);
    }));
  }
  return rows.map(toItem);
}

/** 영상 파일. 이 계정의 끝난 영상만. */
export async function videoFile(ctx: AppContext, ownerId: string, id: number, range?: string): Promise<Response> {
  const row = ctx.db.select().from(schema.videos).where(and(eq(schema.videos.id, id), eq(schema.videos.ownerId, ownerId))).get();
  if (!row || row.status !== "done" || !ctx.env.video) throw new NotFoundError("video");
  const res = await ctx.env.video.video(row.renderId, range).catch(() => { throw new UnavailableError("the video server is not reachable"); });
  if (res.status === 404) throw new NotFoundError("video");
  return res;
}

/** 계정 삭제 뒤 영상 서버의 파일도 지운다. 실패해도 계정 삭제는 이미 끝났다. */
export async function removeVideoRenders(ctx: AppContext, renderIds: string[]): Promise<void> {
  const client = ctx.env.video;
  if (!client) return;
  for (const id of renderIds) await client.remove(id).catch((err: Error) => ctx.log.warn({ err: err.message, id }, "video render cleanup failed"));
}
