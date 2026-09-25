import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VIDEO_SIZE, type RenderStatus, type RenderView, type VideoBrief } from "../shared/video.js";
import { directorSystem, directorUser } from "./prompt.js";
import type { Inspection, SceneSize } from "./renderer.js";
import { isBlocking, lintScene, type SceneProblem } from "./scene-lint.js";

/**
 * 영상 서버의 상태. 렌더 요청 → 대기 → bridge가 세션으로 가져감 → 모델이 도구로 검사·렌더 → 끝.
 * 기록은 DATA_DIR/renders/<id>.json 한 파일씩(단일 프로세스). 영상은 같은 곳의 <id>.mp4.
 *
 * 세션 토큰은 그 렌더 하나의 도구만 부를 수 있다. bridge가 쓰는 MCP 설정에 들어가고, 세션이 끝나면 버린다.
 */
export type RendererLike = {
  inspect(html: string, size: SceneSize, durationMs: number): Promise<Inspection>;
  render(html: string, size: SceneSize, durationMs: number, outFile: string, onProgress?: (fraction: number) => void): Promise<void>;
};

type Scene = { id: string; clean: boolean };
type RenderRecord = RenderView & {
  owner: string;
  brief: VideoBrief;
  session?: { id: string; tokenHash: string; bridge: string; claimedAt: number };
  scenes: Scene[];
  usage?: { model?: string; costUsd?: number; durationMs?: number };
};

export type SessionTicket = { sessionId: string; renderId: string; token: string; system: string; user: string; model: string; timeoutSec: number };
export type CheckResult = { sceneId: string; clean: boolean; problems: SceneProblem[]; visible: { t: number; text: string[] }[]; thumbnails: { t: number; jpeg: Buffer }[] };

export const MAX_SCENE_BYTES = 300_000;
const MAX_SCENES = 12;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const newId = (bytes = 12) => randomBytes(bytes).toString("base64url");

export class VideoError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 404 | 409 = 400) { super(message); }
}

export class VideoService {
  private readonly renders = new Map<string, RenderRecord>();
  /** 지금 도구 호출(검사·렌더)이 돌고 있는 렌더. 한 세션의 도구 호출은 한 번에 하나만. */
  private readonly busy = new Set<string>();
  private readonly dir: string;

  constructor(dataDir: string, private readonly renderer: RendererLike, private readonly opts: { model: string; sessionTimeoutSec: number; now?: () => number }) {
    this.dir = join(dataDir, "renders");
    mkdirSync(this.dir, { recursive: true });
    for (const f of readdirSync(this.dir).filter((x) => x.endsWith(".json"))) {
      const r = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as RenderRecord;
      // 재시작 전에 돌던 세션은 이어 갈 수 없다(모델 쪽 연결이 끊겼다).
      if (r.status === "working") Object.assign(r, { status: "failed", error: "video server restarted during the session", session: undefined });
      if (r.status === "done" && r.session) Object.assign(r, { phase: "Done", session: undefined });
      this.renders.set(r.id, r);
    }
  }

