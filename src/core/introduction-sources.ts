/**
 * 소개글이 "왜 이 방식인가"로 시작할 수 있게 원문에서 근거 후보를 고른다 (순수).
 *
 * - introductionReasons: 완전한 README의 개요·동기 절(첫 문단)을 그대로 뽑는다. 모델은 이 중 하나를
 *   readerReasonSource로 고르고, 이 값은 게시 본문·사실 대조 근거가 아니라 선택 기록일 뿐이다.
 * - introductionScopeExcerpts: 홈페이지 원문에서 지원 범위·전제 조건을 말하는 줄만 모아
 *   채널 계약 앞에서 다시 보여 준다. 개요 문장이 조건을 잃지 않게 하기 위함이다.
 */

const REASON_HEADING = /^(?:why\b|motivation\b|overview\b|about\b|what is\b|introduction\b|features?\b|소개|왜|개요|특징|주요 기능|동기)/i;
const MAX_REASONS = 4;
const MAX_REASON_CHARS = 600;
const SCOPE_LINE = /\b(?:only|requires?|required|requirements?|supported|unsupported|must|limited to|except|excludes?|not available)\b|만\s|필요|지원|제외|불가|전용/i;
const MAX_SCOPE_LINES = 6;
const MAX_SCOPE_CHARS = 300;

function firstParagraph(lines: string[]): string {
  const out: string[] = [];
  let fenced = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("```")) { fenced = !fenced; if (out.length) break; continue; }
    if (fenced) continue;
    if (!line) { if (out.length) break; continue; }
    // 배지·이미지·HTML·표만 있는 줄은 이유가 아니다.
    if (/^(?:!\[|\[!\[|<|\|)/.test(line)) { if (out.length) break; continue; }
    out.push(line);
  }
  return out.join(" ").trim();
}

/** README의 제목·개요 절에서 읽은 그대로의 소개 근거 후보. 잘린 README에서는 빈 배열. */
export function introductionReasons(readme: string | undefined): string[] {
  if (!readme?.trim()) return [];
  const lines = readme.split(/\r?\n/);
  const titleIndex = lines.findIndex((l) => /^#\s+\S/.test(l));
  const title = titleIndex >= 0 ? lines[titleIndex].trim() : "";
  const reasons: string[] = [];
  const push = (text: string) => {
    if (text.length > 0 && text.length <= MAX_REASON_CHARS && !reasons.includes(text)) reasons.push(text);
  };
  // 제목 바로 아래 첫 문단(첫 ## 전까지).
  if (titleIndex >= 0) {
    const end = lines.findIndex((l, i) => i > titleIndex && /^#{1,2}\s/.test(l));
    const lead = firstParagraph(lines.slice(titleIndex + 1, end < 0 ? undefined : end));
    if (lead) push(`${title}\n${lead}`);
  }
  for (let i = 0; i < lines.length && reasons.length < MAX_REASONS; i++) {
    const m = lines[i].match(/^##\s+(.+?)\s*#*\s*$/);
    if (!m || !REASON_HEADING.test(m[1])) continue;
    const end = lines.findIndex((l, j) => j > i && /^#{1,2}\s/.test(l));
    const para = firstParagraph(lines.slice(i + 1, end < 0 ? undefined : end));
    if (para) push([title, `## ${m[1]}`, para].filter(Boolean).join("\n"));
  }
  return reasons.slice(0, MAX_REASONS);
}

/** 홈페이지 원문 중 지원 범위·전제 조건을 말하는 줄. */
export function introductionScopeExcerpts(homepageText: string | undefined): string[] {
  if (!homepageText?.trim()) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of homepageText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.length > MAX_SCOPE_CHARS || !SCOPE_LINE.test(line) || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= MAX_SCOPE_LINES) break;
  }
  return out;
}
