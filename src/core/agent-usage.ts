import type { LocalUsage } from "../shared/types.js";

/**
 * CLI 출력에서 읽은 호출별 사용량. 서버가 계정에 귀속해 jiun-api로 보고한다(provider는 과금 벤더).
 * Claude Code: modelUsage의 모델별 토큰(캐시 읽기·쓰기는 입력에 포함). Codex: turn.completed의 usage(입력에 캐시 포함).
 */
export function claudeUsage(outer: { modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>; duration_api_ms?: number }, startedAt: number): LocalUsage[] {
  const models = Object.entries(outer.modelUsage ?? {});
  return models.map(([model, u]) => ({
    provider: "anthropic" as const, model, startedAt, latencyMs: models.length === 1 ? outer.duration_api_ms ?? 0 : 0, status: "success" as const,
    inputTokens: (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0), outputTokens: u.outputTokens ?? 0, cachedInputTokens: u.cacheReadInputTokens ?? 0,
  }));
}
export function codexUsage(lines: Record<string, unknown>[], model: string, startedAt: number, latencyMs: number): LocalUsage[] {
  const turns = lines.filter((e) => e.type === "turn.completed").map((e) => (e.usage ?? {}) as { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number });
  if (!turns.length) return [];
  const sum = (k: "input_tokens" | "cached_input_tokens" | "output_tokens") => turns.reduce((a, u) => a + (u[k] ?? 0), 0);
  return [{ provider: "openai", model, startedAt, latencyMs, status: "success", inputTokens: sum("input_tokens"), outputTokens: sum("output_tokens"), cachedInputTokens: sum("cached_input_tokens") }];
}

/** 답을 쓴 모델. modelUsage에는 보조 모델(haiku 등)이 함께 들어 있을 수 있어, 출력 토큰이 가장 많은 모델을 고른다. */
export function mainModel(modelUsage: Record<string, { outputTokens?: number }> | undefined): string | undefined {
  return Object.entries(modelUsage ?? {}).sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0))[0]?.[0];
}

/** Codex config.toml의 최상위 model. [profiles.*] 같은 표 안의 model은 지금 쓰는 모델이 아닐 수 있어 보지 않는다. */
export function codexModelFrom(configToml: string): string {
  const top = configToml.split(/^\s*\[/m)[0];
  return /^\s*model\s*=\s*"([^"]+)"/m.exec(top)?.[1] ?? "codex";
}
