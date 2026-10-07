/**
 * LLM 프로바이더 층. 판단·다이제스트·초안은 전부 "system + user → JSON(schema)" 한 가지 호출이다.
 *
 * - gemini: OpenAI 호환 엔드포인트. 서버 키 풀(GEMINI_API_KEYS, free-N 라운드로빈, paid-1 제외) 또는 BYOK.
 *   jiun-api LLM 게이트웨이(JIUN_LLM_GATEWAY_URL·KEY)가 설정되면 서버 키 호출은 게이트웨이로 간다. 키 풀·쿨다운·재시도·
 *   모델 대체·사용량 기록은 게이트웨이가 한다(somun은 다시 하지 않는다). BYOK는 게이트웨이를 거치지 않는다.
 * - openai: BYOK. baseUrl을 주면 OpenAI 호환 서버(OpenRouter, Ollama 등)도 된다.
 * - anthropic: BYOK. Messages API 구조화 출력.
 * - local-agent: 여기서 호출하지 않는다. jobs 큐에 넣고 워커가 claude/codex CLI로 처리한다.
 */



export type LlmProvider = "gemini" | "anthropic" | "openai" | "local-agent";

export type LlmConfig = { provider: LlmProvider; model?: string; draftModel?: string; apiKey?: string; baseUrl?: string; agentCli?: "claude" | "codex" };

export type LlmRequest = { system: string; user: string; schema: Record<string, unknown>; schemaName: string; maxTokens?: number };
export type LlmUsage = { inputTokens: number; outputTokens: number; cachedInputTokens: number; totalTokens: number };
export type LlmResult = { json: unknown; provider: LlmProvider; model: string; keyLabel?: string; usage?: LlmUsage; latencyMs: number; /** jiun-api 게이트웨이가 처리했다(사용량은 게이트웨이가 기록한다). */ viaGateway?: boolean };

/** jiun-api LLM 게이트웨이. OpenAI 호환 /chat/completions, Bearer 키 하나. */
export type LlmGateway = { url: string; key: string };
/** 게이트웨이 호출 결과(모델 상태 표시용). ok면 그 모델이 답했고, 아니면 HTTP 상태와 다시 시도할 수 있는 시각. */
export type GatewayOutcome = { model: string; ok: true; answeredBy: string } | { model: string; ok: false; status?: number; code?: string; retryAt?: number };

/** 서버 키 풀 상태 접근. 앱 층이 DB 기반으로 만들어 넘긴다. 없으면 무상태 순환. */
export type KeyPoolOps = {
  /** 모델별로 상태를 본다. Gemini 무료 쿼터는 프로젝트·모델 단위. */
  order: (labels: string[], model: string) => Promise<string[]>;
  report: (r: { label: string; model: string; ok: boolean; status?: number; body?: string }) => Promise<void>;
  /** 이 모델이 방금 서버 오류(5xx)로 응답하지 않았는가. 그렇다면 대체 모델로 바로 넘어가 기다리는 시간을 아낀다. */
  unavailable?: (model: string) => Promise<boolean>;
};

export { DEFAULT_DRAFT_MODEL, DEFAULT_MODEL } from "../../core/models.js";

import { guardedFetch } from "../net.js";
import { DEFAULT_DRAFT_MODEL, DEFAULT_MODEL } from "../../core/models.js";

export function modelFor(config: LlmConfig, kind: "digest" | "judge" | "draft"): string {
  if (config.provider === "local-agent") return config.agentCli ?? "claude";
  // 초안만 상위 모델. 판단은 기본 모델로 (무료 티어에서 3.7-flash의 일일 한도가 20 안팎이라 판단까지 쓰면 하루도 못 간다).
  if (kind === "draft") return config.draftModel?.trim() || DEFAULT_DRAFT_MODEL[config.provider] || config.model?.trim() || DEFAULT_MODEL[config.provider];
  return config.model?.trim() || DEFAULT_MODEL[config.provider];
}

const GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
const OPENAI_BASE = "https://api.openai.com/v1";

