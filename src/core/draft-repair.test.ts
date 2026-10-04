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
