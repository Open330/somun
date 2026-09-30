/** GitHub 직접 지정은 소유자, 소유자/저장소, 저장소의 웹 URL을 받는다. */
export function normalizeGithubTarget(input: string): string | null {
  let target = input.trim();
  if (/^https?:\/\//i.test(target)) {
    try {
      const url = new URL(target);
      if (url.hostname.toLowerCase() !== "github.com" || url.port || url.username || url.password || url.search || url.hash) return null;
      target = url.pathname.replace(/^\/+|\/+$/g, "");
    } catch { return null; }
  }
  target = target.replace(/\/$/, "").replace(/\.git$/, "");
  return /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?(?:\/[a-z\d_.-]{1,100})?$/i.test(target) && !/\/(?:\.|\.\.)$/.test(target) ? target : null;
}
