import { unsupportedNumbers } from "../core/lint.js";

/**
 * 장면 검사 결과를 판정한다. 화면에 한 번이라도 보인 글자는 초안과 같은 기준을 지킨다:
 * 근거에 없는 숫자, 금지 표현, 느낌표, 스크립트 오류가 없어야 렌더할 수 있다.
 * 화면 밖으로 넘친 글자는 알리기만 한다: 들어오고 나가는 움직임 중간을 표본으로 잡으면 넘친 것처럼 보이기 때문이다.
 */
export type SceneSample = { t: number; text: string[]; overflow: string[] };
export type SceneProblem = { kind: "number" | "banned" | "exclamation" | "error" | "overflow" | "empty"; detail: string };

export function lintScene(samples: SceneSample[], errors: string[], grounding: string, banned: string[]): SceneProblem[] {
  const problems: SceneProblem[] = [];
  const lines = [...new Set(samples.flatMap((s) => s.text))];
  const all = lines.join("\n");
  if (!lines.length) problems.push({ kind: "empty", detail: "no visible text at any sampled time" });
  const missing = unsupportedNumbers(all, grounding);
  if (missing.length) problems.push({ kind: "number", detail: `numbers not in the facts: ${missing.join(", ")}. Remove them or use a number from the facts.` });
  const lower = all.toLowerCase();
  const hits = banned.filter((p) => p && lower.includes(p.toLowerCase()));
  if (hits.length) problems.push({ kind: "banned", detail: `banned phrases: ${hits.join(", ")}` });
  const bang = lines.filter((l) => l.includes("!"));
  if (bang.length) problems.push({ kind: "exclamation", detail: `exclamation marks in: ${bang.slice(0, 3).map((l) => JSON.stringify(l)).join(", ")}` });
  for (const e of [...new Set(errors)].slice(0, 5)) problems.push({ kind: "error", detail: e });
  const over = [...new Set(samples.flatMap((s) => s.overflow.map((o) => `t=${(s.t / 1000).toFixed(1)}s ${o}`)))];
  for (const o of over.slice(0, 5)) problems.push({ kind: "overflow", detail: `text outside the frame: ${o}` });
  return problems;
}

export const isBlocking = (p: SceneProblem) => p.kind !== "overflow";
