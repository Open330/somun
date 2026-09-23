import type { Locale } from "../shared/locale.js";
import type { AppContext } from "./context.js";
import { getSettings } from "./settings.js";

export { say } from "../shared/locale.js";

/**
 * 서버가 만드는 사용자용 문장의 언어. 계정의 화면 언어(settings.ui.locale)를 따른다. 정하지 않았으면 한국어.
 * 저장되는 문장(작업 오류, 판단 이유, 린트 설명)은 만들 때의 언어로 남는다.
 * 설정을 이미 읽었으면 settings.ui?.locale을 바로 쓴다(한 번 더 읽지 않게).
 */
export function localeOf(ctx: AppContext, ownerId: string): Locale {
  return getSettings(ctx, ownerId).ui?.locale ?? "ko";
}
