import { describe, expect, it } from "vitest";
import { conditionCandidates, conditionSources, introductionEvidence, readmeOnlyIntroduction, reviewConditionParagraphs } from "./condition-review.js";
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

describe("introduction drafts review only the sources they are written from", () => {
  const e = { repo: "o/t", repoUrl: "https://github.com/o/t", readmeForChecks: "Requires tmux 3.x.\n\nTend watches agents.", releaseNotes: "Only on macOS 15.", mergedPrDetails: [{ number: 7, title: "Flag", body: "Only when the flag is on.", url: "u" }] };
  it("drops release notes and PRs for a README-based introduction (Tend: 29 sources, 20 PRs)", () => {
    const kinds = conditionSources(introductionEvidence(e)).map((s) => s.kind);
    expect(kinds).toContain("readme");
    expect(kinds).not.toContain("pr");
    expect(kinds).not.toContain("release");
  });
  it("is applied only to drafts whose scope is README-only (see readmeOnlyIntroduction)", () => {
    expect(conditionSources(e).map((s) => s.kind)).toEqual(expect.arrayContaining(["pr", "release"]));
  });
});

describe("README-only scope follows the generation contract (Codex on #97)", () => {
  const e = { repo: "o/t", repoUrl: "https://github.com/o/t", readmeForChecks: "# Tool\n\nTool stores notes.", readmeTruncated: true, mergedPrDetails: [{ number: 1, title: "Export", body: "Cloud export works only when the export flag is enabled.", url: "u" }] };
  it("narrows only a default X/Threads introduction, or one with a complete README", () => {
    expect(readmeOnlyIntroduction("introduction", "x", undefined, e)).toBe(true);
    expect(readmeOnlyIntroduction("introduction", "x", "Introduce the Cloud export feature from PR #1.", e)).toBe(false);
    expect(readmeOnlyIntroduction("introduction", "linkedin", undefined, e)).toBe(false);
    expect(readmeOnlyIntroduction("introduction", "linkedin", undefined, { ...e, readmeTruncated: false })).toBe(true);
    expect(readmeOnlyIntroduction("update", "x", undefined, e)).toBe(false);
    expect(readmeOnlyIntroduction("introduction", "x", undefined, { ...e, readmeForChecks: undefined })).toBe(false);
  });
});
