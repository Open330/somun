/** 화면·계정 언어. 서버와 화면이 같이 쓴다. 언어를 늘리면 여기와 web/i18n의 사전만 고친다. */
export type Locale = "ko" | "en";

/** 두 언어 문장 중 해당 언어의 것. 언어가 없으면 한국어. */
export function say(locale: Locale | undefined, ko: string, en: string): string {
  return locale === "en" ? en : ko;
}
