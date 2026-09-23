import { usageProviderOf, type LlmResult } from "../infra/llm/providers.js";
import { UsageReporter } from "../infra/usage.js";
import type { LlmConfig } from "../shared/types.js";
import type { AppContext } from "./context.js";

/** 모델 호출 한 번의 사용량을 기록한다. 성공이면 응답의 모델·키·토큰을, 실패면 요청한 모델과 0 토큰을 남긴다. */
export function recordLlmUsage(ctx: AppContext, ownerId: string, config: Pick<LlmConfig, "provider" | "baseUrl">, startedAt: number, outcome: { res: LlmResult } | { failedModel: string }): void {
  const base = { userId: UsageReporter.userIdOf(ownerId), occurredAt: new Date(startedAt).toISOString(), latencyMs: Date.now() - startedAt };
  if ("failedModel" in outcome) {
    ctx.usage.record({ ...base, provider: usageProviderOf(config.provider, config.baseUrl), model: outcome.failedModel, status: "error", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 });
    return;
  }
  const { res } = outcome;
  ctx.usage.record({
    ...base, provider: usageProviderOf(res.provider, config.baseUrl), model: res.model, apiKeyLabel: res.keyLabel === "byok" ? "user" : res.keyLabel, status: "success",
    inputTokens: res.usage?.inputTokens ?? 0, outputTokens: res.usage?.outputTokens ?? 0, cachedInputTokens: res.usage?.cachedInputTokens ?? 0, totalTokens: res.usage?.totalTokens ?? 0,
  });
}
