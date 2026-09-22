import { describe, expect, it } from "vitest";
import { draftCoverageGuide, draftPrompt } from "./prompts.js";

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
