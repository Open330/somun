import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderUnsettled, type VideoBrief } from "../shared/video.js";
import type { Inspection } from "./renderer.js";
import { isBlocking, lintScene } from "./scene-lint.js";
import { VideoService, type RendererLike } from "./service.js";

const brief = (over: Partial<VideoBrief> = {}): VideoBrief => ({
  project: "muxa", repoUrl: "https://github.com/Open330/muxa", lang: "en", durationSec: 15, aspect: "16:9", headline: "muxa 0.8",
  facts: "releases: 61", grounding: "releases: 61\nstars: 28", voice: "plain", bannedPhrases: ["game-changer"], ...over,
});

/** HTML 안의 data-text를 그대로 "보이는 글자"로 돌려주는 가짜 렌더러. */
function fakeRenderer(): RendererLike & { rendered: string[] } {
  const rendered: string[] = [];
  return {
    rendered,
    async inspect(html): Promise<Inspection> {
      const text = [...html.matchAll(/data-text="([^"]*)"/g)].map((m) => m[1]);
      return { samples: [{ t: 500, text, overflow: [] }], errors: html.includes("throw") ? ["page error: boom"] : [], thumbnails: [{ t: 500, jpeg: Buffer.from("jpg") }] };
    },
    async render(html, _size, _ms, out) { rendered.push(html); writeFileSync(out, "mp4"); },
  };
}

const newService = (renderer: RendererLike = fakeRenderer(), now?: () => number) => new VideoService(mkdtempSync(join(tmpdir(), "somun-video-test-")), renderer, { model: "opus", sessionTimeoutSec: 600, now });

describe("lintScene", () => {
  it("flags numbers outside the grounding, banned phrases, exclamation marks and errors, but only warns on overflow", () => {
    const problems = lintScene([{ t: 500, text: ["61 releases", "3x faster!", "a game-changer"], overflow: ["\"wide\""] }], ["page error: x"], "releases: 61", ["game-changer"]);
    expect(problems.map((p) => p.kind).sort()).toEqual(["banned", "error", "exclamation", "number", "overflow"]);
    expect(problems.find((p) => p.kind === "number")?.detail).toContain("3x");
    expect(problems.filter(isBlocking).map((p) => p.kind)).not.toContain("overflow");
  });
  it("passes text whose numbers are all grounded", () => {
    expect(lintScene([{ t: 0, text: ["61 releases, 28 stars"], overflow: [] }], [], "releases: 61\nstars: 28", [])).toEqual([]);
  });
  it("rejects a scene that never shows text", () => {
    expect(lintScene([{ t: 0, text: [], overflow: [] }], [], "", []).map((p) => p.kind)).toEqual(["empty"]);
  });
});

