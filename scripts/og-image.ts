/**
 * 링크 미리보기 이미지(1200×630)를 랜딩 문구로 다시 만든다. 헤드라인을 바꾸면 함께 돌린다.
 *   npx tsx scripts/og-image.ts            # src/web/public/og.png, og-en.png
 *   CHROME_PATH=/path/to/chrome npx tsx scripts/og-image.ts
 * 글꼴은 Google Fonts(Noto Sans KR, Sora)에서 받으므로 네트워크가 필요하다.
 */
import { join } from "node:path";
import { chromium } from "playwright-core";

const OUT = join(import.meta.dirname, "../src/web/public");
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** docs/brand/mark.svg 와 같은 기하. */
const MARK = `<svg viewBox="0 0 1024 1024" width="72" height="72"><defs><clipPath id="box"><rect x="420" y="336" width="464" height="464" rx="72"/></clipPath></defs><rect x="420" y="336" width="464" height="464" rx="72" fill="#123F3A"/><g fill="#123F3A"><polygon points="474.0,160 610.3,160 240.8,800 104.5,800"/><polygon points="363.1,352.0 499.4,352.0 758.1,800 621.8,800"/></g><g clip-path="url(#box)"><g fill="#F3F4F2"><polygon points="474.0,160 610.3,160 240.8,800 104.5,800"/><polygon points="363.1,352.0 499.4,352.0 758.1,800 621.8,800"/></g></g></svg>`;

const VARIANTS = [
  { file: "og.png", lang: "ko", word: "소문", roman: true, lines: ["알릴 내용만,", "<em>읽기 쉽게</em>."], sub: "릴리스·PR·커밋에서 알릴 변화를 추려 채널별 초안을 만듭니다." },
  { file: "og-en.png", lang: "en", word: "somun", roman: false, lines: ["Say what matters.", "<em>Make it easy to read</em>."], sub: "Picks changes worth sharing from releases, PRs, and commits, then drafts for each channel." },
];

const page = (v: (typeof VARIANTS)[number]) => `<!doctype html><html lang="${v.lang}"><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;800&family=Sora:wght@400;600;700;800&display=block" rel="stylesheet">
<style>
  html, body { margin: 0; width: 1200px; height: 630px; background: #F3F4F2; color: #15191E; font-family: ${v.lang === "en" ? "Sora, " : ""}"Noto Sans KR", sans-serif; }
  .wrap { padding: 88px 88px 0; }
  .lockup { display: flex; align-items: center; gap: 22px; }
  .word { font-weight: 700; font-size: 40px; letter-spacing: -0.02em; font-family: ${v.lang === "en" ? "Sora" : "'Noto Sans KR'"}, sans-serif; }
  .roman { font-family: Sora, sans-serif; font-weight: 600; font-size: 15px; letter-spacing: 0.08em; color: #6B7178; margin-top: 10px; }
  .rule { width: 88px; height: 8px; border-radius: 4px; background: #123F3A; margin: 88px 0 28px; }
  h1 { margin: 0; font-weight: 800; font-size: ${v.lang === "en" ? 74 : 80}px; line-height: 1.18; letter-spacing: -0.02em; }
  h1 em { font-style: normal; color: #123F3A; }
  p { margin: 64px 0 0; font-size: 30px; color: #3A4047; }
</style></head><body><div class="wrap">
  <div class="lockup">${MARK}<span class="word">${v.word}</span>${v.roman ? '<span class="roman">somun</span>' : ""}</div>
  <div class="rule"></div>
  <h1>${v.lines.join("<br>")}</h1>
  <p>${v.sub}</p>
</div></body></html>`;

const browser = await chromium.launch({ executablePath: CHROME });
try {
  const tab = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  for (const v of VARIANTS) {
    await tab.setContent(page(v), { waitUntil: "networkidle" });
    await tab.evaluate("document.fonts.ready");
    await tab.screenshot({ path: join(OUT, v.file) });
    console.log(`wrote ${v.file}`);
  }
} finally {
  await browser.close();
}
