import { spawn } from "node:child_process";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { VIRTUAL_CLOCK, VISIBLE_TEXT } from "./clock.js";
import type { SceneSample } from "./scene-lint.js";

/**
 * 모델이 쓴 HTML 한 장을 가상 시계 아래에서 연다. 두 가지 일을 한다.
 *  - inspect: 여러 시점의 보이는 글자·오류·축소 화면을 모은다(check_scene).
 *  - render: 프레임마다 시계를 옮겨 캡처하고 ffmpeg로 MP4를 만든다(render_video).
 *
 * 모델이 쓴 HTML을 서버의 브라우저가 여는 것이므로 네트워크는 폰트만 허용한다.
 * 그 밖의 요청(내부망 주소 포함)은 모두 끊고, 끊은 주소는 오류로 모델에게 돌려준다.
 */
export type SceneSize = { width: number; height: number };
export type Inspection = { samples: SceneSample[]; errors: string[]; thumbnails: { t: number; jpeg: Buffer }[] };

const FPS = 30;
const ALLOWED_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);
const LOAD_TIMEOUT_MS = 20_000;

export class Renderer {
  private browser?: Promise<Browser>;
  /** 렌더는 CPU를 다 쓰므로 한 번에 하나씩. 검사도 같은 줄에 선다. */
  private line: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: { ffmpegPath?: string; executablePath?: string } = {}) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.line.then(fn, fn);
    this.line = run.catch(() => undefined);
    return run;
  }

  private async open(html: string, size: SceneSize): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
    this.browser ??= chromium.launch({ headless: true, executablePath: this.opts.executablePath });
    const browser = await this.browser;
    const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 1, serviceWorkers: "block", javaScriptEnabled: true });
    const errors: string[] = [];
    await ctx.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === "https:" && ALLOWED_HOSTS.has(url.hostname)) return route.continue();
      errors.push(`blocked request: ${url.origin}${url.pathname.slice(0, 80)} (only Google Fonts may be loaded; inline everything else)`);
      return route.abort("blockedbyclient");
    });
    await ctx.routeWebSocket(/.*/, (ws) => { errors.push("blocked WebSocket"); void ws.close(); });
    await ctx.addInitScript({ content: VIRTUAL_CLOCK });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`page error: ${e.message.slice(0, 300)}`));
    page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("ERR_BLOCKED_BY_CLIENT")) errors.push(`console error: ${m.text().slice(0, 300)}`); });
    try {
      await page.setContent(html, { waitUntil: "load", timeout: LOAD_TIMEOUT_MS });
      await page.evaluate("document.fonts.ready.then(() => { window.__adopt(); return true; })");
    } catch (err) {
      await ctx.close();
      throw err;
    }
    return { ctx, page, errors };
  }

  inspect(html: string, size: SceneSize, durationMs: number): Promise<Inspection> {
    return this.exclusive(async () => {
      const { ctx, page, errors } = await this.open(html, size);
      try {
        const times = sampleTimes(durationMs);
        const shots = new Set([0.15, 0.4, 0.65, 0.95].map((f) => nearest(times, f * durationMs)));
        const samples: SceneSample[] = [];
        const thumbnails: Inspection["thumbnails"] = [];
        for (const t of times) {
          await page.evaluate(`window.__seek(${t})`);
          const v = (await page.evaluate(VISIBLE_TEXT)) as { text: string[]; overflow: string[] };
          samples.push({ t, ...v });
          if (shots.has(t)) thumbnails.push({ t, jpeg: await page.screenshot({ type: "jpeg", quality: 60 }) });
        }
        return { samples, errors, thumbnails };
      } finally {
        await ctx.close();
      }
    });
  }

  render(html: string, size: SceneSize, durationMs: number, outFile: string, onProgress?: (fraction: number) => void): Promise<void> {
    return this.exclusive(async () => {
      const { ctx, page } = await this.open(html, size);
      const ff = spawn(this.opts.ffmpegPath ?? "ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-r", String(FPS), outFile], { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      ff.stderr.on("data", (d) => (stderr += d));
      const done = new Promise<void>((resolve, reject) => {
        ff.on("error", reject);
        ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`))));
      });
      try {
        const total = Math.round((durationMs / 1000) * FPS);
        for (let i = 0; i < total; i++) {
          await page.evaluate(`window.__seek(${(i * 1000) / FPS})`);
          const frame = await page.screenshot({ type: "jpeg", quality: 92 });
          if (!ff.stdin.write(frame)) await new Promise((r) => ff.stdin.once("drain", r));
          if (i % FPS === 0) onProgress?.(i / total);
        }
        ff.stdin.end();
        await done;
      } catch (err) {
        ff.kill("SIGKILL");
        throw err;
      } finally {
        await ctx.close();
      }
    });
  }

  async close(): Promise<void> {
    const b = await this.browser?.catch(() => undefined);
    await b?.close();
  }
}

/** 0.5초부터 1초 간격, 그리고 마지막 프레임. */
export function sampleTimes(durationMs: number): number[] {
  const out: number[] = [];
  for (let t = 500; t < durationMs; t += 1000) out.push(t);
  out.push(durationMs - 1000 / FPS);
  return out;
}

const nearest = (times: number[], target: number) => times.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
