import { assertPublicUrl, publicFetch } from "../infra/net.js";
import type { LlmConfig } from "../shared/types.js";
import { isTrusted, type AppContext } from "./context.js";

/**
 * 사용자가 준 주소로 서버가 요청할 때의 규칙. 운영자는 사설망(로컬 Ollama, 사내 피드)도 쓸 수 있고,
 * 다른 계정은 공인 주소만 쓸 수 있다(infra/net.ts: 연결 순간에 확인).
 */
export async function fetchForOwner(ctx: AppContext, ownerId: string, url: string, init: RequestInit = {}): Promise<Response> {
  return isTrusted(ctx, ownerId) ? fetch(url, init) : (publicFetch(url, init as never) as unknown as Promise<Response>);
}

/** 이 계정의 모델 호출이 사용자 baseUrl을 쓰는가(OpenAI 호환만 baseUrl을 쓴다). 그렇고 운영자가 아니면 연결 주소를 확인해야 한다. */
export const guardsModelEndpoint = (ctx: AppContext, ownerId: string, llm: Pick<LlmConfig, "provider" | "baseUrl">): boolean =>
  llm.provider === "openai" && Boolean(llm.baseUrl?.trim()) && !isTrusted(ctx, ownerId);

/** 설정을 저장할 때 baseUrl을 바로 확인해 알려준다. 호출할 때는 guardedFetch가 연결 순간에 다시 막는다. */
export async function assertModelEndpoint(ctx: AppContext, ownerId: string, llm: Pick<LlmConfig, "provider" | "baseUrl">): Promise<void> {
  if (guardsModelEndpoint(ctx, ownerId, llm)) await assertPublicUrl(llm.baseUrl!.trim());
}
