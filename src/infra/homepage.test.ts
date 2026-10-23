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

describe("literal homepage copy units", () => {
  const extract = (body: string) => homepageText(`<html lang="ko"><head><meta property="og:site_name" content="Example &amp; Co"></head><body><main>${body}</main></body></html>`);
  it("preserves whole inline conditions and optional lists separately, with section-scoped parents", () => {
    const result = extract(`<section><div><h2>전체<br>작업</h2><p>화면과 파일을 함께 다룹니다.</p></div><article><h3>파일 작업</h3><p>승인된 <strong>Pro 계정만</strong> 폴더를 열 수 있습니다.</p><ul><li>선택 기능은 별도 설치가 필요합니다.</li></ul></article></section><section><article><h3>다른 섹션</h3><p>다른 기능입니다.</p></article></section>`);
    expect(result?.siteName).toBe("Example & Co");
    expect(result?.copyUnits).toEqual([
      { id: "unit-001", language: "ko", heading: "전체\n작업", paragraph: "화면과 파일을 함께 다룹니다." },
      { id: "unit-002", language: "ko", heading: "파일 작업", paragraph: "승인된 Pro 계정만 폴더를 열 수 있습니다.", parentId: "unit-001" },
      { id: "unit-003", language: "ko", heading: "다른 섹션", paragraph: "다른 기능입니다." },
    ]);
    expect(result?.text).toContain("선택 기능은 별도 설치가 필요합니다.");
  });
  it("retains explicit parallel translations as separate units without changing all-language evidence", () => {
    const result = extract('<section><div><h2><span lang="ko">파일</span><span lang="en">Files</span></h2><p><span lang="ko">승인 계정만 사용합니다.</span><span lang="en">Authorized accounts only.</span></p></div></section>');
    expect(result?.copyUnits?.map(unit => [unit.language, unit.heading, unit.paragraph])).toEqual([["ko", "파일", "승인 계정만 사용합니다."], ["en", "Files", "Authorized accounts only."]]);
    expect(result?.text).toContain("Authorized accounts only.");
    expect(result?.text).toContain("승인 계정만 사용합니다.");
  });
  it("does not drop a different-language inline condition or unknown-language prose", () => {
    expect(extract('<section><h2>파일</h2><p>파일은 <em lang="en">Pro only</em> 사용할 수 있습니다.</p></section>')?.copyUnits).toBeUndefined();
    expect(homepageText('<main><section><h2>Files</h2><p>Accounts only.</p></section></main>')?.copyUnits).toBeUndefined();
    expect(extract('<section><h2>파일</h2><p lang="">조건 불명</p></section>')?.copyUnits).toBeUndefined();
  });
  it("does not collect hidden branches, even when a descendant has an explicit language", () => {
    const result = extract('<section hidden><h2 lang="ko">숨김 제목</h2><p lang="ko">숨김 조건</p></section><section><h2>표시</h2><p>공개 조건<span aria-hidden="true" lang="en">Hidden</span></p></section>');
    expect(result?.copyUnits?.map(unit => unit.heading)).toEqual(["표시"]);
    expect(result?.copyUnits?.[0].paragraph).toBe("공개 조건");
  });
  it("requires an explicitly closed whole paragraph, not optional HTML repair", () => {
    const result = extract('<section><h2>파일</h2><p>닫히지 않은 조건</section>');
    expect(result?.text).toContain("닫히지 않은 조건");
    expect(result?.copyUnits).toBeUndefined();
  });
  it("does not guess which of multiple paragraphs is the full description", () => {
    expect(extract('<section><h2>파일</h2><p>파일을 여세요.</p><p>Pro 요금제만 가능합니다.</p></section>')?.copyUnits).toBeUndefined();
  });
  it("does not assign a parent when the intervening parent heading has no complete description", () => {
    const units = extract('<section><div><h2>개요</h2><p>제품 설명</p></div><h3>빈 중간 제목</h3><div><h4>상세</h4><p>상세 작업</p></div></section>')?.copyUnits;
    expect(units?.at(-1)).not.toHaveProperty("parentId");
  });
  it("ignores metadata conflicts for evidence but disables copy eligibility", () => {
    const result = homepageText('<html lang="ko"><head><meta property="og:site_name" content="One"><meta property="og:site_name" content="Two"></head><body><section><h2>설명</h2><p>본문 조건</p></section></body></html>');
    expect(result?.text).toContain("본문 조건");
    expect(result?.copyUnits).toBeUndefined();
    expect(result?.siteName).toBeUndefined();
  });
  it("accepts repeated identical site names, not metadata as source prose", () => {
    const result = homepageText('<html lang="ko"><head><meta property="og:site_name" content="One"><meta property="og:site_name" content="One"></head><body><section><h2>설명</h2><p>본문</p></section></body></html>');
    expect(result?.siteName).toBe("One");
    expect(result?.copyUnits).toHaveLength(1);
    expect(result?.text).not.toContain("One");
  });
  it("omits long units whole and disables all copy units when source text is truncated", () => {
    expect(extract(`<section><h2>기능</h2><p>${"가".repeat(1_201)}</p></section>`)?.copyUnits).toBeUndefined();
    expect(extract(`<section><h2>${"가".repeat(241)}</h2><p>조건</p></section>`)?.copyUnits).toBeUndefined();
    const result = extract(`<section><h2>기능</h2><p>조건</p></section><div>${"가".repeat(16_001)}</div>`);
    expect(result?.truncated).toBe(true);
    expect(result?.copyUnits).toBeUndefined();
  });
  it("caps whole units at 48 without dangling parent IDs", () => {
    const result = extract(`<section>${Array.from({ length: 60 }, (_, i) => `<div><h${i ? "3" : "2"}>기능 ${i}</h${i ? "3" : "2"}><p>조건 ${i}</p></div>`).join("")}</section>`);
    expect(result?.copyUnits).toHaveLength(48);
    const ids = new Set(result?.copyUnits?.map(unit => unit.id));
    expect(result?.copyUnits?.every(unit => !unit.parentId || ids.has(unit.parentId))).toBe(true);
  });
  it("preserves actual Itda overview/file units and their inline source conditions", () => {
    // Verbatim complete heading/paragraph branches from the official homepage (2026-10-23).
    const result = extract(`<section id="features"><div><h2><span lang="ko">화면을 열고,<br>파일을 이어서.</span><span lang="en">Your screens.<br>Your files. Together.</span></h2><p><span lang="ko">기기와 계정을 한곳에서 관리하고, 화면 연결과 파일 탐색을 각각의 창에서 사용하세요.</span><span lang="en">Keep devices and accounts in one place, with separate windows for remote screens and files.</span></p></div><article><h3><span lang="ko">별도 창에서 파일 탐색</span><span lang="en">A window for your files</span></h3><p><span lang="ko">화면 공유 없이 SSH/SFTP로 폴더를 열고 복사·이동하세요. 탭과 미리보기, Mac의 열·갤러리 보기도 지원합니다.</span><span lang="en">Browse and transfer over SSH/SFTP without opening a remote screen. Use tabs and previews, plus column and gallery views on Mac.</span></p></article></section>`);
    const ko = result?.copyUnits?.filter(unit => unit.language === "ko");
    expect(ko).toHaveLength(2);
    expect(ko?.[1].parentId).toBe(ko?.[0].id);
    expect(ko?.[1].paragraph).toBe("화면 공유 없이 SSH/SFTP로 폴더를 열고 복사·이동하세요. 탭과 미리보기, Mac의 열·갤러리 보기도 지원합니다.");
    expect(result?.text).toContain("Browse and transfer over SSH/SFTP without opening a remote screen.");
  });
  it("does not interpret malformed block content inside a paragraph as a complete copy unit", () => {
    const result = extract('<section><h2>제목</h2><p>앞<div>조건</div>뒤</p></section>');
    expect(result?.text).toContain("조건");
    expect(result?.copyUnits).toBeUndefined();
  });
  it("keeps ordinary evidence when a deeply nested page exceeds copy parsing bounds", () => {
    const result = extract(`<section><h2>제목</h2><p>조건</p>${"<div>".repeat(130)}본문${"</div>".repeat(130)}</section>`);
    expect(result?.text).toContain("본문");
    expect(result?.truncated).toBe(false);
    expect(result?.copyUnits).toBeUndefined();
  });
  it("excludes headings inside details rather than dropping a limiting summary", () => {
    const result = extract('<details><summary>유료 계정 전용</summary><div><h3>파일 작업</h3><p>폴더를 열고 복사합니다.</p></div></details>');
    expect(result?.copyUnits).toBeUndefined();
    expect(result?.text).toContain("유료 계정 전용");
    expect(result?.text).toContain("폴더를 열고 복사합니다.");
  });
  it("disables copy eligibility when siteName exceeds its metadata bound", () => {
    const result = homepageText(`<html lang="ko"><head><meta property="og:site_name" content="${"N".repeat(241)}"></head><body><section><h2>설명</h2><p>본문 조건</p></section></body></html>`);
    expect(result?.siteName).toBeUndefined();
    expect(result?.copyUnits).toBeUndefined();
    expect(result?.text).toContain("본문 조건");
  });
  it("collects optional copy metadata through the existing network path", async () => {
    respond('<html lang="ko"><head><meta property="og:site_name" content="Example"></head><body><section><h2>파일</h2><p>승인 계정만 사용합니다.</p></section></body></html>');
    expect(await collectHomepage(url)).toMatchObject({ status: "ok", siteName: "Example", copyUnits: [{ language: "ko", heading: "파일", paragraph: "승인 계정만 사용합니다." }] });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
