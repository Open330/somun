import { expect, it } from "vitest";
import { isBetterRepair } from "./draft-repair.js";
it("accepts fewer existing issues but rejects a new factual violation", () => {
  const before = [{ rule: "sections" }, { rule: "length" }];
  expect(isBetterRepair(before, [{ rule: "sections" }])).toBe(true);
  expect(isBetterRepair(before, [])).toBe(true);
  expect(isBetterRepair(before, [{ rule: "numbers_need_review" }])).toBe(false);
  expect(isBetterRepair(before, [{ rule: "empty_body" }])).toBe(false);
  expect(isBetterRepair(before, before)).toBe(false);
  expect(isBetterRepair(before, null)).toBe(false);
});

it("does not replace one ungrounded measurement with another while fixing format", () => {
  expect(
    isBetterRepair([{ rule: "length" }, { rule: "numbers_need_review", detail: "40%" }], [{ rule: "numbers_need_review", detail: "80%" }]),
  ).toBe(false);
  expect(
    isBetterRepair([{ rule: "length" }, { rule: "numbers_need_review", detail: "40%" }], [{ rule: "numbers_need_review", detail: "40%" }]),
  ).toBe(true);
});

it("rejects a repair that launders an unsupported number into vague magnitude words", () => {
  const before = [{ rule: "length" }, { rule: "numbers_need_review", detail: "40%" }];
  const texts = (after: string) => ({ before: "Memory use is 40% lower! It now starts much faster on every run.", after });
  expect(isBetterRepair(before, [], texts("Memory use is dramatically lower."))).toBe(false);
  expect(isBetterRepair(before, [], texts("메모리 사용량이 절반으로 줄었습니다."))).toBe(false);
  expect(isBetterRepair(before, [], texts("Memory use is lower now."))).toBe(true);
  // 원래 있던 표현은 새 표현이 아니다.
  expect(isBetterRepair(before, [], texts("It starts much faster."))).toBe(true);
  // 수치 경고가 없던 보정은 문장 비교를 하지 않는다.
  expect(isBetterRepair([{ rule: "length" }], [], { before: "x", after: "dramatically" })).toBe(true);
});
