import { normalizeForMatch } from "./text-match.js";

/** 생성 결과에만 적용하는 좁은 편집. 새 주장·삭제·조건 축약은 하지 않는다. */
const registerInstruction = /해요체|합니다체|하십시오체|합쇼체|하오체|하게체|해라체|반말|존댓말|\b(?:haeyo|formal|informal|register)\b/i;
const protectedText = /```[\s\S]*?(?:```|$)|`[^`]*(?:`|$)|(?:^|\n)[\t ]*>[^\n]*|“[^”]*(?:”|$)|‘[^’]*(?:’|$)|"[^"]*(?:"|$)|'[^']*(?:'|$)|https?:\/\/\S+/g;

/** 확실한 활용만 바꾼다. 일반 '습니다', 명사+입니다, 질문·인용·코드는 해석하지 않는다. */
export function prepareIntroduction(body: string, options: { channel: string; language?: string; purpose?: string | null; tone?: string; editorInstruction?: string; bannedPhrases?: string[] }): string {
  if (options.purpose !== "introduction" || !["x", "threads"].includes(options.channel) || options.language?.toLowerCase().split("-")[0] !== "ko") return body;
  let prepared = body;
  const normalized = normalizeForMatch(body);
  const hasBannedPhrase = options.bannedPhrases?.some(phrase => {
    const value = normalizeForMatch(phrase).trim();
    return value && !/^(?:합니다|됩니다|있습니다|없습니다)$/.test(value) && normalized.includes(value);
  });
  if (!hasBannedPhrase && /해요체(?=$|[.,;·\s])/.test(options.tone ?? "") && !/합니다체|하십시오체|반말|해요체\s*(?:금지|아님|아닌|말고|대신|사용하지)/.test(options.tone ?? "") && !registerInstruction.test(options.editorInstruction ?? "")) {
    const ranges = [...body.matchAll(protectedText)].map(m => [m.index, m.index + m[0].length]);
    // 금칙어가 검출된 본문은 변환하지 않아 기존 경고를 보존한다.
    const endings: Record<string, string> = { 합니다: "해요", 됩니다: "돼요", 있습니다: "있어요", 없습니다: "없어요" };
    prepared = body.replace(/합니다|됩니다|있습니다|없습니다/g, (ending, at: number) => {
      if (ranges.some(([start, end]) => at >= start && at < end) || !/^\s*(?:[.!。！]|$)/.test(body.slice(at + ending.length))) return ending;
      return endings[ending];
    });
  }
  return prepared;
}
