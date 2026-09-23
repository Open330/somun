/**
 * 판단 결과의 "이유"와 "각도". 새 판단은 각도를 따로 저장한다(judgments.angle).
 * 예전 판단은 이유 끝에 "\n\n각도: …"로 붙어 있으므로 그 형식만 읽어서 나눈다.
 */
const LEGACY_ANGLE = "\n\n각도:";

export function splitJudgment(j: { reasoning: string; angle?: string | null }): { reasoning: string; angle?: string } {
  if (j.angle) return { reasoning: j.reasoning, angle: j.angle };
  const at = j.reasoning.indexOf(LEGACY_ANGLE);
  if (at < 0) return { reasoning: j.reasoning };
  return { reasoning: j.reasoning.slice(0, at), angle: j.reasoning.slice(at + LEGACY_ANGLE.length).trim() || undefined };
}
