import { expect, it } from "vitest";
import { conditionCandidates, conditionSources, reviewConditionParagraphs } from "./condition-review.js";
import { sourceConditionParagraphs } from "./prompts.js";

it("keeps review-only detection out of generation condition extraction", () => {
  const text = "Sync, when enabled, uses personal iCloud.\n\nUntil the product is purchasable, nothing is locked.";
  expect(reviewConditionParagraphs(text)).toHaveLength(2);
  expect(sourceConditionParagraphs(text)).toEqual([]);
});

it("does not present generated or unknown limitations as README source", () => {
  const limitations = ["Requires cloud setup"];
  expect(conditionSources({ repo: "a/b", repoUrl: "https://github.com/a/b", limitations, limitationsSource: "digest" })).toEqual([]);
  expect(conditionSources({ repo: "a/b", repoUrl: "https://github.com/a/b", limitations })).toEqual([]);
  expect(conditionSources({ repo: "a/b", repoUrl: "https://github.com/a/b", limitations, limitationsSource: "readme" })).toMatchObject([{ kind: "readme", text: limitations[0] }]);
});

it("includes all explicit profile constraints even without condition keywords", () => {
  const sources = conditionSources({ repo: "a/b", repoUrl: "https://github.com/a/b" }, { what: "Tool", audience: "Users", claims: [], stage: "beta", limitations: ["macOS 14+ / Apple Silicon"], naming: "Tool", avoid: [] });
  expect(conditionCandidates(sources)[0]).toMatchObject({ kind: "profile", excerpts: ["macOS 14+ / Apple Silicon"] });
});

it("reviews homepage conditions with their URL and invalidates stale or failed sources", () => {
  const homepage = "https://tool.example/";
  const e = { repo: "a/b", repoUrl: "https://github.com/a/b", homepage, homepageSource: { url: homepage, collectedAt: 1, status: "ok" as const, text: "Only available when enabled.", truncated: true } };
  expect(conditionSources(e)).toEqual([{ kind: "homepage", ref: "Homepage", text: e.homepageSource.text, url: homepage, incomplete: true }]);
  expect(conditionCandidates(conditionSources(e))).toHaveLength(1);
  expect(conditionSources({ ...e, homepage: "https://other.example/" })).toEqual([]);
  expect(conditionSources({ ...e, homepageSource: { ...e.homepageSource, status: "failed" } })).toEqual([]);
});
