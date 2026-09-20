/** 키 풀 순수 규칙 (테스트 대상). */

/** AI_API.md: 프로젝트별 소프트 제한 450 RPD. */
export const RPD_SOFT_CAP = 450;

const PT_ZONE = "America/Los_Angeles";

/** RPD는 태평양 시간 자정에 초기화된다. */
export function ptDayKey(ts: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PT_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));
}

/** 다음 PT 자정 (ms). */
export function nextPtMidnight(ts: number): number {
  const today = ptDayKey(ts);
  let t = ts;
  while (ptDayKey(t) === today) t += 15 * 60 * 1000;
  // 15분 단위로 넘어간 뒤, 분 단위로 되돌려 정확히 맞춘다
  while (ptDayKey(t - 60 * 1000) !== today) t -= 60 * 1000;
  return t;
}

export type ErrorClass = { reason: string; cooldownUntil: number; quotaId?: string; retryDelay?: string };

/**
 * Gemini 오류 분류. OpenAI 호환 엔드포인트도 본문에 Google의 quotaId / retryDelay를 싣는다.
 * - 429 + PerDay → PT 자정까지
 * - 429 + PerMinute → retryDelay(초) 또는 60초
 * - 429 기타 → 60초
 * - 401/403 → 1시간 (키 무효·권한)
 * - 5xx → 30초 (키 문제가 아니라 모델 문제지만 잠깐 쉰다)
 */
export function classifyGeminiError(status: number | undefined, body: string | undefined, now: number): ErrorClass {
  const text = body ?? "";
  const quotaId = /"quotaId"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? /quotaId[=:]\s*([\w.]+)/.exec(text)?.[1];
  const retryDelay = /"retryDelay"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? /retry in ([\d.]+s)/i.exec(text)?.[1];
  const delayMs = retryDelay ? Math.max(5, parseFloat(retryDelay)) * 1000 : undefined;
  if (status === 429) {
    if (/PerDay/i.test(quotaId ?? "") || /per day|daily/i.test(text)) return { reason: "quota:day", cooldownUntil: nextPtMidnight(now), quotaId, retryDelay };
    if (/PerMinute/i.test(quotaId ?? "") || /per minute/i.test(text)) return { reason: "quota:minute", cooldownUntil: now + (delayMs ?? 60_000), quotaId, retryDelay };
    return { reason: "rate-limit", cooldownUntil: now + (delayMs ?? 60_000), quotaId, retryDelay };
  }
  if (status === 401 || status === 403) return { reason: "invalid-key", cooldownUntil: now + 60 * 60_000 };
  // 5xx는 모델·서비스 문제라 키를 바꿔도 같다. 키를 쉬게 하지 않는다 (쿨다운 0).
  if (status !== undefined && status >= 500) return { reason: `upstream-${status}`, cooldownUntil: now };
  return { reason: `error-${status ?? "unknown"}`, cooldownUntil: now + 30_000 };
}
