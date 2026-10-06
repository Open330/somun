/** 보정은 기존 문제를 줄이면서 새로운 위반을 만들지 않아야 한다. 서버·로컬 워커가 같은 기준으로 선택한다. */
export function isBetterRepair(before: { rule: string; detail?: string }[], after: { rule: string; detail?: string }[] | null): boolean {
  if (after === null || after.length >= before.length) return false;
  const previous = new Set(before.map((issue) => issue.rule));
  const grounding = new Set(["numbers_need_review", "author_role_need_review", "no_invented_limit", "repo_name", "avoid_terms", "preferred_link"]);
  return after.every(
    (issue) =>
      previous.has(issue.rule) &&
      (!grounding.has(issue.rule) || before.some((original) => original.rule === issue.rule && original.detail === issue.detail)),
  );
}
