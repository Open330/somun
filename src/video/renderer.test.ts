import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { afterAll, describe, expect, it } from "vitest";
import { Renderer, sampleTimes } from "./renderer.js";

/**
 * 실제 Chromium으로 도는 검사. 브라우저가 설치된 곳에서만 돈다(CI에는 없다):
 *   npx playwright-core install chromium-headless-shell
 */
const hasBrowser = (() => { try { return existsSync(chromium.executablePath()); } catch { return false; } })();
const size = { width: 640, height: 360 };

describe("sampleTimes", () => {
  it("samples every second from 0.5 s and the last frame", () => {
    expect(sampleTimes(3000)).toEqual([500, 1500, 2500, 3000 - 1000 / 30]);
  });
});

describe.skipIf(!hasBrowser)("Renderer (Chromium)", () => {
  const r = new Renderer();
  afterAll(() => r.close());

  it("drives CSS animations and timers from the virtual clock", async () => {
    const html = `<style>h1{opacity:0;animation:in .5s linear 1s forwards}@keyframes in{to{opacity:1}}</style><h1>first</h1><p id="p"></p>
      <script>setTimeout(() => { document.getElementById("p").textContent = "second"; }, 2000);</script>`;
    const ins = await r.inspect(html, size, 3000);
    expect(ins.samples.map((s) => s.text)).toEqual([[], ["first"], ["first", "second"], ["first", "second"]]);
    expect(ins.errors).toEqual([]);
  }, 30_000);

  it("blocks network requests other than fonts and every local file access", async () => {
    const dir = mkdtempSync(join(tmpdir(), "somun-render-"));
    const secret = join(dir, "secret.txt");
    writeFileSync(secret, "SECRET");
    const html = `<p>x</p><iframe src="file://${secret}"></iframe><img src="http://127.0.0.1:9/x.png">
      <script>fetch("file://${secret}").then(r => r.text()).then(t => document.body.append(t)).catch(() => {});
      fetch("http://169.254.169.254/latest/meta-data/").then(r => r.text()).then(t => document.body.append(t)).catch(() => {});</script>`;
    const ins = await r.inspect(html, size, 1000);
    expect(ins.samples.flatMap((s) => s.text).join(" ")).not.toContain("SECRET");
    expect(ins.errors.some((e) => e.includes("blocked request: http://127.0.0.1:9"))).toBe(true);
    expect(ins.errors.some((e) => e.includes("blocked request: http://169.254.169.254"))).toBe(true);
  }, 30_000);

  it("fails a scene that never yields instead of blocking the renderer, and keeps serving the next one", async () => {
    await expect(r.inspect(`<p>x</p><script>function f(){ setTimeout(f, 0); } f();</script>`, size, 1000)).rejects.toThrow(/too many timers/);
    await expect(r.inspect(`<p>x</p><script>setTimeout(() => { const s = Date.now(); while (Date.now() - s < 100) {} }, 100);</script>`, size, 1000)).rejects.toThrow(/did not finish/);
    const ok = await r.inspect(`<p>fine</p>`, size, 1000);
    expect(ok.samples[0].text).toEqual(["fine"]);
  }, 60_000);

  it("rejects when ffmpeg fails without taking the process down", async () => {
    const broken = new Renderer({ ffmpegPath: "/usr/bin/false" });
    const out = join(mkdtempSync(join(tmpdir(), "somun-render-")), "v.mp4");
    await expect(broken.render(`<h1>61</h1>`, size, 1000, out)).rejects.toThrow(/ffmpeg exited/);
    const missing = new Renderer({ ffmpegPath: "/nonexistent/ffmpeg" });
    await expect(missing.render(`<h1>61</h1>`, size, 1000, out)).rejects.toThrow();
    await Promise.all([broken.close(), missing.close()]);
  }, 60_000);

  it("relaunches the browser after it went away", async () => {
    const own = new Renderer();
    await own.inspect(`<p>a</p>`, size, 1000);
    await own.close();
    expect((await own.inspect(`<p>b</p>`, size, 1000)).samples[0].text).toEqual(["b"]);
    await own.close();
  }, 60_000);

  it("renders an MP4 of the requested length", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "somun-render-")), "v.mp4");
    await r.render(`<h1 style="font-size:60px">61</h1>`, size, 1000, out);
    expect(statSync(out).size).toBeGreaterThan(1000);
  }, 60_000);
});
