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
  // 수치 경고가 없으면 막연한 크기 표현을 비교하지 않는다.
  expect(isBetterRepair([{ rule: "length" }], [], { before: "x", after: "dramatically" })).toBe(true);
});


it("does not trade an unsupported endorsement for a different endorsement when fixing format", () => {
  const before = [{ rule: "sentence_count" }, { rule: "endorsement_need_review", detail: "It would be useful." }];
  expect(isBetterRepair(before, [{ rule: "endorsement_need_review", detail: "I recommend it." }])).toBe(false);
  expect(isBetterRepair(before, [{ rule: "endorsement_need_review", detail: "It would be useful." }])).toBe(true);
  expect(isBetterRepair(before, [])).toBe(true);
});


it("rejects an automatic repair that changes an otherwise consistent Korean register", () => {
  const issues = [{ rule: "endorsement_need_review" }];
  expect(isBetterRepair(issues, [], { before: "somun은 초안을 작성해요. 정말 유용할 것 같아요.", after: "somun은 초안을 작성합니다." })).toBe(false);
  expect(isBetterRepair(issues, [], { before: "somun은 초안을 작성해요. 정말 유용할 것 같아요.", after: "somun은 초안을 작성해요." })).toBe(true);
  expect(isBetterRepair(issues, [], { before: "somun은 초안을 작성합니다. 정말 유용할 것 같습니다.", after: "somun은 초안을 작성해요." })).toBe(false);
  expect(isBetterRepair(issues, [], { before: "I recommend this tool.", after: "The tool reads logs." })).toBe(true);
});


it("allows register correction only when the selected channel violation is cleared", () => {
  const texts = { before: "somun은 초안을 작성합니다.", after: "somun은 초안을 작성해요." };
  expect(isBetterRepair([{ rule: "register_mismatch" }], [], texts)).toBe(true);
  expect(isBetterRepair([{ rule: "register_mismatch" }, { rule: "length" }], [{ rule: "register_mismatch" }], texts)).toBe(false);
  expect(isBetterRepair([{ rule: "register_mismatch" }], [{ rule: "numbers_need_review" }], texts)).toBe(false);
});
