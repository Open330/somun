import type { Channel } from "./channels.js";

/** 알 수 없는 호스트(블로그·단축 URL)는 허용하되, 명백히 다른 채널이면 알려준다. */
export function publicationChannel(url: string): Channel | undefined {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return undefined; }
  if (["x.com", "twitter.com", "mobile.twitter.com", "mobile.x.com"].includes(host)) return "x";
  if (["threads.net", "threads.com"].includes(host)) return "threads";
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return "linkedin";
  if (host === "news.ycombinator.com") return "show_hn";
  if (host === "news.hada.io") return "show_gn";
  return undefined;
}
