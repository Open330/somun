import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * 사용자가 준 주소로 서버가 요청할 때의 SSRF 방어. http(s)만, 이름을 풀어 나온 모든 주소가 공인 주소여야 한다.
 * 막는 곳: 루프백, 사설망(10/8, 172.16/12, 192.168/16, fc00::/7), 링크로컬(169.254/16 — 클라우드 메타데이터, fe80::/10),
 * CGNAT(100.64/10), 0/8·멀티캐스트·예약 대역, IPv4 매핑 IPv6.
 * 확인과 실제 연결 사이에 DNS가 바뀌는 공격(rebinding)까지 막지는 않는다. 그래서 리다이렉트는 따라가기 전에 매번 다시 확인한다.
 */
export class UnsafeUrlError extends Error {}

function v4Blocked(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function v6Blocked(ip: string): boolean {
  const x = ip.toLowerCase();
  if (x === "::" || x === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (mapped) return v4Blocked(mapped[1]);
  return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x);
}

export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  return kind === 4 ? v4Blocked(ip) : kind === 6 ? v6Blocked(ip) : true;
}

/** 공인 http(s) 주소인지 확인하고 URL을 돌려준다. 아니면 UnsafeUrlError. */
export async function assertPublicUrl(raw: string, resolve: (host: string) => Promise<{ address: string }[]> = (h) => lookup(h, { all: true })): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new UnsafeUrlError("invalid URL"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UnsafeUrlError("only http(s) URLs are allowed");
  if (url.username || url.password) throw new UnsafeUrlError("URLs with credentials are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await resolve(host).catch(() => { throw new UnsafeUrlError("host does not resolve"); });
  if (!addresses.length || addresses.some((a) => isBlockedAddress(a.address))) throw new UnsafeUrlError("private or reserved addresses are not allowed");
  return url;
}

/** 공인 주소에만 요청한다. 리다이렉트는 최대 3번, 따라가기 전에 다시 확인한다. */
export async function publicFetch(raw: string, init: RequestInit = {}, maxRedirects = 3): Promise<Response> {
  let url = await assertPublicUrl(raw);
  for (let i = 0; ; i++) {
    const res = await fetch(url, { ...init, redirect: "manual" });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;
    if (i >= maxRedirects) throw new UnsafeUrlError("too many redirects");
    url = await assertPublicUrl(new URL(location, url).toString());
  }
}
