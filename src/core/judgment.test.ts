import { expect, it } from "vitest";
import { splitJudgment } from "./judgment.js";

it("prefers the stored angle and reads the legacy suffix otherwise", () => {
  expect(splitJudgment({ reasoning: "Worth it.", angle: "The stuck agent problem" })).toEqual({ reasoning: "Worth it.", angle: "The stuck agent problem" });
  expect(splitJudgment({ reasoning: "Worth it.\n\n각도: The stuck agent problem" })).toEqual({ reasoning: "Worth it.", angle: "The stuck agent problem" });
  expect(splitJudgment({ reasoning: "각도: 본문 안에 있는 단어" })).toEqual({ reasoning: "각도: 본문 안에 있는 단어" });
  expect(splitJudgment({ reasoning: "No angle.", angle: null })).toEqual({ reasoning: "No angle." });
});