  private now() { return this.opts.now?.() ?? Date.now(); }
  /** 지워진(계정 삭제) 렌더는 진행 중이던 도구 호출이 끝나도 다시 쓰지 않는다. */
  private alive(r: RenderRecord) { return this.renders.get(r.id) === r; }
  private save(r: RenderRecord) {
    if (!this.alive(r)) return;
    r.updatedAt = this.now();
    const file = join(this.dir, `${r.id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(r));
    renameSync(`${file}.tmp`, file);
  }
  private sceneFile(r: RenderRecord, sceneId: string) { return join(this.dir, r.id, `${sceneId}.html`); }
  videoFile(id: string) { return join(this.dir, `${id}.mp4`); }

  private view(r: RenderRecord): RenderView {
    return { id: r.id, status: r.status, phase: r.phase, note: r.note, error: r.error, createdAt: r.createdAt, updatedAt: r.updatedAt };
  }

  create(owner: string, brief: VideoBrief): RenderView {
    const now = this.now();
    const r: RenderRecord = { id: newId(), owner, brief, status: "queued", phase: "Waiting for a local Claude Code bridge", createdAt: now, updatedAt: now, scenes: [] };
    this.renders.set(r.id, r);
    this.save(r);
    return this.view(r);
  }

  get(id: string): RenderView {
    const r = this.renders.get(id);
    if (!r) throw new VideoError("render not found", 404);
    this.expire(r);
    return this.view(r);
  }

  /** 끝난 영상 파일 경로. 없으면 404. */
  video(id: string): string {
    const r = this.renders.get(id);
    if (!r || r.status !== "done" || !existsSync(this.videoFile(id))) throw new VideoError("video not found", 404);
    return this.videoFile(id);
  }

  /** 기록·장면·영상을 지운다(somun 계정 삭제). 진행 중이면 세션도 끊긴다. */
  remove(id: string): void {
    const r = this.renders.get(id);
    if (!r) throw new VideoError("render not found", 404);
    this.renders.delete(id);
    for (const f of [`${id}.json`, `${id}.mp4`, `${id}.mp4.part.mp4`]) rmSync(join(this.dir, f), { force: true });
    rmSync(join(this.dir, id), { recursive: true, force: true });
  }

  /** bridge가 가져갈 다음 렌더. owner가 "*"이면 누구의 것이든(단일 사용자 로컬 테스트). */
  claim(bridgeOwner: string, bridge: string): SessionTicket | null {
    for (const r of this.renders.values()) this.expire(r);
    const next = [...this.renders.values()].filter((r) => r.status === "queued" && (bridgeOwner === "*" || r.owner === bridgeOwner)).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!next) return null;
    const token = newId(24);
    next.session = { id: newId(8), tokenHash: hash(token), bridge, claimedAt: this.now() };
    next.status = "working";
    next.phase = "Writing the scene";
    this.save(next);
    return { sessionId: next.session.id, renderId: next.id, token, system: directorSystem(), user: directorUser(next.brief), model: this.opts.model, timeoutSec: this.opts.sessionTimeoutSec };
  }

  /** MCP 연결 확인(initialize, tools/list)용. 진행 중인 세션의 토큰인가. */
  hasSession(token: string): boolean {
    try { this.bySession(token); return true; } catch { return false; }
  }

  /** 도구 호출 하나를 이 렌더에 대해 한 번에 하나만 돌린다. */
  private async exclusiveTool<T>(r: RenderRecord, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(r.id)) throw new VideoError("another tool call for this video is still running; wait for it", 409);
    this.busy.add(r.id);
    try { return await fn(); } finally { this.busy.delete(r.id); }
  }

  /** 세션 토큰 → 진행 중인 렌더. */
  private bySession(token: string): RenderRecord {
    const h = hash(token);
    const r = [...this.renders.values()].find((x) => x.session?.tokenHash === h);
    if (!r) throw new VideoError("unknown session", 401);
    this.expire(r);
    if (r.status !== "working") throw new VideoError(`render is ${r.status}`, 409);
    return r;
  }

  async checkScene(token: string, html: string): Promise<CheckResult> {
    const r = this.bySession(token);
    if (Buffer.byteLength(html) > MAX_SCENE_BYTES) throw new VideoError(`scene is larger than ${MAX_SCENE_BYTES} bytes`);
    if (r.scenes.length >= MAX_SCENES) throw new VideoError(`too many checks for one video (${MAX_SCENES}); simplify the scene`, 409);
    return this.exclusiveTool(r, async () => {
      r.phase = "Checking the scene";
      this.save(r);
      const ms = r.brief.durationSec * 1000;
      const ins = await this.renderer.inspect(html, VIDEO_SIZE[r.brief.aspect], ms).catch((err: Error) => {
        if (this.alive(r) && r.status === "working") { r.phase = "Fixing the scene"; this.save(r); }
        throw new VideoError(`the scene could not be checked: ${err.message.slice(0, 400)}`);
      });
      const problems = lintScene(ins.samples, ins.errors, r.brief.grounding, r.brief.bannedPhrases);
      const scene: Scene = { id: `s${r.scenes.length + 1}`, clean: !problems.some(isBlocking) };
      // 검사하는 동안 세션이 끝났거나 계정이 지워졌으면 아무것도 남기지 않는다.
      if (!this.alive(r) || r.status !== "working") throw new VideoError(`render is ${this.alive(r) ? r.status : "gone"}`, 409);
      mkdirSync(join(this.dir, r.id), { recursive: true });
      writeFileSync(this.sceneFile(r, scene.id), html);
      r.scenes.push(scene);
      r.phase = scene.clean ? "Scene passed the check" : "Fixing the scene";
      this.save(r);
      return { sceneId: scene.id, clean: scene.clean, problems, visible: ins.samples.map((s) => ({ t: s.t, text: s.text })), thumbnails: ins.thumbnails };
    });
  }

  /** 검사를 통과한 장면만 렌더한다. 통과하지 않은 장면을 모델이 억지로 내보낼 수 없다. */
  async renderScene(token: string, sceneId: string): Promise<{ seconds: number }> {
    const r = this.bySession(token);
    const scene = r.scenes.find((s) => s.id === sceneId);
    if (!scene) throw new VideoError(`unknown scene_id ${sceneId}`, 404);
    if (!scene.clean) throw new VideoError(`scene ${sceneId} has blocking problems; fix them and run check_scene again`, 409);
    return this.exclusiveTool(r, async () => {
      r.phase = "Rendering";
      this.save(r);
      const out = this.videoFile(r.id);
      const part = `${out}.part.mp4`;
      const html = readFileSync(this.sceneFile(r, sceneId), "utf8");
      try {
        await this.renderer.render(html, VIDEO_SIZE[r.brief.aspect], r.brief.durationSec * 1000, part, (f) => { r.phase = `Rendering ${Math.round(f * 100)}%`; });
      } catch (err) {
        rmSync(part, { force: true });
        if (this.alive(r) && r.status === "working") { r.phase = "Render failed; fix the scene or try again"; this.save(r); }
        throw new VideoError(`render failed: ${(err as Error).message.slice(0, 400)}`);
      }
      // 렌더하는 동안 세션이 끝났거나(시간 초과, bridge 종료) 계정이 지워졌으면 결과를 버린다.
      if (!this.alive(r) || r.status !== "working" || !r.session) {
        rmSync(part, { force: true });
        throw new VideoError(`render is ${this.alive(r) ? r.status : "gone"}`, 409);
      }
      renameSync(part, out);
      // 영상은 나왔지만 모델의 메모가 아직이다. bridge가 finish를 부르면 "Done"이 된다.
      r.status = "done";
      r.phase = "Rendered";
      this.save(r);
      return { seconds: r.brief.durationSec };
    });
  }

  /** bridge가 모델 실행을 마쳤다. 렌더 없이 끝났으면 실패로 남긴다. 세션 토큰은 여기서 버린다. */
  finish(token: string, result: { note?: string; error?: string; model?: string; costUsd?: number; durationMs?: number }): RenderView {
    const h = hash(token);
    const r = [...this.renders.values()].find((x) => x.session?.tokenHash === h);
    if (!r) throw new VideoError("unknown session", 401);
    if (result.note) r.note = result.note.slice(0, 2000);
    r.usage = { model: result.model, costUsd: result.costUsd, durationMs: result.durationMs };
    if (r.status === "working") {
      r.status = "failed";
      r.error = (result.error ?? "the director stopped without rendering a video").slice(0, 1000);
    }
    if (r.status === "done") r.phase = "Done";
    r.session = undefined;
    this.save(r);
    return this.view(r);
  }

  /** 제한 시간을 넘긴 세션은 실패로 닫는다(bridge가 죽었거나 모델이 멈췄다). */
  private expire(r: RenderRecord) {
    if (!r.session || this.now() - r.session.claimedAt <= this.opts.sessionTimeoutSec * 1000 + 60_000) return;
    // 렌더까지 마쳤으면 영상은 살리고 메모만 포기한다.
    if (r.status === "done") Object.assign(r, { phase: "Done", session: undefined });
    else if (r.status === "working") Object.assign(r, { status: "failed" as RenderStatus, error: "the session timed out", session: undefined });
    else return;
    this.save(r);
  }
}
