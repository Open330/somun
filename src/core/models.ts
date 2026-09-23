import type { LlmProvider } from "../shared/types.js";

/** 프로바이더별 기본 모델. 서버(모델 선택)와 화면(설정 안내·대체 모델 표시)이 같이 쓴다. */
export const DEFAULT_MODEL: Record<Exclude<LlmProvider, "local-agent">, string> = {
  gemini: "gemini-3.5-flash-lite",
  openai: "gpt-5",
  anthropic: "claude-opus-5",
};
/** 초안은 한 단계 위 모델. 다이제스트·판단은 기본 모델 (판단 편차는 가중치와 임계로 흡수). */
export const DEFAULT_DRAFT_MODEL: Partial<Record<LlmProvider, string>> = { gemini: "gemini-3.7-flash" };
