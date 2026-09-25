import { describe, expect, it } from "vitest";
import { draftCoverageGuide, draftPrompt, factsBlock, judgePrompt } from "./prompts.js";

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
    expect(judgePrompt(candidate, { recentPublished: [], enabledChannels: ["x"], feedback: [], introduction: true }).user).toContain("Nothing from this repository has been announced yet");
    expect(judgePrompt(candidate, { recentPublished: [], enabledChannels: ["x"], feedback: [] }).user).not.toContain("First introduction");
  });

  it("marks README experimental features as not available", () => {
    const facts = factsBlock({ ...candidate, evidence: { ...candidate.evidence, experimental: ["Short videos (experimental, local)"] } });
    expect(facts).toContain("never present them as something readers can use now");
    expect(facts).toContain("Short videos (experimental, local)");
  });
});
