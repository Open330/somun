/**
 * LLM 프로바이더 층. 판단·다이제스트·초안은 전부 "system + user → JSON(schema)" 한 가지 호출이다.
 *
 * - gemini: OpenAI 호환 엔드포인트. 서버 키 풀(GEMINI_API_KEYS, free-N 라운드로빈, paid-1 제외) 또는 BYOK.
 * - openai: BYOK. baseUrl을 주면 OpenAI 호환 서버(OpenRouter, Ollama 등)도 된다.
 * - anthropic: BYOK. Messages API 구조화 출력.
 * - local-agent: 여기서 호출하지 않는다. jobs 큐에 넣고 워커가 claude/codex CLI로 처리한다.
 */



export type LlmProvider = "gemini" | "anthropic" | "openai" | "local-agent";

export type LlmConfig = { provider: LlmProvider; model?: string; draftModel?: string; apiKey?: string; baseUrl?: string; agentCli?: "claude" | "codex" };

export type LlmRequest = { system: string; user: string; schema: Record<string, unknown>; schemaName: string; maxTokens?: number };
export type LlmUsage = { inputTokens: number; outputTokens: number; cachedInputTokens: number; totalTokens: number };
export type LlmResult = { json: unknown; provider: LlmProvider; model: string; keyLabel?: string; usage?: LlmUsage; latencyMs: number };

/** 서버 키 풀 상태 접근. 앱 층이 DB 기반으로 만들어 넘긴다. 없으면 무상태 순환. */
export type KeyPoolOps = {
  /** 모델별로 상태를 본다. Gemini 무료 쿼터는 프로젝트·모델 단위. */
  order: (labels: string[], model: string) => Promise<string[]>;
  report: (r: { label: string; model: string; ok: boolean; status?: number; body?: string }) => Promise<void>;
};

export const DEFAULT_MODEL: Record<Exclude<LlmProvider, "local-agent">, string> = {
  gemini: "gemini-3.5-flash-lite",
  openai: "gpt-5",
  anthropic: "claude-opus-5",
};
/** 초안은 한 단계 위 모델. 다이제스트·판단은 기본 모델 (판단 편차는 가중치와 임계로 흡수). */
export const DEFAULT_DRAFT_MODEL: Partial<Record<LlmProvider, string>> = { gemini: "gemini-3.7-flash" };

export function modelFor(config: LlmConfig, kind: "digest" | "judge" | "draft"): string {
  if (config.provider === "local-agent") return config.agentCli ?? "claude";
  // 초안만 상위 모델. 판단은 기본 모델로 (무료 티어에서 3.7-flash의 일일 한도가 20 안팎이라 판단까지 쓰면 하루도 못 간다).
  if (kind === "draft") return config.draftModel?.trim() || DEFAULT_DRAFT_MODEL[config.provider] || config.model?.trim() || DEFAULT_MODEL[config.provider];
  return config.model?.trim() || DEFAULT_MODEL[config.provider];
}

const GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
const OPENAI_BASE = "https://api.openai.com/v1";

export class LlmError extends Error {
  constructor(message: string, public readonly status?: number, public readonly retryable = false, public readonly body?: string) {
    super(message);
  }
}

/** GEMINI_API_KEYS JSON 맵에서 무료 키만 순서대로. paid-1은 절대 순환에 넣지 않는다. */
export function freeGeminiKeys(raw: string | undefined): { label: string; key: string }[] {
  if (!raw) return [];
  try {
    const map = JSON.parse(raw) as Record<string, string>;
    return Object.entries(map)
      .filter(([label, key]) => label.startsWith("free-") && key)
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([label, key]) => ({ label, key }));
  } catch {
    return [];
  }
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new LlmError("응답에서 JSON을 찾지 못했습니다");
  }
}

async function openaiCompatible(baseUrl: string, apiKey: string, model: string, req: LlmRequest, keyLabel?: string): Promise<LlmResult> {
  const t0 = Date.now();
  const body = {
    model,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
    response_format: { type: "json_schema", json_schema: { name: req.schemaName, schema: req.schema } },
    max_tokens: req.maxTokens ?? 4000,
  };
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new LlmError(`${model} → ${res.status}: ${text.slice(0, 300)}`, res.status, res.status === 429 || res.status >= 500, text.slice(0, 2000));
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string | null } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new LlmError("빈 응답");
  const u = data.usage;
  const usage: LlmUsage | undefined = u ? { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0, cachedInputTokens: u.prompt_tokens_details?.cached_tokens ?? 0, totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0) } : undefined;
  return { json: extractJson(content), provider: baseUrl === GEMINI_OPENAI_BASE ? "gemini" : "openai", model, keyLabel, usage, latencyMs: Date.now() - t0 };
}

