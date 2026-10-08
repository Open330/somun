import { LlmError, usageProviderOf, type FailedAttempt, type LlmResult } from "../infra/llm/providers.js";
import { UsageReporter } from "../infra/usage.js";
import type { LlmConfig, LocalUsage } from "../shared/types.js";
import type { AppContext } from "./context.js";

/**
 * 모델 호출의 사용량을 기록한다(계약: jiun-api/docs/USAGE_EVENTS.md).
 * - 성공: 응답의 모델·키 라벨·토큰과, 그 호출 자체의 지연 시간(자동 보정 같은 뒤 단계는 넣지 않는다).
 * - 실패: 요청한 모델과 0 토큰. 키 순환 중의 시도별 실패를 이미 보고했다면(err.reported) 다시 세지 않는다.
 * 키 라벨은 계약의 어휘(free-1~6, paid-1)만 쓰고, 개인 키(BYOK)처럼 해당이 없으면 생략한다.
 */
export function recordLlmUsage(ctx: AppContext, ownerId: string, config: Pick<LlmConfig, "provider" | "baseUrl">, startedAt: number, outcome: { res: LlmResult } | { failedModel: string; error?: unknown }): void {
  const base = { userId: UsageReporter.userIdOf(ownerId), occurredAt: new Date(startedAt).toISOString() };
  if ("failedModel" in outcome) {
    if (outcome.error instanceof LlmError && outcome.error.reported) return;
    ctx.usage.record({ ...base, latencyMs: Date.now() - startedAt, provider: usageProviderOf(config.provider, config.baseUrl), model: outcome.failedModel, status: "error", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 });
    return;
  }
  const { res } = outcome;
  // 게이트웨이가 처리한 호출은 게이트웨이가 시도마다 직접 기록한다. 여기서 또 보내면 두 번 센다.
  if (res.viaGateway) return;
  ctx.usage.record({
    ...base, latencyMs: res.latencyMs, provider: usageProviderOf(res.provider, config.baseUrl), model: res.model, apiKeyLabel: res.keyLabel === "byok" ? undefined : res.keyLabel, status: "success",
    inputTokens: res.usage?.inputTokens ?? 0, outputTokens: res.usage?.outputTokens ?? 0, cachedInputTokens: res.usage?.cachedInputTokens ?? 0, totalTokens: res.usage?.totalTokens ?? 0,
  });
}

/** 공유 Gemini 키를 돌며 실패한 시도 하나. jikji처럼 키 라벨과 함께 오류 이벤트로 남긴다(요청 수·키별 실패가 보이게). */
export function recordFailedAttempt(ctx: AppContext, ownerId: string, attempt: FailedAttempt): void {
  ctx.usage.record({ userId: UsageReporter.userIdOf(ownerId), occurredAt: new Date(attempt.startedAt).toISOString(), latencyMs: attempt.latencyMs, provider: "google", model: attempt.model, apiKeyLabel: attempt.keyLabel, status: "error", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 });
}

/**
 * 로컬 워커가 사용자의 Claude Code·Codex 구독으로 처리한 호출. provider는 과금한 벤더(anthropic·openai)이고,
 * 서버 키가 아니므로 키 라벨은 없다. 워커가 보낸 값이라 개수와 크기를 제한한다.
 */
export function recordLocalUsage(ctx: AppContext, ownerId: string, calls: LocalUsage[], now = Date.now()): void {
  const cap = (n: number) => Math.min(5_000_000, Math.max(0, Math.floor(Number(n) || 0)));
  // 워커 시계는 믿지 않는다. 지난 하루 ~ 지금 사이가 아니면 받은 시각으로 둔다(잘못된 값이 응답을 깨거나 집계 날짜를 흔들지 않게).
  const when = (t: number) => (Number.isFinite(t) && t >= now - 86_400_000 && t <= now + 60_000 ? t : now);
  for (const c of calls) {
    const input = cap(c.inputTokens), output = cap(c.outputTokens);
    ctx.usage.record({
      userId: UsageReporter.userIdOf(ownerId), occurredAt: new Date(when(c.startedAt)).toISOString(), latencyMs: cap(c.latencyMs), provider: c.provider, model: c.model, status: c.status,
      inputTokens: input, outputTokens: output, cachedInputTokens: Math.min(input, cap(c.cachedInputTokens)), totalTokens: input + output,
    });
  }
}
