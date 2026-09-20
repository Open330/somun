/** 인증 구성. VITE_AUTH_URL이 없으면 인증이 비활성화되고 앱은 익명 로컬 모드로 동작한다. */
function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
export const AUTH_URL: string | null = import.meta.env.VITE_AUTH_URL ? normalizeUrl(import.meta.env.VITE_AUTH_URL) : null;
export const AUTH_AUDIENCE: string = import.meta.env.VITE_AUTH_AUDIENCE ?? "somun";
export const AUTH_PROVIDERS = ["github", "google", "kakao", "naver"] as const;
export type AuthProviderName = (typeof AUTH_PROVIDERS)[number];
export function isAuthEnabled(): boolean {
  return AUTH_URL !== null;
}
