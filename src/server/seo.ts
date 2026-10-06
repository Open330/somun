import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import type { Config } from "./config.js";

/**
 * 검색엔진과 링크 미리보기가 읽는 부분. 공개 주소(SOMUN_PUBLIC_URL)가 있을 때만 첫 화면을 색인하게 둔다.
 * 공개 주소가 없는 셀프호스트는 사설 배포로 보고 전부 막는다.
 *
 * index.html의 <!--landing:start-->…<!--landing:end--> 사이는 JS 없이도 읽히는 첫 화면 문구다.
 * 첫 화면(/)에서만 남기고, 앱 화면에서는 지워 로그인한 사용자에게 번쩍이지 않게 한다.
 */
const LANDING = /<!--landing:start-->[\s\S]*?<!--landing:end-->/;

/** 웹 앱의 라우트(App.tsx). 이 밖의 주소는 앱 화면을 그대로 내려주되 404로 알린다(검색엔진·모니터링이 없는 페이지를 정상으로 보지 않게). */
const APP_ROUTES = [/^\/$/, /^\/c\/\d+$/, /^\/(?:published|connectors|voice|settings|welcome)$/, /^\/github\/(?:setup|pick)$/, /^\/setup\/github-app$/, /^\/auth\/callback$/];

/** 첫 화면 머리말의 영어판. 웹 앱처럼 Accept-Language에 한국어가 있으면 한국어, 없으면 영어. 헤더가 없으면(일부 크롤러) 기본 한국어. */
const EN_HEAD = {
  title: "somun — Say what matters. Make it easy to read.",
  description: "somun picks changes worth sharing from releases, PRs, and commits and drafts posts for each channel. It flags hype and numbers not found in the source, and learns your voice from posts you edit and copy.",
};
export function prefersEnglish(acceptLanguage: string | undefined): boolean {
  if (!acceptLanguage?.trim()) return false;
  return !acceptLanguage.split(",").some((l) => l.trim().toLowerCase().startsWith("ko"));
}
function toEnglish(html: string): string {
  return html
    .replace(/<html lang="ko">/, '<html lang="en">')
    .replace(/<title>[^<]*<\/title>/, `<title>${attr(EN_HEAD.title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${attr(EN_HEAD.description)}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${attr(EN_HEAD.title)}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${attr(EN_HEAD.description)}$2`)
    .replace(/(<meta property="og:site_name" content=")[^"]*(")/, "$1somun$2")
    .replace(/(<meta property="og:locale" content=")ko_KR(")/, '$1en_US$2\n    <meta property="og:locale:alternate" content="ko_KR" />');
}

const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function seoRoutes(app: Hono, config: Config) {
  const base = config.SOMUN_PUBLIC_URL?.replace(/\/+$/, "");
  // 매번 읽는다. 서버를 띄운 채 웹만 다시 빌드하면(LAN 테스트) 해시가 바뀐 자산을 가리켜야 한다.
  const indexHtml = (): string | undefined => { try { return readFileSync(join(config.WEB_DIST, "index.html"), "utf8"); } catch { return undefined; } };

  app.get("/robots.txt", (c) => c.text(base
    ? `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${base}/sitemap.xml\n`
    : "User-agent: *\nDisallow: /\n"));

  app.get("/sitemap.xml", (c) => {
    if (!base) return c.notFound();
    c.header("Content-Type", "application/xml; charset=utf-8");
    return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${base}/</loc></url>\n</urlset>\n`);
  });

  /** SPA의 index.html. 첫 화면에는 정규 주소·공유 이미지·소유 확인 태그를, 나머지에는 noindex를 붙인다. 앱에 없는 주소는 status 404. */
  return (path: string, acceptLanguage?: string): { body: string; status: 200 | 404 } | undefined => {
    const source = indexHtml();
    if (source === undefined) return undefined;
    const english = prefersEnglish(acceptLanguage);
    const html = english ? toEnglish(source) : source;
    const image = english ? "og-en.png" : "og.png";
    const status = APP_ROUTES.some((re) => re.test(path)) ? 200 : 404;
    const home = path === "/";
    const head: string[] = [];
    if (!home) head.push(`<meta name="robots" content="noindex" />`);
    if (base) {
      head.push(`<meta property="og:url" content="${attr(base + path)}" />`, `<meta property="og:image" content="${attr(base)}/${image}" />`, `<meta name="twitter:image" content="${attr(base)}/${image}" />`);
      if (home) head.push(`<link rel="canonical" href="${attr(base)}/" />`);
    }
    if (home && config.SOMUN_GOOGLE_SITE_VERIFICATION) head.push(`<meta name="google-site-verification" content="${attr(config.SOMUN_GOOGLE_SITE_VERIFICATION)}" />`);
    if (home && config.SOMUN_NAVER_SITE_VERIFICATION) head.push(`<meta name="naver-site-verification" content="${attr(config.SOMUN_NAVER_SITE_VERIFICATION)}" />`);
    const out = home ? html : html.replace(LANDING, "");
    return { status, body: head.length ? out.replace("</head>", `    ${head.join("\n    ")}\n  </head>`) : out };
  };
}
