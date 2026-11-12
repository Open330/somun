import { normalizeForMatch } from "./text-match.js";

/**
 * 판단 이유·각도 문장 검사. 2026-11-12 운영 판단에서 "아젠트", "에ージェント", "노벨티"가 그대로 저장됐다.
 * 각도는 초안 프롬프트에 그대로 들어가므로 금지어("소개합니다")도 본다. 문장의 사실성은 판정하지 않는다.
 */
const KANA_OR_HAN = /[぀-ヿㇰ-ㇿ一-鿿]/u;
const BAD_TRANSLITERATION = /아젠트|에이젠트|노벨티|런너블|러너블|오디언스|넘버스\s?점수|레슨\s?점수/u;
const RUBRIC_WORD = /\b(?:runnable|novelty|audience|numbers|lesson)\b/iu;

export function judgmentTextIssues(text: { reasoning?: string; angle?: string }, locale: "ko" | "en" = "ko", banned: string[] = []): string[] {
  const issues: string[] = [];
  const all = `${text.reasoning ?? ""}\n${text.angle ?? ""}`;
  if (KANA_OR_HAN.test(all)) issues.push("Japanese kana or Chinese characters are mixed into the text.");
  if (locale === "ko" && BAD_TRANSLITERATION.test(all)) issues.push("A term is transliterated into Korean (e.g. 아젠트, 노벨티); write 에이전트 and plain Korean words instead.");
  if (locale === "ko" && RUBRIC_WORD.test(all)) issues.push("English rubric keys (runnable, novelty, audience, numbers, lesson) appear in Korean text; describe them in Korean words.");
  const angle = normalizeForMatch(text.angle ?? "");
  const hits = banned.filter((phrase) => normalizeForMatch(phrase).trim() && angle.includes(normalizeForMatch(phrase).trim()));
  if (hits.length) issues.push(`The angle uses banned phrases: ${hits.join(", ")}.`);
  return issues;
}
