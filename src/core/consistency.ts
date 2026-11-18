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
// 긴 README에서 정규식이 되돌아가지 않게, 반복 없는 표현 자체만 먼저 찾고, 그 앞 짧은 구간에서 연결어를 떼고 이름을 읽는다.
const RETIRED_MARK = /no longer supported|deprecated|discontinued|end[- ]of[- ]life|\bretired\b|지원(?:이|을)? ?(?:종료|중단)|더 이상 지원하지/gi;
const CONNECTOR = / (?:support )?(?:is|are|has been|have been|was|were|now|being)?(?: now)? ?$| ?(?:은|는|의|에 대한) ?$/;
const NAME_BEFORE = /((?:[A-Z][\w+#.-]{0,40} ){0,3}[A-Z][\w+#.-]{0,40})$/;
const WINDOW = 160;
const LEADING = new Set(["The", "A", "An", "Google", "Note", "Warning"]);
// 문장 첫머리가 아니어도 대문자로 쓰는 일반 낱말. 고유명이 아니므로 README에 없어도 알리지 않는다.
const COMMON = new Set(["I", "AI", "UI", "API", "CLI", "OS", "URL", "OTP", "PR", "PRs", "README", "OK", "Mac", "macOS", "iOS", "GitHub", "Rust", "One", "No", "New"]);

const words = (s: string) => s.split(/\s+/).filter(Boolean);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 앞의 기호와 뒤의 기호(+·# 제외)를 뗀다. 정규식 대신 앞뒤에서 한 번씩만 걷는다. */
function trimToken(raw: string): string {
  let a = 0, b = raw.length;
  while (a < b && !/\w/.test(raw[a]!)) a++;
  while (b > a && !/[\w+#]/.test(raw[b - 1]!)) b--;
  return raw.slice(a, b);
}

/** README가 지원 종료라고 적은 이름들. 맨 앞의 관사·회사 이름은 뺀 이름도 함께 돌려준다(The Google Gemini CLI → Gemini CLI). */
export function retiredNames(readme: string): string[] {
  // **Gemini CLI**, `Gemini CLI`, [Gemini CLI](url) 같은 Markdown 꾸밈을 벗겨야 이름 바로 뒤의 표현과 붙는다.
  // 낱말 안의 밑줄(OLD_SYNC)은 이름의 일부라 남긴다.
  const text = readme
    .replace(/\[([^\]\n]{1,200})\]\([^)\n]{0,500}\)/g, "$1")
    .replace(/[*`]+/g, "")
    // 밑줄 묶음은 한 번에 잡고(_+ 는 묶음 끝까지 간 뒤 앞으로 나아간다), 양옆이 모두 글자일 때만 남긴다.
    .replace(/_+/g, (run: string, at: number, all: string) => (/\w/.test(all[at - 1] ?? "") && /\w/.test(all[at + run.length] ?? "") ? run : ""));
  const out = new Set<string>();
  for (const m of text.matchAll(RETIRED_MARK)) {
    // 대문자로 시작한 표현(Deprecated flags…)은 새 문장이라 앞 낱말을 가리키지 않는다.
    if (/^[A-Z]/.test(m[0])) continue;
    // 짧은 구간 안에서만 본다. 빈 줄(문단 경계) 앞은 다른 문단이고, 공백은 하나로 모은다.
    const raw = text.slice(Math.max(0, m.index - WINDOW), m.index);
    const before = raw.slice(raw.search(/\n\s*\n(?![\s\S]*\n\s*\n)/) + 1).replace(/\s+/g, " ");
    const stripped = before.replace(CONNECTOR, "");
    // 문장이 끝난 뒤에 나온 표현("…Tend. Deprecated options")은 앞 낱말을 가리키지 않는다.
    if (/[.:!?]$/.test(stripped)) continue;
    const found = stripped.match(NAME_BEFORE);
    if (!found) continue;
    let w = words(found[1]!);
    // 앞 문장 끝 낱말(Foo.)은 이름이 아니다. 마침표로 끝나는 마지막 낱말 다음부터 읽는다.
    for (let i = w.length - 2; i >= 0; i--) {
      if (/\.$/.test(w[i]!)) { w = w.slice(i + 1); break; }
    }
    while (w.length > 1 && LEADING.has(w[0]!)) w.shift();
    if (w.length === 1 && LEADING.has(w[0]!)) continue;
    out.add(w.join(" "));
  }
  return [...out];
}

/** 짧은 문구에서 고유명 후보. 대문자가 든 라틴 낱말 가운데 일반 낱말과, 문장 첫머리라 대문자가 된 평범한 낱말(Record, Turn)은 뺀다. MinIO·OpenCode처럼 안에 대문자가 더 있으면 첫머리여도 남긴다. */
export function properTerms(text: string): string[] {
  const out: string[] = [];
  // 문구는 짧다. 긴 문구는 앞부분만 보고, 낱말이 아주 길면(기호 줄 등) 고유명으로 보지 않는다.
  const tokens = text.slice(0, 2000).split(/(\s+|[,;:()·/—–"“”'‘’]|\.(?=\s|$)|[!?。])/);
  let sentenceStart = true;
  for (const raw of tokens) {
    if (raw === undefined || !raw.trim()) continue;
    if (/^[.!?。:—–]$/.test(raw)) { sentenceStart = true; continue; }
    if (/^[,;()·/"“”'‘’]$/.test(raw)) continue;
    if (raw.length > 80) { sentenceStart = false; continue; }
    const token = trimToken(raw);
    const latin = /^[A-Za-z][\w+#.-]*$/.test(token);
    const ordinary = /^[A-Z][a-z]+$/.test(token);
    if (latin && /[A-Z]/.test(token) && !(sentenceStart && ordinary) && !COMMON.has(token) && token.length >= 2) out.push(token);
    sentenceStart = false;
  }
  return [...new Set(out)];
}

export function copyIssues(input: { readme?: string; readmeTruncated?: boolean; productName?: string; texts: { source: CopySource; text?: string }[] }): CopyIssue[] {
  const readme = input.readme ?? "";
  if (!readme.trim()) return [];
  // 낱말 단위로 찾는다. Git이 GitHub 안에 들어 있다고 README에 있는 것으로 치지 않는다.
  // 라틴 글자·숫자로만 경계를 본다. 한국어 조사(MinIO를)는 붙어 있어도 언급으로 친다.
  const mentioned = (term: string) => new RegExp(`(?<![A-Za-z0-9_])${escape(term)}(?![A-Za-z0-9_])`, "i").test(readme);
  const retired = retiredNames(readme);
  const name = input.productName?.toLowerCase();
  const issues: CopyIssue[] = [];
  for (const { source, text } of input.texts) {
    if (!text?.trim()) continue;
    for (const term of retired) {
      if (new RegExp(`(?<![\\w])${escape(term)}(?![\\w])`, "i").test(text)) issues.push({ kind: "retired", source, term });
    }
    if (input.readmeTruncated) continue;
    for (const term of properTerms(text)) {
      const t = term.toLowerCase();
      if (t === name || mentioned(term)) continue;
      issues.push({ kind: "not_in_readme", source, term });
    }
  }
  return issues;
}
