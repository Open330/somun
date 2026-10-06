/** 구버전의 저장된 오류도 읽되, 화면에는 원시 API URL이나 예외를 노출하지 않는다. */
export function sourceError(error: string): { kind: "auth" | "access" | "permission" | "skipped" | "rate" | "invalid" | "unknown"; retryAt?: string; detail?: string } {
  const permission = /GitHub permission missing: (.+)$/.exec(error);
  if (permission) return { kind: "permission", detail: permission[1] };
  const skipped = /GitHub repositories skipped \(private\): (.+)$/.exec(error);
  if (skipped) return { kind: "skipped", detail: skipped[1] };
  if (/GitHub 토큰이 없습니다|No GitHub token|GitHub .*→ 401/.test(error)) return { kind: "auth" };
  if (/GitHub rate limit/.test(error)) return { kind: "rate", retryAt: /reset ([^)]+)/.exec(error)?.[1] };
  if (/GitHub repository unavailable/.test(error)) return { kind: "access" };
  if (/Invalid GitHub target/.test(error)) return { kind: "invalid" };
  return { kind: "unknown" };
}
