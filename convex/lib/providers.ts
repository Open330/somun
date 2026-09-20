/**
 * LLM 프로바이더 층. 판단·다이제스트·초안은 전부 "system + user → JSON(schema)" 한 가지 호출이다.
 *
 * - gemini: OpenAI 호환 엔드포인트. 서버 키 풀(GEMINI_API_KEYS, free-N 라운드로빈, paid-1 제외) 또는 BYOK.
 * - openai: BYOK. baseUrl을 주면 OpenAI 호환 서버(OpenRouter, Ollama 등)도 된다.
 * - anthropic: BYOK. Messages API 구조화 출력.
 * - local-agent: 여기서 호출하지 않는다. jobs 큐에 넣고 워커가 claude/codex CLI로 처리한다.
 */

declare const process: { env: Record<string, string | undefined> };

export type LlmProvider = "gemini" | "anthropic" | "openai" | "local-agent";

export type LlmConfig = { provider: LlmProvider; model?: string; draftModel?: string; apiKey?: string; baseUrl?: string; agentCli?: "claude" | "codex" };

export type LlmRequest = { system: string; user: string; schema: Record<string, unknown>; schemaName: string; maxTokens?: number };
export type LlmResult = { json: unknown; provider: LlmProvider; model: string; keyLabel?: string };

export const DEFAULT_MODEL: Record<Exclude<LlmProvider, "local-agent">, string> = {
  gemini: "gemini-3.5-flash-lite",
  openai: "gpt-5",
  anthropic: "claude-opus-5",
};
/**
 * 판단과 초안은 한 단계 위 모델. 다이제스트(추리기)는 기본 모델로 충분하다.
 * flash-lite로 판단하면 같은 후보가 실행마다 4점과 6점을 오갔다.
 */
export const DEFAULT_DRAFT_MODEL: Partial<Record<LlmProvider, string>> = { gemini: "gemini-3.7-flash" };

export function modelFor(config: LlmConfig, kind: "digest" | "judge" | "draft"): string {
  if (config.provider === "local-agent") return config.agentCli ?? "claude";
  if (kind !== "digest") return config.draftModel?.trim() || DEFAULT_DRAFT_MODEL[config.provider] || config.model?.trim() || DEFAULT_MODEL[config.provider];
  return config.model?.trim() || DEFAULT_MODEL[config.provider];
}

const GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
const OPENAI_BASE = "https://api.openai.com/v1";

export class LlmError extends Error {
  constructor(message: string, public readonly status?: number, public readonly retryable = false) {
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
    throw new LlmError(`${model} → ${res.status}: ${text.slice(0, 300)}`, res.status, res.status === 429 || res.status >= 500);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new LlmError("빈 응답");
  return { json: extractJson(content), provider: baseUrl === GEMINI_OPENAI_BASE ? "gemini" : "openai", model, keyLabel };
}

async function anthropicCall(apiKey: string, model: string, req: LlmRequest): Promise<LlmResult> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });
  const res = await client.messages.create({
    model,
    max_tokens: req.maxTokens ?? 4000,
    system: req.system,
    messages: [{ role: "user", content: req.user }],
    output_config: { format: { type: "json_schema", schema: req.schema } },
  } as never);
  if (res.stop_reason === "refusal") throw new LlmError("anthropic refusal");
  const text = res.content.find((b) => b.type === "text")?.text ?? "";
  return { json: extractJson(text), provider: "anthropic", model };
}

/**
 * 설정에 따라 호출. gemini 서버 키 풀은 429/5xx 때 다음 키로 넘어간다.
 * local-agent는 여기 오면 안 된다 (호출자가 큐로 보낸다).
 */
export async function runLlm(config: LlmConfig, req: LlmRequest, kind: "digest" | "judge" | "draft" = "judge"): Promise<LlmResult> {
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
  const pool = freeGeminiKeys(process.env.GEMINI_API_KEYS);
  if (pool.length === 0) throw new LlmError("GEMINI_API_KEYS가 서버에 없고 사용자 키도 없습니다");
  // 요청마다 시작 키를 돌려 한 키에 몰리지 않게 한다.
  const start = Math.floor(Math.random() * pool.length);
  let lastErr: unknown;
  // 503(모델 수요 폭주)은 키를 바꿔도 같으므로 두 바퀴째는 잠시 쉬고 다시 돈다.
  for (let round = 0; round < 3; round++) {
    if (round > 0) await new Promise((r) => setTimeout(r, 4000 * round));
    for (let i = 0; i < pool.length; i++) {
      const { label, key } = pool[(start + i) % pool.length];
      try {
        return await openaiCompatible(GEMINI_OPENAI_BASE, key, model, req, label);
      } catch (e) {
        lastErr = e;
        if (e instanceof LlmError && e.retryable) {
          if (e.status === 503) break; // 다음 바퀴로
          continue;
        }
        throw e;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new LlmError("모든 Gemini 키 실패");
}
