import type { Channel } from "./channels.js";

/**
 * 복사할 때 링크에 채널 표시를 붙인다(순수 함수). 저장된 초안은 그대로 두고 클립보드로 가는 글만 바꾼다.
 * - 저장소 홈페이지와 같은 호스트의 링크: utm_source=<채널>&utm_medium=social&utm_campaign=somun
 * - App Store 캠페인 링크(pt가 이미 있는 것): ct=somun-<채널>. pt 없는 ct는 App Analytics에 잡히지 않으므로 건드리지 않는다.
 * GitHub 링크는 GitHub가 유입 경로를 도메인 단위로 따로 보여 주므로 바꾸지 않는다.
 * Show HN·Show GN은 커뮤니티가 추적 파라미터를 꺼려 붙이지 않는다. 블로그 개요는 링크가 없다.
 */
export const TRACKED_CHANNELS: readonly Channel[] = ["x", "threads", "linkedin"];

const URL_RE = /https?:\/\/[^\s<>()"'`]+/g;
/** 문장 끝 구두점은 링크가 아니다. */
const TRAILING = /[.,;:!?]+$/;

const host = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  try { return new URL(raw).hostname.replace(/^www\./, "").toLowerCase(); } catch { return undefined; }
};

export function trackLinks(text: string, opts: { channel: Channel; homepage?: string }): string {
  if (!TRACKED_CHANNELS.includes(opts.channel)) return text;
  const home = host(opts.homepage);
  return text.replace(URL_RE, (match) => {
    const tail = match.match(TRAILING)?.[0] ?? "";
    const raw = tail ? match.slice(0, -tail.length) : match;
    let url: URL;
    try { url = new URL(raw); } catch { return match; }
    const h = url.hostname.replace(/^www\./, "").toLowerCase();
    if (h === "apps.apple.com" && url.searchParams.has("pt")) {
      if (url.searchParams.has("ct")) return match;
      url.searchParams.set("ct", `somun-${opts.channel}`);
      return url.toString() + tail;
    }
    if (!home || h !== home || url.searchParams.has("utm_source")) return match;
    url.searchParams.set("utm_source", opts.channel);
    url.searchParams.set("utm_medium", "social");
    url.searchParams.set("utm_campaign", "somun");
    return url.toString() + tail;
  });
}
