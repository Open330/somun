import { describe, expect, it } from "vitest";
import { unsupportedNumbers } from "./lint.js";
import { digestGroundingFromPrompt, digestPrompt, draftCoverageGuide, draftPrompt, factsBlock, judgePrompt } from "./prompts.js";

const candidate = { title: "A release", type: "release", evidence: { repo: "test/tool", repoUrl: "https://github.com/test/tool", highlights: ["CRLF positions are corrected.", "Only whole node_modules path segments are dependencies.", "Proxy matchers are pre-compiled."] } };

describe("draft coverage contract", () => {
  it.each(["show_hn", "show_gn", "linkedin", "blog"] as const)("keeps each supplied change visible to the %s generator", (channel) => {
    const prompt = draftPrompt(candidate, channel, "en", []);
    const checklist = prompt.user.split("## Required change checklist")[1];
    for (const fact of candidate.evidence.highlights) expect(checklist).toContain(fact);
    expect(checklist).toContain("within the channel character limit");
  });
  it.each(["x", "threads"] as const)("does not force a full changelog into %s", (channel) => {
    const guide = draftCoverageGuide(candidate, channel);
    expect(guide).toContain("Select concrete changes that fit");
    expect(guide).not.toContain("Preserve every distinct change");
  });
  it("does not invent checklist items without evidence and limits Korean terminology guidance to Korean", () => {
    expect(draftCoverageGuide({ ...candidate, evidence: { ...candidate.evidence, highlights: [] } }, "show_gn")).toBe("");
    expect(draftPrompt(candidate, "show_gn", "ko", []).user).toContain("line endings → 줄바꿈");
    expect(draftPrompt(candidate, "show_hn", "en", []).user).not.toContain("line endings → 줄바꿈");
  });
});

describe("first introduction", () => {
  it("replaces the change checklist with an introduction brief", () => {
    const prompt = draftPrompt(candidate, "show_gn", "ko", [], undefined, { introduction: true });
    expect(prompt.user).toContain("## First introduction");
    expect(prompt.user).not.toContain("## Required change checklist");
  });

  it("asks the judge about the project, not the size of the window", () => {
    expect(judgePrompt(candidate, { recentPublished: [], enabledChannels: ["x"], feedback: [], introduction: true }).user).toContain("has not announced this repository through this tool yet");
    expect(judgePrompt(candidate, { recentPublished: [], enabledChannels: ["x"], feedback: [] }).user).not.toContain("First introduction");
  });

  it("marks README experimental features as not available", () => {
    const facts = factsBlock({ ...candidate, evidence: { ...candidate.evidence, experimental: ["Short videos (experimental, local)"] } });
    expect(facts).toContain("never present them as something readers can use now");
    expect(facts).toContain("Short videos (experimental, local)");
  });
});

it("does not feed repository bookkeeping to introduction writers while preserving update evidence", () => {
  const input = { ...candidate, evidence: { ...candidate.evidence, commitCount: 90, releaseCount: 12, firstReleaseAt: "2020-01-02" } };
  const introduction = draftPrompt(input, "blog", "ko", [], undefined, { introduction: true });
  expect(introduction.user).not.toContain("commits: 90");
  expect(introduction.user).not.toContain("releases: 12");
  expect(introduction.user).toContain("Public project name: tool");
  expect(draftPrompt(input, "show_hn", "en", []).user).toContain("commits: 90");
});

describe("digest grounding", () => {
  it("does not let disputed or already-told numbers ground a digest highlight", () => {
    const c = { title: "a/x v2", type: "release", evidence: { repo: "a/x", repoUrl: "https://github.com/a/x", releaseNotes: "Startup is 40% faster." } };
    const prompt = digestPrompt(c, { alreadyTold: ["Builds are 5x faster."], disputed: ["Memory use dropped 70%."] });
    expect(prompt.user).toContain("70%");
    const grounding = digestGroundingFromPrompt(prompt.user);
    expect(grounding).toContain("Startup is 40% faster.");
    expect(unsupportedNumbers("Memory down 70%", grounding)).toEqual(["70%"]);
    expect(unsupportedNumbers("5x faster builds", grounding)).toEqual(["5x"]);
    expect(unsupportedNumbers("Startup 40% faster", grounding)).toEqual([]);
  });
});
