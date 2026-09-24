import { assertPublicUrl, publicFetch } from "../infra/net.js";
import type { LlmConfig } from "../shared/types.js";
import { isTrusted, type AppContext } from "./context.js";

/**
 * 사용자가 준 주소로 서버가 요청할 때의 규칙. 운영자는 사설망(로컬 Ollama, 사내 피드)도 쓸 수 있고,
 * 다른 계정은 공인 주소만 쓸 수 있다(infra/net.ts).
 */
export function fetchForOwner(ctx: AppContext, ownerId: string, url: string, init: RequestInit = {}): Promise<Response> {
  return isTrusted(ctx, ownerId) ? fetch(url, init) : publicFetch(url, init);
}

/** 확인할 게 있는가. 없으면 호출 쪽이 기다리지 않는다(기본 엔드포인트·운영자). */
export const needsEndpointCheck = (ctx: AppContext, ownerId: string, llm: Pick<LlmConfig, "baseUrl">): boolean => Boolean(llm.baseUrl) && !isTrusted(ctx, ownerId);

/** 모델 baseUrl 확인. 설정을 저장할 때와 호출하기 직전(그 사이 DNS가 바뀔 수 있으므로) 모두 부른다. */
export async function assertModelEndpoint(ctx: AppContext, ownerId: string, llm: Pick<LlmConfig, "baseUrl">): Promise<void> {
  if (needsEndpointCheck(ctx, ownerId, llm)) await assertPublicUrl(llm.baseUrl!);
}
