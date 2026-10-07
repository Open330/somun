import type { FailedAttempt, GatewayOutcome, LlmGateway } from "../infra/llm/providers.js";
import { freeGeminiKeys } from "../infra/llm/providers.js";
import { UsageReporter } from "../infra/usage.js";
import type { AppContext } from "./context.js";
import { recordFailedAttempt } from "./llm-usage.js";

/**
 * jiun-api LLM 게이트웨이 경로의 앱 쪽 연결. 게이트웨이는 키 풀·대기·대체·사용량 기록을 직접 하므로,
 * somun은 모델 상태 표시에 쓸 최근 결과만 기억한다(프로세스 메모리. 재시작하면 비어 있다가 다음 호출로 다시 찬다).
 */
type State = { status?: number; code?: string; retryAt?: number; at: number };
const lastByModel = new WeakMap<AppContext["db"], Map<string, State>>();

/** 서버 키(공유) Gemini 경로를 쓸 수 있는가: 게이트웨이가 있거나 서버 무료 키가 있다. */
export const houseGeminiAvailable = (ctx: AppContext): boolean => Boolean(ctx.env.llmGateway) || freeGeminiKeys(ctx.env.geminiKeys).length > 0;

/** runLlm에 넘길 공통 옵션. 게이트웨이가 있으면 게이트웨이와 사용자 귀속을, 없으면 키별 실패 보고를 붙인다. */
export function llmCallOptions(ctx: AppContext, ownerId: string): { gateway?: LlmGateway; gatewayUser?: string; onGateway?: (o: GatewayOutcome) => void; onAttemptFailed?: (a: FailedAttempt) => void } {
  const gw = ctx.env.llmGateway;
  if (!gw) return { onAttemptFailed: (a) => recordFailedAttempt(ctx, ownerId, a) };
  return { gateway: gw, gatewayUser: UsageReporter.userIdOf(ownerId), onGateway: (o) => noteGateway(ctx, o) };
}

function noteGateway(ctx: AppContext, o: GatewayOutcome): void {
  const map = lastByModel.get(ctx.db) ?? new Map<string, State>();
  lastByModel.set(ctx.db, map);
  if (o.ok) map.delete(o.model);
  else map.set(o.model, { status: o.status, code: o.code, retryAt: o.retryAt, at: Date.now() });
}

/** 게이트웨이에 보낸 이름(별칭 포함)의 최근 실패. 10분 안의 것만. */
export function gatewayState(ctx: AppContext, model: string, now = Date.now()): State | undefined {
  const s = lastByModel.get(ctx.db)?.get(model);
  return s && now - s.at <= 10 * 60_000 ? s : undefined;
}

