import { expect, it } from "vitest";
import { editRatio, publicationEffect } from "./metrics.js";

const DAY = 86_400_000;
const at = (d: number) => 1_000 * DAY + d * DAY;

it("subtracts the pre-publication trend from the observed gain", () => {
  // 발행 전 7일 동안 하루 5개씩, 발행 뒤 7일 동안 40개.
  const points = [{ at: at(-7), stars: 100 }, { at: at(0), stars: 135 }, { at: at(7), stars: 175 }];
  expect(publicationEffect(points, at(0) + 1)).toEqual({ baseline: { at: at(0), stars: 135 }, observed: 40, expected: 35, excess: 5 });
});

it("reports only the observed gain when there is no earlier history", () => {
  const points = [{ at: at(0), stars: 10 }, { at: at(3), stars: 30 }];
  expect(publicationEffect(points, at(0) + 1)).toEqual({ baseline: { at: at(0), stars: 10 }, observed: 20 });
});

it("ignores snapshots after the window and before the baseline window", () => {
  const points = [{ at: at(-40), stars: 0 }, { at: at(-6), stars: 50 }, { at: at(0), stars: 50 }, { at: at(5), stars: 60 }, { at: at(20), stars: 500 }];
  expect(publicationEffect(points, at(0) + 1)).toMatchObject({ observed: 10, expected: 0, excess: 10 });
});

it("returns nothing without a snapshot before publication", () => {
  expect(publicationEffect([{ at: at(1), stars: 5 }], at(0))).toEqual({});
});

it("measures how much of a draft was rewritten, word by word", () => {
  expect(editRatio("a b c d", "a b c d")).toBe(0);
  expect(editRatio("a b c d", "a b x d")).toBe(0.25);
  expect(editRatio("초안을 그대로 썼습니다", "초안을 조금 고쳐 썼습니다")).toBeCloseTo(0.67, 2);
  expect(editRatio("a b", "c d e f g h")).toBe(1);
  expect(editRatio("", "")).toBe(0);
});
