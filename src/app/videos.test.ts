import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import pino from "pino";
import { openDb, schema } from "../infra/db/index.js";
import type { VideoClient } from "../infra/video.js";
import type { Draft } from "../shared/types.js";
import type { RenderView, VideoBrief } from "../shared/video.js";
import { deleteAccount } from "./account.js";
import { GenerationConflictError, NotFoundError, UnavailableError, type AppContext } from "./context.js";
import { buildVideoBrief, listVideos, pickScriptDraft, requestVideo, videoFile } from "./videos.js";

type Fake = VideoClient & { briefs: VideoBrief[]; views: Map<string, RenderView | null>; removed: string[]; down: boolean };

function fakeClient(): Fake {
  const views = new Map<string, RenderView | null>();
  const f = {
    briefs: [] as VideoBrief[], views, removed: [] as string[], down: false,
    async create(_owner: string, brief: VideoBrief) {
      if (f.down) throw new Error("ECONNREFUSED");
      f.briefs.push(brief);
      const v: RenderView = { id: `r${f.briefs.length}`, status: "queued", phase: "Waiting for a local Claude Code bridge", createdAt: 1, updatedAt: 1 };
      views.set(v.id, v);
      return v;
    },
    async get(id: string) { if (f.down) throw new Error("down"); return views.get(id) ?? null; },
    async video() { return new Response("mp4", { headers: { "content-type": "video/mp4" } }); },
    async remove(id: string) { f.removed.push(id); },
  };
  return f as unknown as Fake;
}

function setup() {
  const video = fakeClient();
  const ctx: AppContext = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: { video }, bus: new EventEmitter(), usage: { record() {} } as unknown as AppContext["usage"] };
  const now = Date.now();
  const cand = (ownerId: string) => Number(ctx.db.insert(schema.candidates).values({ ownerId, type: "release", title: "muxa v0.8.47", repo: "Open330/muxa", key: `k-${ownerId}`, evidence: { repo: "Open330/muxa", repoUrl: "https://github.com/Open330/muxa", releaseCount: 61, stars: 28, highlights: ["Jumps to the pane that waited longest"] }, status: "drafted", createdAt: now, updatedAt: now }).run().lastInsertRowid);
  const draft = (ownerId: string, candidateId: number, over: Partial<typeof schema.drafts.$inferInsert> = {}) => Number(ctx.db.insert(schema.drafts).values({ ownerId, candidateId, channel: "x", lang: "en", version: 1, body: "61 releases, still 0.x", lint: [], status: "proposed", model: "m", createdAt: now, updatedAt: now, ...over }).run().lastInsertRowid);
  return { ctx, video, cand, draft };
}

const d = (over: Partial<Draft>): Draft => ({ id: 1, candidateId: 1, channel: "x", lang: "en", version: 1, body: "b", lint: [], status: "proposed", model: "m", createdAt: 0, updatedAt: 0, ...over });

describe("pickScriptDraft", () => {
  it("prefers the account language, then reviewed drafts, then short channels, and skips dropped ones", () => {
    const drafts = [
      d({ id: 1, channel: "linkedin", status: "copied", lang: "ko" }),
      d({ id: 2, channel: "x", status: "proposed", lang: "ko" }),
      d({ id: 3, channel: "threads", status: "edited", lang: "ko" }),
      d({ id: 4, channel: "x", status: "copied", lang: "en" }),
      d({ id: 5, channel: "x", status: "dropped", lang: "ko" }),
    ];
    expect(pickScriptDraft(drafts, "ko")?.id).toBe(1);
    expect(pickScriptDraft(drafts.filter((x) => x.id !== 1), "ko")?.id).toBe(3);
    expect(pickScriptDraft(drafts, "en")?.id).toBe(4);
    expect(pickScriptDraft(drafts, "ko", 2)?.id).toBe(2);
    expect(() => pickScriptDraft(drafts, "ko", 99)).toThrow(NotFoundError);
  });
});

