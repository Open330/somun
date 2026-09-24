import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit, type Response as UndiciResponse } from "undici";

/**
 * 사용자가 준 주소로 서버가 요청할 때의 SSRF 방어. http(s)만, 연결하는 주소가 공인 주소여야 한다.
 * 막는 곳: 루프백, 사설망(10/8, 172.16/12, 192.168/16, fc00::/7), 링크로컬(169.254/16 — 클라우드 메타데이터, fe80::/10),
 * CGNAT(100.64/10), 0/8·멀티캐스트·예약·문서용 대역, 그리고 IPv4를 품은 IPv6 표기(매핑·호환·NAT64·6to4) 안의 같은 대역.
 *
 * 확인은 연결 순간에 한다: 전용 Agent의 DNS 조회가 막힌 주소를 돌려받으면 연결 자체를 거부한다(DNS 리바인딩 차단).
 * IP를 직접 쓴 주소는 조회를 거치지 않으므로 요청 전에 따로 확인한다.
 */
export class UnsafeUrlError extends Error {}

function v4Blocked(ip: string): boolean {
  const [a, b, c] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113) || a >= 224;
}

/** IPv6 문자열 → 16바이트. 끝에 점 표기 IPv4가 붙은 형태(::ffff:1.2.3.4)도 받는다. */
function v6Bytes(ip: string): number[] {
  let text = ip.toLowerCase().split("%")[0];
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail[1].split(".").map(Number);
    text = text.slice(0, -tail[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split("::");
  const left = head ? head.split(":") : [], right = rest !== undefined && rest ? rest.split(":") : [];
  const groups = rest === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return groups.flatMap((g) => { const n = parseInt(g || "0", 16); return [n >> 8, n & 255]; });
}

function v6Blocked(ip: string): boolean {
  const b = v6Bytes(ip);
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  const v4 = (at: number) => b.slice(at, at + 4).join(".");
  if (zero(0, 16) || (zero(0, 15) && b[15] === 1)) return true; // ::, ::1
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4Blocked(v4(12)); // ::ffff:a.b.c.d (매핑)
  if (zero(0, 12)) return v4Blocked(v4(12)); // ::a.b.c.d (호환)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return v4Blocked(v4(12)); // 64:ff9b::/96 (NAT64)
  if (b[0] === 0x20 && b[1] === 0x02) return v4Blocked(v4(2)); // 2002::/16 (6to4)
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 (문서용)
  return (b[0] & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) || b[0] === 0xff; // fc00::/7, fe80::/10, ff00::/8
}

export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  return kind === 4 ? v4Blocked(ip) : kind === 6 ? v6Blocked(ip) : true;
}

function checkUrl(raw: string | URL): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new UnsafeUrlError("invalid URL"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UnsafeUrlError("only http(s) URLs are allowed");
  if (url.username || url.password) throw new UnsafeUrlError("URLs with credentials are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isBlockedAddress(host)) throw new UnsafeUrlError("private or reserved addresses are not allowed");
  return url;
}

/** 저장할 때의 확인: 형식과, 지금 이름을 풀었을 때의 주소. 요청할 때는 publicFetch가 연결 순간에 다시 막는다. */
export async function assertPublicUrl(raw: string, resolve: (host: string) => Promise<{ address: string }[]> = (h) => lookup(h, { all: true })): Promise<URL> {
  const url = checkUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return url;
  const addresses = await resolve(host).catch(() => { throw new UnsafeUrlError("host does not resolve"); });
  if (!addresses.length || addresses.some((a) => isBlockedAddress(a.address))) throw new UnsafeUrlError("private or reserved addresses are not allowed");
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** 연결 직전의 DNS 조회에서 막힌 주소가 나오면 연결을 거부한다. */
export function guardedLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options }, (err, address, family) => {
    if (err) return callback(err, "");
    const list = Array.isArray(address) ? address.map((a) => a.address) : [address as string];
    if (!list.length || list.some(isBlockedAddress)) return callback(Object.assign(new UnsafeUrlError(`blocked address for ${hostname}`), { code: "EBLOCKED" }), "");
    callback(null, address as string | LookupAddress[], family);
  });
}

const publicAgent = new Agent({ connect: { lookup: guardedLookup as never } });

/** 공인 주소에만 요청한다. 리다이렉트는 최대 3번, 넘어갈 때마다 확인하고 301·302·303은 GET으로 바꾼다. */
export async function publicFetch(raw: string, init: UndiciRequestInit = {}, maxRedirects = 3): Promise<UndiciResponse> {
  let url = checkUrl(raw);
  let req: UndiciRequestInit = { ...init };
  for (let i = 0; ; i++) {
    const res = await undiciFetch(url, { ...req, redirect: "manual", dispatcher: publicAgent });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;
    await res.body?.cancel().catch(() => undefined);
    if (i >= maxRedirects) throw new UnsafeUrlError("too many redirects");
    url = checkUrl(new URL(location, url));
    if ([301, 302, 303].includes(res.status) && req.method && !["GET", "HEAD"].includes(req.method.toUpperCase())) req = { ...req, method: "GET", body: undefined };
  }
}

/** fetch가 막힌 주소 때문에 실패했는가(연결 단계 거부는 TypeError의 cause로 온다). */
export function isBlockedError(err: unknown): boolean {
  const e = err as { cause?: { code?: string }; code?: string } | undefined;
  return err instanceof UnsafeUrlError || e?.code === "EBLOCKED" || e?.cause?.code === "EBLOCKED" || e?.cause instanceof UnsafeUrlError;
}

/** 모델 호출용: 리다이렉트를 따라가지 않고, 연결 주소를 확인한다. */
export async function guardedFetch(raw: string, init: UndiciRequestInit = {}): Promise<UndiciResponse> {
  return undiciFetch(checkUrl(raw), { ...init, redirect: "error", dispatcher: publicAgent });
}
