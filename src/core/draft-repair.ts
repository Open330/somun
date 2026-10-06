/**
 * 수치를 지우는 대신 막연한 크기 표현으로 바꾼 흔적. "40% lower"를 "dramatically lower"로 바꾸면 경고는 사라져도 근거 없는 주장은 남는다.
 */
const VAGUE_MAGNITUDE = /\b(?:dramatically|significantly|substantially|massively|drastically|vastly|halved|doubled|tripled|quadrupled|tenfold|orders? of magnitude|a fraction of|much (?:faster|smaller|lower|higher|better|less|more))\b|대폭|획기적으로|절반|반으로|몇\s?배|수십\s?배|수백\s?배|훨씬|크게\s?(?:줄|늘|향상|개선|빨라|단축)/gi;

const vaguePhrases = (text: string) => new Set([...text.matchAll(VAGUE_MAGNITUDE)].map((m) => m[0].toLowerCase().replace(/\s+/g, " ")));

/**
 * 보정은 기존 문제를 줄이면서 새로운 위반을 만들지 않아야 한다. 서버·로컬 워커가 같은 기준으로 선택한다.
 * texts가 있으면, 근거 없는 수치 경고를 없앤 대가로 막연한 크기 표현을 새로 넣은 보정도 거절한다.
 */
export function isBetterRepair(before: { rule: string; detail?: string }[], after: { rule: string; detail?: string }[] | null, texts?: { before: string; after: string }): boolean {
  if (after === null || after.length >= before.length) return false;
  const previous = new Set(before.map((issue) => issue.rule));
  const grounding = new Set(["numbers_need_review", "claims_need_review", "author_role_need_review", "no_invented_limit", "repo_name", "avoid_terms", "preferred_link"]);
  const fewer = after.every(
    (issue) =>
      previous.has(issue.rule) &&
      (!grounding.has(issue.rule) || before.some((original) => original.rule === issue.rule && original.detail === issue.detail)),
  );
  if (!fewer || !texts || !before.some((issue) => issue.rule === "numbers_need_review")) return fewer;
  const had = vaguePhrases(texts.before);
  return [...vaguePhrases(texts.after)].every((phrase) => had.has(phrase));
}
