/**
 * 제품 문구 일관성 점검(순수 함수). 저장소 설명, 홈페이지 제목·설명, 승인한 한 줄 소개 같은 짧은 문구를 README와 비교한다.
 * 의미를 판정하지 않고 관찰 가능한 두 가지만 본다.
 * - retired: README가 지원 종료라고 적은 이름이 짧은 문구에 남아 있다(예: Tend 설명의 Gemini CLI).
 * - not_in_readme: 짧은 문구의 고유명(대문자가 든 라틴 낱말)이 README 어디에도 없다(예: Oh My Prompt 설명의 MinIO).
 * README가 잘렸으면 뒷부분에 있을 수 있어 not_in_readme는 보지 않는다.
 */
export type CopySource = "description" | "homepage_title" | "homepage_description" | "oneliner_ko" | "oneliner_en";
export type CopyIssue = { kind: "retired" | "not_in_readme"; source: CopySource; term: string };

// README에서 "<이름> is no longer supported", "<이름> (is) deprecated", "<이름>은 지원 종료" 꼴만 잡는다. "작업 중단" 같은 일반 문장은 잡지 않는다.
const RETIRED_EN = /((?:[A-Z][\w+#.-]*\s){0,3}[A-Z][\w+#.-]*)\s+(?:support\s+)?(?:is|are|has been|have been|was|were)?\s*(?:no longer supported|deprecated|discontinued|end[- ]of[- ]life|retired)\b/g;
const RETIRED_KO = /((?:[A-Z][\w+#.-]*\s){0,3}[A-Z][\w+#.-]*)\s*(?:은|는|의|에 대한)?\s*(?:지원(?:이|을)?\s*(?:종료|중단)|더 이상 지원하지)/g;
const LEADING = new Set(["The", "A", "An", "Google", "Note", "Warning"]);
// 문장 첫머리가 아니어도 대문자로 쓰는 일반 낱말. 고유명이 아니므로 README에 없어도 알리지 않는다.
const COMMON = new Set(["I", "AI", "UI", "API", "CLI", "OS", "URL", "OTP", "PR", "PRs", "README", "OK", "Mac", "macOS", "iOS", "GitHub", "Rust", "One", "No", "New"]);

const words = (s: string) => s.split(/\s+/).filter(Boolean);

/** README가 지원 종료라고 적은 이름들. 맨 앞의 관사·회사 이름은 뺀 이름도 함께 돌려준다(The Google Gemini CLI → Gemini CLI). */
export function retiredNames(readme: string): string[] {
  const out = new Set<string>();
  for (const re of [RETIRED_EN, RETIRED_KO]) {
    for (const m of readme.matchAll(re)) {
      const w = words(m[1]!);
      while (w.length > 1 && LEADING.has(w[0]!)) w.shift();
      if (w.length === 1 && LEADING.has(w[0]!)) continue;
      out.add(w.join(" "));
    }
  }
  return [...out];
}

/** 짧은 문구에서 고유명 후보. 대문자가 든 라틴 낱말 가운데 문장 첫 낱말과 일반 낱말은 뺀다. */
export function properTerms(text: string): string[] {
  const out: string[] = [];
  const tokens = text.split(/(\s+|[,;:()·/—–"“”'‘’]|\.(?=\s|$)|[!?。])/);
  let sentenceStart = true;
  for (const raw of tokens) {
    if (raw === undefined || !raw.trim()) continue;
    if (/^[.!?。:—–]$/.test(raw)) { sentenceStart = true; continue; }
    if (/^[,;()·/"“”'‘’]$/.test(raw)) continue;
    const token = raw.replace(/^[^\w]+|[^\w+#]+$/g, "");
    const latin = /^[A-Za-z][\w+#.-]*$/.test(token);
    if (latin && /[A-Z]/.test(token) && !sentenceStart && !COMMON.has(token) && token.length >= 2) out.push(token);
    sentenceStart = false;
  }
  return [...new Set(out)];
}

export function copyIssues(input: { readme?: string; readmeTruncated?: boolean; productName?: string; texts: { source: CopySource; text?: string }[] }): CopyIssue[] {
  const readme = input.readme ?? "";
  if (!readme.trim()) return [];
  const lower = readme.toLowerCase();
  const retired = retiredNames(readme);
  const name = input.productName?.toLowerCase();
  const issues: CopyIssue[] = [];
  for (const { source, text } of input.texts) {
    if (!text?.trim()) continue;
    for (const term of retired) {
      if (new RegExp(`(?<![\\w])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "i").test(text)) issues.push({ kind: "retired", source, term });
    }
    if (input.readmeTruncated) continue;
    for (const term of properTerms(text)) {
      const t = term.toLowerCase();
      if (t === name || lower.includes(t)) continue;
      issues.push({ kind: "not_in_readme", source, term });
    }
  }
  return issues;
}
