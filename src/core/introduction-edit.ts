import { normalizeForMatch } from "./text-match.js";

/** 생성 결과에만 적용하는 좁은 편집. 새 주장·삭제·조건 축약은 하지 않는다. */
export function introductionOpening(sentence: string): "definition" | "intent" | undefined {
  if (/^[^.!?\n]{1,60}(?:은|는)\s+[^.!?\n]{0,220}(?:소프트웨어|프로그램|도구|플랫폼)(?:입니다|이에요|예요|다)[.!。]?$/u.test(sentence)
    || /^[\w .'-]{1,60}\s+is\s+(?:an?|the)\s+[^.!?\n]*\b(?:tool|software|platform|application|program)\b[^.!?\n]*[.!]?$/i.test(sentence)) return "definition";
  if (/(?:하려는\s*(?:사용자|사람)(?:들)?(?:은|는)|(?:연결|관리)하려면|할\s*수\s*있도록)[^.!?\n]{1,100}사용(?:하여|합니다|해요|할\s*수\s*있(?:습니다|어요))/u.test(sentence)
    || /^[^.!?\n]{1,100}(?:를|을)\s*사용하면[,\s]+[^.!?\n]{1,160}(?:연결|관리)할\s*수\s*있(?:습니다|어요)[.!。]?$/u.test(sentence)
    || /^[^.!?\n]{1,40}(?:를|을)\s*사용해\s+[^.!?\n]{1,160}(?:연결|관리|제어)할\s*수\s*있(?:습니다|어요)[.!。]?$/u.test(sentence)
    || /\busers? who (?:want|wish) to\b[^.!?\n]+\bcan use\b/i.test(sentence)) return "intent";
  return undefined;
}

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
  if (options.editorInstruction?.trim()) return prepared;
  // Segmenter는 같은 줄의 마지막 URL을 앞 문장에 붙이기도 한다. 링크를 손대지 않고 별도로 보존한다.
  const linkAt = prepared.search(/\s+https?:\/\/[^\s"'<>`“”‘’]+\s*$/);
  const prose = linkAt >= 0 ? prepared.slice(0, linkAt) : prepared;
  const link = linkAt >= 0 ? prepared.slice(linkAt) : "";
  const sentences = [...new Intl.Segmenter("ko", { granularity: "sentence" }).segment(prose)].filter(s => s.segment.trim());
  if (sentences.length < 2) return prepared;
  const [a, b] = sentences;
  const first = a.segment.trim(), next = b.segment.trim();
  if (!introductionOpening(first) || !/[.!。！]$/.test(first) || !/[.!。！]$/.test(next)) return prepared;
  // 조건/순서가 있는 도입이나 앞 문장에 의존하는 문장은 이동하지 않는다.
  if (/\d|["'“”‘’`>#]|https?:|\b(?:only|except|unless|requires?|before|after|first|last|minimum|default)\b|경우|조건|때|먼저|이후|이전|전에|뒤에|권한|필수|필요|켜|끄|한해|이상|이하|미만|초과|제외|한정|오직|기본|[가-힣]만(?=\s|[,.])/i.test(first)) return prepared;
  if (/^(?:이를|이것|이때|이후|이어서|그것|그런|그때|해당|또한|따라서|그러므로|그러면|여기서|같은|다음으로|그\s*(?:뒤|다음))|^(?:이|그)\s*(?:파일|문서|기기|화면|작업|도구|제품|기능|항목)/.test(next)) return prepared;
  if (/["'“”‘’`>#]|https?:|켜|활성화|설정/.test(next) || !/(?:파일|문서|사진|이미지|기기|화면|코드|음성|녹음|초안|게시글|릴리스|커밋|PR|계정|데이터|폴더|저장소|서버|주소록|항목)/.test(next)) return prepared;
  // 두 문장의 내용은 그대로 교환한다. URL과 나머지 문단도 그대로 남긴다.
  const aStart = a.index + a.segment.indexOf(first), bStart = b.index + b.segment.indexOf(next);
  return prose.slice(0, aStart) + next + prose.slice(aStart + first.length, bStart) + first + prose.slice(bStart + next.length) + link;
}
