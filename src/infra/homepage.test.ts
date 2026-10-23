import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publicFetch } from "./net.js";
import { collectHomepage, homepageText } from "./homepage.js";

vi.mock("./net.js", () => ({ publicFetch: vi.fn() }));
const mockFetch = vi.mocked(publicFetch);
const url = "https://example.com/product";
function respond(body: string | ReadableStream<Uint8Array> | null, headers: Record<string, string> = { "content-type": "text/html" }, status = 200) {
  const response = new Response(body, { headers, status });
  Object.defineProperty(response, "url", { value: "https://www.example.com/product" });
  mockFetch.mockResolvedValue(response as never);
  return response;
}
beforeEach(() => { mockFetch.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe("homepage HTML evidence", () => {
  it("prefers main, retains both language branches and closed FAQ answers, and removes non-content", () => {
    const result = homepageText(`<!doctype html><html lang="ko"><head><title>Metadata</title><style>p { color: red }</style></head><body>
      <header>Header</header><nav>Navigation</nav><p>Outside main</p><main><h1>Product</h1>
      <p><span lang="ko">한국어 조건</span><span lang="en">English condition</span></p>
      <details><summary>Can guests use it?</summary><p>Only authorized accounts may access files.</p></details>
      <script>if (a < b) { console.log("<main>fake</main>") }</script><svg><text>Illustration</text></svg>
      <div hidden>Hidden</div><div aria-hidden="TRUE">Aria hidden</div><p style="display: none !important">CSS hidden</p>
      <p style="visibility:hidden">Invisible</p></main><footer>Footer</footer></body></html>`);
    expect(result).toMatchObject({ language: "ko", truncated: false });
    for (const text of ["Product", "한국어 조건", "English condition", "Can guests use it?", "Only authorized accounts may access files."]) expect(result?.text).toContain(text);
    for (const text of ["Metadata", "Header", "Navigation", "Outside main", "fake", "Illustration", "Hidden", "Aria hidden", "CSS hidden", "Invisible", "Footer"]) expect(result?.text).not.toContain(text);
  });
  it("retains the actual Itda FAQ's scope and access conditions in both languages", () => {
    // Verbatim FAQ fragments from https://jiun.dev/itda/, retrieved 2026-10-23.
    const source = `<main><section id="faq">
      <details><summary><span lang="ko">Mac에 무엇을 설치해야 하나요?</span><span lang="en">What do I install on the Mac?</span></summary><div><p><span lang="ko">기본 화면 연결을 받는 Mac에는 별도 앱이 필요 없습니다. 시스템 설정 → 일반 → 공유에서 ‘화면 공유’를 켜세요. 파일 브라우저나 SSH 터널을 쓰려면 ‘원격 로그인’도 켜고 계정 접근을 허용해야 합니다. 선택 기능인 고성능 모드는 상대 Mac에도 Itda를 설치하며 화면 기록·손쉬운 사용 권한이 필요합니다.</span><span lang="en">The remote Mac needs no additional app for basic screen access. Enable Screen Sharing in System Settings → General → Sharing. Enable Remote Login and allow your account for file browsing or an SSH tunnel. Optional high-performance mode also installs Itda on the remote Mac and needs Screen Recording and Accessibility permissions.</span></p></div></details>
      <details><summary><span lang="ko">집 밖에서는 어떻게 연결하나요?</span><span lang="en">How do I connect from outside?</span></summary><div><p><span lang="ko">모든 기기에 Tailscale을 설치하고 같은 계정으로 로그인하세요. Itda가 Tailscale 기기를 자동으로 보여 주고, 웹 뷰어의 Tailscale 주소·HTTPS 주소도 만들어 줍니다.</span><span lang="en">Install Tailscale on every device and sign in with the same account. Itda lists your Tailscale devices and shows the web viewer's Tailscale/HTTPS address.</span></p></div></details>
      </section></main>`;
    const text = homepageText(source)?.text;
    for (const condition of ["기본 화면 연결을 받는 Mac에는 별도 앱이 필요 없습니다.", "‘원격 로그인’도 켜고 계정 접근을 허용해야 합니다.", "화면 기록·손쉬운 사용 권한이 필요합니다.", "모든 기기에 Tailscale을 설치하고 같은 계정으로 로그인하세요.", "Enable Remote Login and allow your account", "Install Tailscale on every device and sign in with the same account."]) expect(text).toContain(condition);
  });
  it("keeps prose without main and handles quoted angle brackets and entities", () => {
    expect(homepageText('<article><p title="a > b">A &amp; B &#x2318; &#51088;&#47308; &lt;address&gt;</p><p>Next</p></article>')?.text).toBe("A & B ⌘ 자료 <address>\n\nNext");
  });
  it("supports role=main, ordinary void elements and common omitted paragraph/list endings", () => {
    expect(homepageText('<div role="main"><p>First<p>Second</p><ul><li>A<li>B</ul><img src="x"><br>Last</div>')?.text).toContain("First\nSecond");
  });
  it.each(['<main><p>Visible</main><section>Unclosed', '<main><div>Before</main>', '<main title="broken>Text</main>', '<!-- unclosed', '<main><script>no closing script', '<main><div hidden hidden>Text</div></main>', '<main><p>ok</p></unknown></main>'])("rejects ambiguous HTML instead of reporting complete evidence: %s", source => {
    expect(homepageText(source)).toBeUndefined();
  });
  it("marks text truncation explicitly and keeps no more than 16000 characters", () => {
    const result = homepageText(`<main><p>${"a".repeat(16_001)}</p></main>`);
    expect(result?.text).toHaveLength(16_000);
    expect(result?.truncated).toBe(true);
  });
});

describe("one-URL bounded homepage collection", () => {
  it("uses the guarded fetch and preserves URL, final URL, timestamp, language and source text", async () => {
    respond('<html lang="en"><body><main><p>Only on supported devices.</p></main></body></html>');
    const before = Date.now();
    const result = await collectHomepage(url);
    expect(result).toMatchObject({ url, finalUrl: "https://www.example.com/product", status: "ok", language: "en", text: "Only on supported devices.", truncated: false });
    expect(result.collectedAt).toBeGreaterThanOrEqual(before);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(url, expect.objectContaining({ signal: expect.any(AbortSignal), headers: expect.objectContaining({ Accept: "text/html, text/plain" }) }));
  });
  it("accepts text/plain without interpreting tags", async () => {
    respond("Use <user> only after approval.", { "content-type": "text/plain; charset=utf-8" });
    expect(await collectHomepage(url)).toMatchObject({ status: "ok", text: "Use <user> only after approval.", truncated: false });
  });
  it.each(["application/pdf", "application/json", "image/svg+xml", ""])("does not use unsupported content: %s", async type => {
    respond("not source", { "content-type": type });
    expect(await collectHomepage(url)).toMatchObject({ status: "unsupported", text: undefined });
  });
  it("rejects stream overflow even without Content-Length and cancels further reads", async () => {
    const cancelled = vi.fn();
    respond(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(256 * 1024)); c.enqueue(new Uint8Array(1)); }, cancel: cancelled }), { "content-type": "text/plain" });
    expect(await collectHomepage(url)).toMatchObject({ status: "too_large", truncated: true, text: undefined });
    expect(cancelled).toHaveBeenCalled();
  });
  it("rejects a declared oversized response without reading a partial source", async () => {
    respond("tiny", { "content-type": "text/plain", "content-length": String(256 * 1024 + 1) });
    expect(await collectHomepage(url)).toMatchObject({ status: "too_large", truncated: true, text: undefined });
  });
  it("allows exactly 256KB but marks extracted text truncation", async () => {
    respond("a".repeat(256 * 1024), { "content-type": "text/plain" });
    const result = await collectHomepage(url);
    expect(result.status).toBe("ok");
    expect(result.text).toHaveLength(16_000);
    expect(result.truncated).toBe(true);
  });
  it("applies the 6-second deadline to streaming after response headers arrive", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    respond(new ReadableStream({ cancel: cancelled }), { "content-type": "text/plain" });
    const promise = collectHomepage(url);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await promise).toMatchObject({ status: "failed", text: undefined });
    expect(cancelled).toHaveBeenCalled();
    expect((mockFetch.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
  });
  it("also times out before response headers", async () => {
    vi.useFakeTimers(); mockFetch.mockImplementation(() => new Promise(() => {}));
    const promise = collectHomepage(url);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await promise).toMatchObject({ status: "failed", text: undefined });
  });
  it("returns failure without text on network rejection, including guarded private URLs", async () => {
    mockFetch.mockRejectedValue(new Error("blocked address"));
    expect(await collectHomepage("https://127.0.0.1/")).toMatchObject({ status: "failed", text: undefined });
  });
  it.each(["file:///etc/passwd", "data:text/plain,source", "not a URL"])("does not request non-HTTP URLs: %s", async invalid => {
    expect(await collectHomepage(invalid)).toMatchObject({ status: "failed", text: undefined });
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it("distinguishes HTTP, empty and malformed-source failures without text", async () => {
    respond("error", { "content-type": "text/html" }, 500);
    expect(await collectHomepage(url)).toMatchObject({ status: "failed", text: undefined });
    respond('<main><script>ignore me</script></main>');
    expect(await collectHomepage(url)).toMatchObject({ status: "empty", text: undefined });
    respond('<main><div>cut content');
    expect(await collectHomepage(url)).toMatchObject({ status: "failed", text: undefined });
  });
});
