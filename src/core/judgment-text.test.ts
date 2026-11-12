import { expect, it } from "vitest";
import { judgmentTextIssues } from "./judgment-text.js";
import { DEFAULT_BANNED_PHRASES } from "./lint.js";

it("flags the broken production judgment of 2026-11-12", () => {
  const reasoning = "Tend는 여러 코딩 아젠트 세션을 관리하는 운영 플랫폼으로, 노벨티 점수가 높습니다. 여러 에ージェント를 동시에 다루는 개발자에게 유용합니다.";
  const issues = judgmentTextIssues({ reasoning, angle: "CLI 및 운영 플랫폼 Tend를 소개합니다." }, "ko", DEFAULT_BANNED_PHRASES);
  expect(issues).toHaveLength(3);
  expect(judgmentTextIssues({ reasoning: "runnable 조건을 충족합니다." }, "ko")).toHaveLength(1);
});

it("passes clean Korean and English judgments", () => {
  expect(judgmentTextIssues({ reasoning: "아직 X에 소개한 적이 없어 새로움이 높습니다. 홈페이지에서 바로 설치할 수 있습니다.", angle: "Tend는 기다리는 에이전트 창을 알려 줍니다." }, "ko", DEFAULT_BANNED_PHRASES)).toEqual([]);
  expect(judgmentTextIssues({ reasoning: "Novelty is high: it was never introduced.", angle: "Tend shows which agent waits." }, "en", DEFAULT_BANNED_PHRASES)).toEqual([]);
});
