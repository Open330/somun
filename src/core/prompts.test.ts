import { describe, expect, it } from "vitest";
import { unsupportedNumbers } from "./lint.js";
import { digestGroundingFromPrompt, digestPrompt, draftCoverageGuide, draftPrompt, factsBlock, judgePrompt, withoutFalseFirstClaims } from "./prompts.js";

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
    expect(judgePrompt(candidate, { recentPublished: [], enabledChannels: ["x"], feedback: [] }).user).not.toContain("Introducing the project");
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

describe("voice example labels", () => {
  it("does not present an unedited generated draft as the author's own voice", () => {
    const user = draftPrompt(candidate, "x", "en", [{ source: "accepted", body: "model text" }, { source: "authored", body: "my text" }]).user;
    expect(user).toContain("### Example 1 (an earlier generated draft the author copied without edits");
    expect(user).toContain("### Example 2 (author's own)");
  });
});

describe("judge reasoning", () => {
  it("drops 'first release' sentences when the project already has releases", () => {
    const text = "이 프로젝트는 첫 공개 시점이므로 새로움이 높습니다. 데모 GIF가 있어 바로 써 볼 수 있습니다.";
    expect(withoutFalseFirstClaims(text, 69)).toBe("데모 GIF가 있어 바로 써 볼 수 있습니다.");
    expect(withoutFalseFirstClaims("This is the first release. It runs today.", 69)).toBe("It runs today.");
    expect(withoutFalseFirstClaims(text, 1)).toBe(text);
  });
});
