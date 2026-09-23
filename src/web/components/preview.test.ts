import { expect, it } from "vitest";
import { diffParts } from "./preview";

it("diffs word by word and keeps whitespace", () => {
  expect(diffParts("a b c", "a x c")).toEqual([{ t: "eq", s: "a" }, { t: "eq", s: " " }, { t: "del", s: "b" }, { t: "ins", s: "x" }, { t: "eq", s: " " }, { t: "eq", s: "c" }]);
});

it("falls back to line diff for long texts so typing stays responsive", () => {
  const long = Array.from({ length: 1200 }, (_, i) => `line ${i} has some words`).join("\n");
  const parts = diffParts(long, long.replace("line 5 has", "line 5 had"));
  expect(parts.filter((p) => p.t !== "eq").map((p) => p.s)).toEqual(["line 5 has some words", "line 5 had some words"]);
});
