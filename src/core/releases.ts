/**
 * 릴리스 사이의 우선순위. 글감 제목, 근거의 최신판, "아직 릴리스되지 않음" 기준이 모두 이 규칙 하나를 쓴다.
 */

export type ReleaseTag = { line: string; version: number[]; pre?: string };

/**
 * 태그를 줄기(패키지 접두사)·버전·프리릴리스로 나눈다. "v8.3.3" → v / [8,3,3], "pkg2@0.1.0" → pkg2@ / [0,1,0],
 * "v2.0.0-rc.1" → v / [2,0,0] / rc.1. 버전 모양이 아니면 태그 전체를 줄기로 본다(시각으로만 비교된다).
 */
export function parseTag(tag: string): ReleaseTag {
  const m = /^(.*?)(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/.exec(tag.trim());
  if (!m) return { line: tag, version: [] };
  return { line: m[1], version: m[2].split(".").map(Number), pre: m[3] };
}

/** 같은 줄기 두 태그의 순서. 버전 숫자 → 같으면 정식판이 프리릴리스보다 높다 → 프리릴리스끼리는 문자열(숫자 인식). */
export function compareVersions(a: ReleaseTag, b: ReleaseTag): number {
  for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
    const d = (a.version[i] ?? 0) - (b.version[i] ?? 0);
    if (d) return d;
  }
  if (!a.pre !== !b.pre) return a.pre ? -1 : 1;
  return (a.pre ?? "").localeCompare(b.pre ?? "", undefined, { numeric: true });
}

/**
 * 새 릴리스(tag, at)가 지금의 대표 릴리스(currentTag, currentAt)를 대신하는가.
 * - 정식판과 프리릴리스 사이에서는 정식판이 대표다(정식판이 있으면 프리릴리스를 고르지 않는다).
 * - 같은 줄기면 버전이 높은 쪽(늦게 나온 옛 줄기 백포트 v6.4.4는 v8.3.3을 대신하지 않는다. v2.0.0은 v2.0.0-rc.1을 대신한다).
 * - 다른 패키지(pkg-a@, create-vite@)는 버전을 비교할 수 없으므로 더 최근에 게시한 쪽.
 */
export function outranks(tag: string, at: number, currentTag: string, currentAt: number): boolean {
  const a = parseTag(tag), b = parseTag(currentTag);
  if (!a.pre !== !b.pre) return !a.pre;
  if (a.line === b.line && a.version.length && b.version.length) return compareVersions(a, b) > 0;
  return at > currentAt;
}

/** 여러 릴리스 중 대표 릴리스. 정식판이 있으면 프리릴리스는 고르지 않는다. */
export function representative<T>(items: T[], tagOf: (x: T) => string, atOf: (x: T) => number): T | undefined {
  return items.reduce<T | undefined>((best, x) => (!best || outranks(tagOf(x), atOf(x), tagOf(best), atOf(best)) ? x : best), undefined);
}