describe("VideoService", () => {
  it("runs create → claim → check → render and only renders clean scenes", async () => {
    const renderer = fakeRenderer();
    const svc = newService(renderer);
    const r = svc.create("owner-a", brief());
    expect(svc.claim("owner-b", "b")).toBeNull();
    const ticket = svc.claim("owner-a", "bridge-1")!;
    expect(ticket.renderId).toBe(r.id);
    expect(ticket.user).toContain("exactly 15 seconds");
    expect(svc.get(r.id).status).toBe("working");

    const bad = await svc.checkScene(ticket.token, `<p data-text="99 releases"></p>`);
    expect(bad.clean).toBe(false);
    await expect(svc.renderScene(ticket.token, bad.sceneId)).rejects.toThrow(/blocking problems/);

    const good = await svc.checkScene(ticket.token, `<p data-text="61 releases"></p>`);
    expect(good.clean).toBe(true);
    await svc.renderScene(ticket.token, good.sceneId);
    expect(renderer.rendered).toEqual([`<p data-text="61 releases"></p>`]);
    expect(svc.get(r.id)).toMatchObject({ status: "done", phase: "Rendered" });
    expect(existsSync(svc.video(r.id))).toBe(true);

    svc.finish(ticket.token, { note: "none", costUsd: 0.3 });
    expect(svc.get(r.id)).toMatchObject({ status: "done", phase: "Done", note: "none" });
    // 세션이 끝나면 토큰은 더 쓸 수 없다.
    await expect(svc.checkScene(ticket.token, "<p></p>")).rejects.toThrow(/unknown session/);
  });

  it("fails a session that ends without a video and keeps the model's error", () => {
    const svc = newService();
    const r = svc.create("a", brief());
    const ticket = svc.claim("*", "b")!;
    svc.finish(ticket.token, { error: "weekly limit" });
    expect(svc.get(r.id)).toMatchObject({ status: "failed", error: "weekly limit" });
  });

  it("does not let one session touch another render", async () => {
    const svc = newService();
    svc.create("a", brief());
    const r2 = svc.create("a", brief());
    const t1 = svc.claim("*", "b")!;
    const t2 = svc.claim("*", "b")!;
    expect(t2.renderId).toBe(r2.id);
    const s = await svc.checkScene(t1.token, `<p data-text="61"></p>`);
    await expect(svc.renderScene(t2.token, s.sceneId)).rejects.toThrow(/unknown scene_id/);
  });

  it("times out a session whose bridge disappeared", () => {
    let now = 1_000_000;
    const svc = newService(fakeRenderer(), () => now);
    const r = svc.create("a", brief());
    svc.claim("*", "b");
    now += 700_000;
    expect(svc.get(r.id)).toMatchObject({ status: "failed", error: "the session timed out" });
  });

  it("keeps a rendered video when the bridge never reports back", async () => {
    let now = 1_000_000;
    const svc = newService(fakeRenderer(), () => now);
    const r = svc.create("a", brief());
    const ticket = svc.claim("*", "b")!;
    await svc.renderScene(ticket.token, (await svc.checkScene(ticket.token, `<p data-text="61"></p>`)).sceneId);
    now += 700_000;
    expect(svc.get(r.id)).toMatchObject({ status: "done", phase: "Done" });
  });

  it("discards a render that finishes after the session ended, instead of leaving it half done", async () => {
    let release!: () => void;
    const slow: RendererLike = { ...fakeRenderer(), async render(_h, _s, _m, out) { await new Promise<void>((r) => (release = r)); writeFileSync(out, "mp4"); } };
    const svc = newService(slow);
    const r = svc.create("a", brief());
    const ticket = svc.claim("*", "b")!;
    const scene = await svc.checkScene(ticket.token, `<p data-text="61"></p>`);
    const rendering = svc.renderScene(ticket.token, scene.sceneId);
    await new Promise((res) => setTimeout(res, 0));
    // 같은 세션의 두 번째 도구 호출은 기다리지 않고 거절한다.
    await expect(svc.checkScene(ticket.token, `<p data-text="61"></p>`)).rejects.toThrow(/still running/);
    svc.finish(ticket.token, { error: "claude killed" });
    release();
    await expect(rendering).rejects.toThrow(/render is failed/);
    const view = svc.get(r.id);
    expect(view).toMatchObject({ status: "failed", error: "claude killed" });
    expect(renderUnsettled(view)).toBe(false);
    expect(() => svc.video(r.id)).toThrow(/not found/);
  });

  it("does not bring a removed render back when an in-flight render finishes", async () => {
    let release!: () => void;
    const slow: RendererLike = { ...fakeRenderer(), async render(_h, _s, _m, out) { await new Promise<void>((r) => (release = r)); writeFileSync(out, "mp4"); } };
    const dir = mkdtempSync(join(tmpdir(), "somun-video-test-"));
    const svc = new VideoService(dir, slow, { model: "opus", sessionTimeoutSec: 600 });
    const r = svc.create("a", brief());
    const ticket = svc.claim("*", "b")!;
    const rendering = svc.renderScene(ticket.token, (await svc.checkScene(ticket.token, `<p data-text="61"></p>`)).sceneId);
    await new Promise((res) => setTimeout(res, 0));
    svc.remove(r.id);
    release();
    await expect(rendering).rejects.toThrow(/gone/);
    expect(existsSync(join(dir, "renders", `${r.id}.json`))).toBe(false);
    expect(existsSync(join(dir, "renders", `${r.id}.mp4`))).toBe(false);
  });

  it("marks sessions that were running during a restart as failed and removes renders", () => {
    const dir = mkdtempSync(join(tmpdir(), "somun-video-test-"));
    const first = new VideoService(dir, fakeRenderer(), { model: "opus", sessionTimeoutSec: 600 });
    const r = first.create("a", brief());
    first.claim("*", "b");
    const second = new VideoService(dir, fakeRenderer(), { model: "opus", sessionTimeoutSec: 600 });
    expect(second.get(r.id).status).toBe("failed");
    second.remove(r.id);
    expect(() => second.get(r.id)).toThrow(/not found/);
    expect(() => new VideoService(dir, fakeRenderer(), { model: "opus", sessionTimeoutSec: 600 }).get(r.id)).toThrow(/not found/);
  });
});