async function anthropicCall(apiKey: string, model: string, req: LlmRequest): Promise<LlmResult> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });
  const t0 = Date.now();
  const res = await client.messages.create({
    model,
    max_tokens: req.maxTokens ?? 4000,
    system: req.system,
    messages: [{ role: "user", content: req.user }],
    output_config: { format: { type: "json_schema", schema: req.schema } },
  } as never);
  if (res.stop_reason === "refusal") throw new LlmError("anthropic refusal");
  const text = res.content.find((b) => b.type === "text")?.text ?? "";
  const cached = (res.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
  return { json: extractJson(text), provider: "anthropic", model, usage: { inputTokens: res.usage.input_tokens + cached, outputTokens: res.usage.output_tokens, cachedInputTokens: cached, totalTokens: res.usage.input_tokens + cached + res.usage.output_tokens }, latencyMs: Date.now() - t0 };
}

/**
 * 설정에 따라 호출. gemini 서버 키 풀은 429/5xx 때 다음 키로 넘어간다.
 * local-agent는 여기 오면 안 된다 (호출자가 큐로 보낸다).
 */
export async function runLlm(config: LlmConfig, req: LlmRequest, kind: "digest" | "judge" | "draft" = "judge", pool?: KeyPoolOps, serverGeminiKeys?: string): Promise<LlmResult> {
  const provider = config.provider;
  if (provider === "local-agent") throw new LlmError("local-agent는 워커가 처리합니다");
  const model = modelFor(config, kind);

  if (provider === "anthropic") {
    if (!config.apiKey) throw new LlmError("Anthropic API 키가 설정에 없습니다 (BYOK)");
    return await anthropicCall(config.apiKey, model, req);
  }
  if (provider === "openai") {
    if (!config.apiKey) throw new LlmError("OpenAI API 키가 설정에 없습니다 (BYOK)");
    return await openaiCompatible(config.baseUrl?.trim() || OPENAI_BASE, config.apiKey, model, req);
  }
  // gemini
  if (config.apiKey) return await openaiCompatible(GEMINI_OPENAI_BASE, config.apiKey, model, req, "byok");
  const all = freeGeminiKeys(serverGeminiKeys);
  if (all.length === 0) throw new LlmError("GEMINI_API_KEYS가 서버에 없고 사용자 키도 없습니다");
  const byLabel = new Map(all.map((k) => [k.label, k.key]));
  let lastErr: unknown;
  // 바퀴마다 상태를 다시 읽는다: 쿨다운에 들어간 키는 빠지고, LRU 순서로 돈다.
  for (let round = 0; round < 3; round++) {
    if (round > 0) await new Promise((r) => setTimeout(r, 4000 * round));
    const labels = pool ? await pool.order(all.map((k) => k.label), model) : rotateStateless(all.map((k) => k.label));
    if (labels.length === 0) { lastErr = new LlmError("쓸 수 있는 Gemini 무료 키가 없습니다 (전부 쿨다운 또는 일일 상한)", 429, true); break; }
    for (const label of labels) {
      const key = byLabel.get(label)!;
      try {
        const res = await openaiCompatible(GEMINI_OPENAI_BASE, key, model, req, label);
        await pool?.report({ label, model, ok: true });
        return res;
      } catch (e) {
        lastErr = e;
        if (e instanceof LlmError) {
          await pool?.report({ label, model, ok: false, status: e.status, body: e.body });
          if (e.retryable) {
            if (e.status === 503) break; // 모델 수요 문제: 키를 바꿔도 같다. 쉬었다 다음 바퀴
            continue; // 429: 이 키는 쿨다운에 들어갔고 다음 키로
          }
        }
        throw e;
      }
    }
  }
  // 상위 모델이 수요 폭주(503)나 일일 상한(429)으로 막히면 기본 모델로 한 번 더. 초안 품질은 조금 떨어져도 아예 멈추는 것보다 낫다.
  // (3.7-flash 무료 한도는 키당 하루 20회 안팎이라 저녁이면 흔히 닿는다.)
  const base = config.model?.trim() || DEFAULT_MODEL.gemini;
  if (lastErr instanceof LlmError && (lastErr.status === 503 || lastErr.status === 429) && model !== base) {
    return await runLlm({ ...config, draftModel: base }, req, kind, pool, serverGeminiKeys);
  }
  throw lastErr instanceof Error ? lastErr : new LlmError("모든 Gemini 키 실패");
}

function rotateStateless(labels: string[]): string[] {
  const start = Math.floor(Math.random() * labels.length);
  return labels.map((_, i) => labels[(start + i) % labels.length]);
}

/** jiun-api 사용량 계약의 provider 어휘 (벤더). gemini는 google. */
export function usageProviderOf(p: LlmProvider, baseUrl?: string): "google" | "anthropic" | "openai" | "openrouter" | "local" {
  if (p === "gemini") return "google";
  if (p === "anthropic") return "anthropic";
  if (p === "local-agent") return "local";
  if (baseUrl?.includes("openrouter.ai")) return "openrouter";
  return "openai";
}