describe("videos", () => {
  it("builds a brief from the evidence and the chosen draft, grounded like drafts", () => {
    const { ctx, cand, draft } = setup();
    const cid = cand("a");
    const did = draft("a", cid, { status: "copied", lang: "ko", body: "릴리스 61회" });
    const { brief, draftId } = buildVideoBrief(ctx, "a", cid, { durationSec: 15, aspect: "1:1" });
    expect(draftId).toBe(did);
    expect(brief).toMatchObject({ project: "muxa", repoUrl: "https://github.com/Open330/muxa", lang: "ko", durationSec: 15, aspect: "1:1", script: "릴리스 61회" });
    expect(brief.facts).toContain("releases: 61");
    expect(brief.grounding).toContain("61");
    expect(brief.voice.length).toBeGreaterThan(20);
    expect(brief.bannedPhrases).toContain("드디어");
  });

  it("refuses another owner's candidate or draft", () => {
    const { ctx, cand, draft } = setup();
    const mine = cand("a"), theirs = cand("b");
    const theirDraft = draft("b", theirs);
    expect(() => buildVideoBrief(ctx, "a", theirs, { durationSec: 15, aspect: "16:9" })).toThrow(NotFoundError);
    expect(() => buildVideoBrief(ctx, "a", mine, { durationSec: 15, aspect: "16:9", draftId: theirDraft })).toThrow(NotFoundError);
  });

  it("queues renders, limits open ones per owner, and reports an unreachable server", async () => {
    const { ctx, video, cand } = setup();
    const cid = cand("a");
    const v = await requestVideo(ctx, "a", cid, { durationSec: 10, aspect: "16:9" });
    expect(v).toMatchObject({ status: "queued", durationSec: 10, lang: "ko" });
    await requestVideo(ctx, "a", cid, { durationSec: 10, aspect: "16:9" });
    await expect(requestVideo(ctx, "a", cid, { durationSec: 10, aspect: "16:9" })).rejects.toThrow(GenerationConflictError);
    video.down = true;
    await expect(requestVideo(ctx, "b", cand("b"), { durationSec: 10, aspect: "16:9" })).rejects.toThrow(UnavailableError);
  });

  it("refreshes open videos from the video server and keeps the last state when it is down", async () => {
    const { ctx, video, cand } = setup();
    const cid = cand("a");
    const v = await requestVideo(ctx, "a", cid, { durationSec: 15, aspect: "16:9" });
    // 영상은 나왔지만 연출 메모는 아직: 계속 새로 받아 메모가 오면 채운다.
    video.views.set("r1", { id: "r1", status: "done", phase: "Rendered", createdAt: 1, updatedAt: 2 });
    expect((await listVideos(ctx, "a", cid))[0]).toMatchObject({ id: v.id, status: "done", phase: "Rendered" });
    video.views.set("r1", { id: "r1", status: "done", phase: "Done", note: "none", createdAt: 1, updatedAt: 3 });
    expect((await listVideos(ctx, "a", cid))[0]).toMatchObject({ id: v.id, status: "done", note: "none" });
    await requestVideo(ctx, "a", cid, { durationSec: 15, aspect: "16:9" });
    video.down = true;
    expect((await listVideos(ctx, "a", cid)).map((x) => x.status)).toEqual(["queued", "done"]);
    video.down = false;
    video.views.set("r2", null);
    expect((await listVideos(ctx, "a", cid))[0]).toMatchObject({ status: "failed", error: "the render is gone from the video server" });
  });

  it("serves only the owner's finished videos and cleans the video server on account deletion", async () => {
    const { ctx, video, cand } = setup();
    const cid = cand("a");
    const v = await requestVideo(ctx, "a", cid, { durationSec: 15, aspect: "16:9" });
    await expect(videoFile(ctx, "a", v.id)).rejects.toThrow(NotFoundError);
    video.views.set("r1", { id: "r1", status: "done", phase: "Done", createdAt: 1, updatedAt: 2 });
    await listVideos(ctx, "a", cid);
    expect((await videoFile(ctx, "a", v.id)).headers.get("content-type")).toBe("video/mp4");
    await expect(videoFile(ctx, "b", v.id)).rejects.toThrow(NotFoundError);
    expect(deleteAccount(ctx, "a").videos).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(video.removed).toEqual(["r1"]);
  });
});