export class LlmError extends Error {
  /** 이 실패가 이미 시도별 사용량(onAttemptFailed)이나 게이트웨이가 보고했는가. 호출한 쪽이 같은 실패를 한 번 더 세지 않게. */
  reported = false;
  /** 게이트웨이 오류 코드(pool_exhausted, service_rate_limited, gateway_busy, upstream_unavailable…). */
  code?: string;
  /** Retry-After로 받은, 다시 시도해도 되는 시각. */
  retryAt?: number;
  constructor(message: string, public readonly status?: number, public readonly retryable = false, public readonly body?: string) {
    super(message);
  }
}

/** 실패한 모델 요청 한 번(키 순환·재시도 중의 시도 포함). 사용량 보고는 jikji처럼 시도마다 오류 이벤트를 남긴다. */
export type FailedAttempt = { model: string; keyLabel?: string; status?: number; startedAt: number; latencyMs: number };

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

async function openaiCompatible(baseUrl: string, apiKey: string, model: string, req: LlmRequest, keyLabel?: string, signal?: AbortSignal, guard = false): Promise<LlmResult> {
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
  // 사용자가 준 baseUrl(운영자 아닌 계정)은 연결 주소를 확인하고 리다이렉트를 따라가지 않는다(infra/net.ts).
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const doFetch = (guard ? guardedFetch : fetch) as unknown as typeof fetch;
  const res = await doFetch(url, {
    redirect: "error",
    method: "POST", signal,
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

async function anthropicCall(apiKey: string, model: string, req: LlmRequest, signal?: AbortSignal): Promise<LlmResult> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });
  const t0 = Date.now();
  const res = await client.messages.create({
    model,
    max_tokens: req.maxTokens ?? 4000,
    system: req.system,
    messages: [{ role: "user", content: req.user }],
    output_config: { format: { type: "json_schema", schema: req.schema } },
  } as never, { signal });
  if (res.stop_reason === "refusal") throw new LlmError("anthropic refusal");
  const text = res.content.find((b) => b.type === "text")?.text ?? "";
  const cached = (res.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
  return { json: extractJson(text), provider: "anthropic", model, usage: { inputTokens: res.usage.input_tokens + cached, outputTokens: res.usage.output_tokens, cachedInputTokens: cached, totalTokens: res.usage.input_tokens + cached + res.usage.output_tokens }, latencyMs: Date.now() - t0 };
}

/**
 * 설정에 따라 호출. gemini 서버 키 풀은 429/5xx 때 다음 키로 넘어간다.
 * local-agent는 여기 오면 안 된다 (호출자가 큐로 보낸다).
 */
export async function runLlm(config: LlmConfig, req: LlmRequest, kind: "digest" | "judge" | "draft" = "judge", pool?: KeyPoolOps, serverGeminiKeys?: string, signal: AbortSignal = AbortSignal.timeout(180_000), opts: { guardBaseUrl?: boolean; onAttemptFailed?: (attempt: FailedAttempt) => void; gateway?: LlmGateway; gatewayUser?: string; onGateway?: (outcome: GatewayOutcome) => void } = {}): Promise<LlmResult> {
  signal.throwIfAborted();
  const provider = config.provider;
  if (provider === "local-agent") throw new LlmError("local-agent는 워커가 처리합니다");
  const model = modelFor(config, kind);

  if (provider === "anthropic") {
    if (!config.apiKey) throw new LlmError("Anthropic API 키가 설정에 없습니다 (BYOK)");
    return await anthropicCall(config.apiKey, model, req, signal);
  }
  if (provider === "openai") {
    if (!config.apiKey) throw new LlmError("OpenAI API 키가 설정에 없습니다 (BYOK)");
    return await openaiCompatible(config.baseUrl?.trim() || OPENAI_BASE, config.apiKey, model, req, undefined, signal, Boolean(opts.guardBaseUrl && config.baseUrl?.trim()));
  }
  // gemini
  if (config.apiKey) return await openaiCompatible(GEMINI_OPENAI_BASE, config.apiKey, model, req, "byok", signal);
  if (opts.gateway) {
    // 게이트웨이는 gemini-* 모델만 다룬다. 설정의 모델 칸은 자유 입력이라, 다른 이름은 보내기 전에 막고 이유를 알린다.
    if (!/^gemini-/i.test(model)) throw new LlmError(`공유 모델은 Gemini(gemini-*)만 쓸 수 있습니다: ${model}. 설정에서 모델 이름을 비우거나 gemini- 모델을 고르세요. 다른 제공사는 개인 키로 연결할 수 있습니다.`, 400);
    // 게이트웨이 경로의 사용량은 게이트웨이가 기록한다. 응답 해석·네트워크 오류도 somun이 따로 세지 않게 reported로 표시한다.
    try { return await gatewayCall(opts.gateway, gatewayModel(model), req, signal, opts.gatewayUser, opts.onGateway); }
    catch (e) { if (e instanceof LlmError) e.reported = true; else if (e instanceof Error) throw Object.assign(new LlmError(e.message), { reported: true, name: e.name }); throw e; }
  }
  const all = freeGeminiKeys(serverGeminiKeys);
  if (all.length === 0) throw new LlmError("GEMINI_API_KEYS가 서버에 없고 사용자 키도 없습니다");
  const byLabel = new Map(all.map((k) => [k.label, k.key]));
  const base = config.model?.trim() || DEFAULT_MODEL.gemini;
  // 상위 모델이 몇 분 전에 503을 냈다면 또 50초를 기다리지 않고 기본 모델로 간다. 기다리다 작업 제한 시간을 넘기는 일이 잦았다.
  if (model !== base && (await pool?.unavailable?.(model))) return await runLlm({ ...config, draftModel: base }, req, kind, pool, serverGeminiKeys, signal, opts);
  let lastErr: unknown;
  // 바퀴마다 상태를 다시 읽는다: 쿨다운에 들어간 키는 빠지고, LRU 순서로 돈다.
  // 초안은 뒤에서 도는 작업이라 상위 모델의 일시적 수요 폭주(503)를 조금 더 기다린다(약 50초). 503은 곧바로 돌아오므로 제한 시간 안이다.
  const waits = kind === "draft" && model !== base ? DRAFT_503_WAITS_MS : DEFAULT_WAITS_MS;
  const started = Date.now();
  for (let round = 0; round < waits.length; round++) {
    // 상위 모델의 503은 응답까지 수십 초가 걸리기도 한다. 기다리는 데 예산을 다 쓰면 기본 모델로 넘어갈 시간도 없이 작업 제한 시간에 걸린다.
    if (round > 0 && model !== base && Date.now() - started + waits[round] > UPPER_MODEL_BUDGET_MS) break;
    if (waits[round] > 0) await new Promise((r) => setTimeout(r, waits[round]));
    signal.throwIfAborted();
    const labels = pool ? await pool.order(all.map((k) => k.label), model) : rotateStateless(all.map((k) => k.label));
    if (labels.length === 0) {
      // 요청을 보내지 않았으므로 사용량 보고 대상이 아니다. 호출한 쪽이 실패 이벤트를 하나 더 만들지 않게 표시한다.
      const none = new LlmError("쓸 수 있는 Gemini 무료 키가 없습니다 (전부 쿨다운 또는 일일 상한)", 429, true);
      none.reported = Boolean(opts.onAttemptFailed);
      lastErr = none;
      break;
    }
    for (const label of labels) {
      const key = byLabel.get(label)!;
      const attemptAt = Date.now();
      try {
        const res = await openaiCompatible(GEMINI_OPENAI_BASE, key, model, req, label, signal);
        await pool?.report({ label, model, ok: true });
        return res;
      } catch (e) {
        signal.throwIfAborted();
        lastErr = e;
        if (e instanceof LlmError) {
          await pool?.report({ label, model, ok: false, status: e.status, body: e.body });
          if (opts.onAttemptFailed) {
            opts.onAttemptFailed({ model, keyLabel: label, status: e.status, startedAt: attemptAt, latencyMs: Date.now() - attemptAt });
            e.reported = true;
          }
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
  if (lastErr instanceof LlmError && (lastErr.status === 503 || lastErr.status === 429) && model !== base) {
    return await runLlm({ ...config, draftModel: base }, req, kind, pool, serverGeminiKeys, signal, opts);
  }
  throw lastErr instanceof Error ? lastErr : new LlmError("모든 Gemini 키 실패");
}

/** 기본 모델은 게이트웨이 별칭으로 보낸다. 초안 모델은 quality(게이트웨이 정책이 fast로 대체), 기본 모델은 fast. 그 밖의 모델은 이름 그대로. */
export function gatewayModel(model: string): string {
  if (model === DEFAULT_DRAFT_MODEL.gemini) return "quality";
  if (model === DEFAULT_MODEL.gemini) return "fast";
  return model;
}

/**
 * 게이트웨이 한 번 호출. 다시 시도하지 않는다(게이트웨이가 키 순환·대기·대체를 한다. 위에서 또 하면 시도가 곱으로 는다).
 * 실패도 게이트웨이가 시도별로 기록하므로 reported로 표시한다. 답한 실제 모델은 X-Jiun-Model, 키 라벨은 X-Jiun-Key-Label.
 */
async function gatewayCall(gw: LlmGateway, model: string, req: LlmRequest, signal: AbortSignal, user: string | undefined, onGateway?: (o: GatewayOutcome) => void): Promise<LlmResult> {
  const t0 = Date.now();
  const res = await fetch(`${gw.url.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${gw.key}`, ...(user ? { "X-Jiun-User": user } : {}) },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }],
      response_format: { type: "json_schema", json_schema: { name: req.schemaName, schema: req.schema } },
      max_tokens: req.maxTokens ?? 4000,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    let code: string | undefined;
    try { code = (JSON.parse(text) as { error?: { code?: string } }).error?.code; } catch { /* 제공자 오류 본문 */ }
    // Retry-After는 초 또는 HTTP 날짜. 429인데 없으면 1분 뒤로 본다(곧바로 다시 보내 같은 실패를 거듭하지 않게).
    const header = res.headers.get("retry-after");
    const seconds = Number(header);
    const retryAt = header && Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : header && Number.isFinite(Date.parse(header)) ? Date.parse(header) : res.status === 429 ? Date.now() + 60_000 : undefined;
    const err = new LlmError(`gateway ${model} → ${res.status}${code ? ` ${code}` : ""}: ${text.slice(0, 300)}`, res.status, res.status === 429 || res.status >= 500, text.slice(0, 2000));
    err.code = code;
    err.retryAt = retryAt;
    err.reported = true;
    onGateway?.({ model, ok: false, status: res.status, code, retryAt });
    throw err;
  }
  const data = (await res.json()) as { model?: string; choices?: { message?: { content?: string | null } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw Object.assign(new LlmError("빈 응답"), { reported: true });
  const u = data.usage;
  const answeredBy = res.headers.get("x-jiun-model") || data.model || model;
  onGateway?.({ model, ok: true, answeredBy });
  return {
    json: extractJson(content), provider: "gemini", model: answeredBy, keyLabel: res.headers.get("x-jiun-key-label") || undefined, viaGateway: true, latencyMs: Date.now() - t0,
    usage: u ? { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0, cachedInputTokens: u.prompt_tokens_details?.cached_tokens ?? 0, totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0) } : undefined,
  };
}

/** 바퀴 사이 대기. 첫 바퀴는 바로. */
const DEFAULT_WAITS_MS = [0, 4000, 8000];
export const DRAFT_503_WAITS_MS = [0, 5000, 15000, 30000];
/** 상위 모델을 붙잡는 최대 시간. 넘기면 기본 모델로 넘어간다(작업 제한 시간 180초 안에 대체 모델이 끝날 여유를 남긴다). */
export const UPPER_MODEL_BUDGET_MS = 60_000;

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
