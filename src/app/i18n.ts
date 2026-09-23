import type { Locale } from "../shared/types.js";
import type { AppContext } from "./context.js";
import { getSettings } from "./settings.js";

/**
 * 서버가 만드는 사용자용 문장의 언어. 계정의 화면 언어(settings.ui.locale)를 따른다. 정하지 않았으면 한국어.
 * 저장되는 문장(작업 오류, 판단 이유, 린트 설명)은 만들 때의 언어로 남는다.
 */
export function localeOf(ctx: AppContext, ownerId: string): Locale {
  return getSettings(ctx, ownerId).ui?.locale ?? "ko";
}

/** 두 언어 문장 중 계정 언어의 것. */
export function say(locale: Locale, ko: string, en: string): string {
  return locale === "en" ? en : ko;
}
