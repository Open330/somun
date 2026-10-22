import type { LlmProvider } from "../shared/types.js";

/** 프로바이더별 기본 모델. 서버(모델 선택)와 화면(설정 안내·대체 모델 표시)이 같이 쓴다. */
export const DEFAULT_MODEL: Record<Exclude<LlmProvider, "local-agent">, string> = {
  gemini: "gemini-3.5-flash-lite",
  openai: "gpt-5",
  anthropic: "claude-opus-5",
};
/** Gemini uses the same fixed model for analysis and writing. */
export const DEFAULT_DRAFT_MODEL: Partial<Record<LlmProvider, string>> = { gemini: DEFAULT_MODEL.gemini };
