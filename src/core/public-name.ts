/**
 * 프로필의 공개 이름 표기. 생성 모델은 CLI 이름(tend)을 공개 이름으로 고르는 일이 잦았다(2026-11-12 실측).
 * 대소문자만 다른 표기가 제품 자신의 제목에 있으면 그것을 쓴다: 홈페이지 사이트 이름 → README 첫 제목 → 로고 alt.
 * 철자가 다른 이름으로 바꾸지는 않는다. 근거가 없으면 받은 이름을 그대로 둔다.
 */
export function preferredPublicName(naming: string, sources: { siteName?: string; readme?: string }): string {
  const name = naming.trim();
  if (!name || /\s/.test(name)) return name;
  const target = name.toLowerCase();
  const word = new RegExp(`(?<![\\p{L}\\p{N}_-])(${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![\\p{L}\\p{N}_-])`, "iu");
  const readme = sources.readme ?? "";
  const titles = [
    sources.siteName,
    readme.match(/^#\s+(.+)$/m)?.[1],
    readme.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1],
    readme.match(/alt="([^"]+?)\s+(?:logo|icon|wordmark)"/i)?.[1],
  ];
  for (const title of titles) {
    const hit = title?.match(word)?.[1];
    if (hit && hit.toLowerCase() === target) return hit;
  }
  return name;
}
