/**
 * 프로젝트 홈페이지의 HTML·CSS에서 브랜드 색과 글꼴을 뽑는다(순수 함수).
 * 남의 페이지에서 온 값이라 모델에게는 색 코드(#rrggbb)와 글꼴 이름(영문·숫자·공백)만 넘긴다. 자유 문장은 넘기지 않는다.
 * 글꼴은 영상 렌더러가 불러올 수 있는 Google Fonts만 쓴다.
 */
export type Brand = {
  /** 채도가 있는 색, 많이 쓰인 순. 강조색 후보. */
  accents: string[];
  /** 가장 많이 쓰인 밝은 색(배경)과 어두운 색(글자). */
  background?: string;
  ink?: string;
  /** Google Fonts 글꼴 이름. 페이지가 불러오는 순서. */
  fonts: string[];
  source: string;
};

const HEX = /#([0-9a-f]{3}|[0-9a-f]{6})\b/gi;
const RGB = /rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+%?))?\s*\)/gi;
const FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ]{0,39}$/;

function normHex(h: string): string {
  const x = h.replace("#", "").toLowerCase();
  return `#${x.length === 3 ? [...x].map((c) => c + c).join("") : x}`;
}

function hsl(hex: string): { s: number; l: number } {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  const s = max === min ? 0 : l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
  return { s, l };
}

/** 색 사용 횟수. 투명도가 낮은 rgba는 뺀다(그림자·오버레이). */
export function countColors(css: string): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (hex: string) => counts.set(hex, (counts.get(hex) ?? 0) + 1);
  for (const m of css.matchAll(HEX)) add(normHex(m[0]));
  for (const m of css.matchAll(RGB)) {
    const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    if (alpha < 0.6) continue;
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    if ([r, g, b].some((v) => v > 255)) continue;
    add(`#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`);
  }
  return counts;
}

/** <link href="https://fonts.googleapis.com/css2?family=Sora:wght@600&family=Noto+Sans+KR"> 의 글꼴 이름. */
export function googleFonts(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/https?:\/\/fonts\.googleapis\.com\/css2?\?[^"'\s)>]+/gi)) {
    const url = m[0].replace(/&amp;/g, "&");
    for (const f of url.matchAll(/[?&]family=([^&:]+)/g)) {
      const name = decodeURIComponent(f[1].replace(/\+/g, " ")).split("|")[0].trim();
      if (FONT_NAME.test(name) && !out.includes(name)) out.push(name);
    }
  }
  return out.slice(0, 3);
}

/** 연결된 스타일시트 주소(같은 출처만, 앞의 몇 개). */
export function stylesheetLinks(html: string, base: string, limit = 3): string[] {
  const origin = new URL(base).origin;
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    try {
      const url = new URL(href.replace(/&amp;/g, "&"), base);
      if (url.origin === origin && !out.includes(url.href)) out.push(url.href);
    } catch { /* 잘못된 주소 */ }
  }
  return out.slice(0, limit);
}

export function extractBrand(html: string, css: string[], source: string): Brand | undefined {
  const inline = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
  const styleAttrs = [...html.matchAll(/style\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1]).join("\n");
  const theme = /<meta\b[^>]*name\s*=\s*["']theme-color["'][^>]*content\s*=\s*["'](#(?:[0-9a-f]{3}|[0-9a-f]{6}))["']/i.exec(html)?.[1];
  const counts = countColors([inline, styleAttrs, ...css].join("\n"));
  // theme-color는 사이트가 스스로 밝힌 대표색이라 가산점을 준다.
  if (theme) counts.set(normHex(theme), (counts.get(normHex(theme)) ?? 0) + 5);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([hex]) => hex);
  // 강조색: 채도가 있고 너무 어둡거나 밝지 않은 색. 짙은 브랜드색(#123f3a 같은)도 넣는다.
  const accents = ranked.filter((h) => { const { s, l } = hsl(h); return s >= 0.35 && l >= 0.12 && l <= 0.85; }).slice(0, 3);
  // 배경·글자: 채도가 낮은(무채색에 가까운) 밝은 색과 어두운 색.
  const background = ranked.find((h) => { const { s, l } = hsl(h); return l >= 0.9 && (s < 0.35 || l >= 0.97); });
  const ink = ranked.find((h) => { const { s, l } = hsl(h); return l <= 0.2 && s < 0.35; });
  // <link>로도, CSS의 @import로도 불러온다.
  const fonts = googleFonts([html, inline, ...css].join("\n"));
  if (!accents.length && !fonts.length) return undefined;
  return { accents, background, ink, fonts, source };
}
