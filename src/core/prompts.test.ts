import { describe, expect, it } from "vitest";
import { unsupportedNumbers } from "./lint.js";
import { digestGroundingFromPrompt, digestPrompt, draftCoverageGuide, draftPrompt, draftPurposeOf, factsBlock, groundingText, instructionOf, judgePrompt, prConditionsBlock, prSourceBlock, withoutFalseFirstClaims } from "./prompts.js";

const candidate = { title: "A release", type: "release", evidence: { repo: "test/tool", repoUrl: "https://github.com/test/tool", highlights: ["CRLF positions are corrected.", "Only whole node_modules path segments are dependencies.", "Proxy matchers are pre-compiled."] } };

it("carries conditional PR source data through digest, judge, draft and numeric grounding", () => {
  const c = { ...candidate, evidence: { ...candidate.evidence, mergedPrDetails: [{ number: 111, title: "Deliver partial quiz", body: "Only the last attempt may deliver at least 50% of the requested questions. Default off for GitHub App.", url: "https://github.com/test/tool/pull/111" }] } };
  const digest = digestPrompt(c);
  const judge = judgePrompt(c, { recentPublished: [], enabledChannels: ["x"], feedback: [] });
  const draft = draftPrompt(c, "threads", "ko", [], undefined, { introduction: false });
  for (const prompt of [digest, judge, draft]) expect(prompt.user).toContain(c.evidence.mergedPrDetails[0].body);
  expect(digest.system).toContain("last-attempt requirements");
  expect(draft.user).toContain("never translate unreleased as not deployed");
  expect(unsupportedNumbers("At least 50% on the last attempt", groundingText(c))).toEqual([]);
  expect(unsupportedNumbers("At least 75% on the last attempt", groundingText(c))).not.toEqual([]);
  expect(digestGroundingFromPrompt(digest.user)).toContain("Default off for GitHub App");
});

it("bounds PR source context by whole bodies and discloses collection truncation", () => {
  const source = (number: number, body: string, bodyTruncated = false) => ({ number, title: `PR ${number}`, body, url: `https://github.com/test/tool/pull/${number}`, bodyTruncated });
  const block = prSourceBlock({ ...candidate.evidence, mergedPrDetails: [source(1, "x".repeat(47000)), source(2, "MISSING".repeat(1000)), source(3, "Short source", true)] });
  expect(block).toContain("Short source");
  expect(block).not.toContain("MISSING");
  expect(block).toContain("Source truncated during collection");
});

it("repeats verbatim source conditions at the end of digest and draft without laundering them into verified facts", () => {
  const body = "A title alone says one or two questions short.\n- 마지막 시도는 50% 이상이면 짧은 퀴즈를 반환합니다. 첫 시도는 여전히 전체 수를 요구합니다.\nUnrelated internal rename.";
  const c = { ...candidate, evidence: { ...candidate.evidence, mergedPrDetails: [{ number: 111, title: "Partial result", body, url: "https://github.com/test/tool/pull/111" }] } };
  const excerpts = prConditionsBlock(c.evidence);
  expect(excerpts).toContain(body.split("\n")[1]);
  expect(excerpts).not.toContain("Unrelated internal rename");
  expect(excerpts).toContain("not an exhaustive list");
  expect(digestPrompt(c).user.endsWith(excerpts)).toBe(true);
  expect(draftPrompt(c, "threads", "ko", []).user.endsWith(excerpts)).toBe(true);
  expect(draftPrompt(c, "show_hn", "en", [], undefined, { introduction: true }).system).toContain("Omit backend LLM provider");
});

it("does not attach recent conditional change highlights to first introductions", () => {
  const intro = draftPrompt({ ...candidate, evidence: { ...candidate.evidence, description: "Formats source locations." } }, "show_hn", "en", [], undefined, { introduction: true });
  for (const highlight of candidate.evidence.highlights) expect(intro.user).not.toContain(highlight);
  expect(intro.user).toContain("PR bodies are constraints");
  expect(draftPrompt(candidate, "threads", "ko", [], undefined, { introduction: false }).user).toContain(candidate.evidence.highlights[0]);
});

describe("draft coverage contract", () => {
  it.each(["show_hn", "show_gn", "linkedin", "blog"] as const)("keeps each supplied change visible to the %s generator", (channel) => {
    const prompt = draftPrompt(candidate, channel, "en", []);
    const checklist = prompt.user.split("## Available changes")[1];
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
    expect(prompt.user).not.toContain("## Available changes");
  });

  it("asks the judge about the project, not the size of the window", () => {
    expect(judgePrompt(candidate, { recentPublished: [], enabledChannels: ["x"], feedback: [], introduction: true }).user).toContain("has not confirmed a publication for this repository");
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

describe("stored draft prompts", () => {
  it("recovers the editor instruction and purpose from a stored prompt", () => {
    const user = draftPrompt(candidate, "x", "en", [], undefined, { instruction: "Make it shorter", introduction: true }).user;
    expect(instructionOf(user)).toBe("Make it shorter");
    expect(draftPurposeOf(null, user)).toBe("introduction");
    expect(draftPurposeOf({ draftPurpose: "update" }, user)).toBe("update");
    expect(instructionOf(draftPrompt(candidate, "x", "en", []).user)).toBeUndefined();
  });
});

it("puts every release note in the window into the raw material and the grounding", () => {
  const c = { title: "a/m", type: "release", evidence: { repo: "a/m", repoUrl: "u", version: "pkg-c@0.0.1", releaseNotes: "C notes", windowReleaseNotes: [{ tag: "pkg-a@1.2.0", notes: "Startup 40% faster" }, { tag: "pkg-c@0.0.1", notes: "C notes" }] } };
  const raw = groundingText(c);
  expect(raw).toContain("## Release notes (pkg-a@1.2.0)\nStartup 40% faster");
  expect(raw.match(/C notes/g)).toHaveLength(1);
});

it("grounds checks on the longer README text, not only the 1500-character prompt excerpt", () => {
  const long = `${"intro ".repeat(400)}APIs may still change before 1.0.`;
  const c = { title: "a/m", type: "release", evidence: { repo: "a/m", repoUrl: "u", readmeExcerpt: long.slice(0, 1500), readmeForChecks: long } };
  expect(groundingText(c)).toContain("before 1.0.");
});


describe("draft purpose on channels with links outside the body", () => {
  const candidate = { title: "somun update", type: "in-progress" as const, evidence: { repo: "Open330/somun", repoUrl: "https://github.com/Open330/somun", highlights: ["Added a side-by-side source comparison view."] } };
  it("keeps the update coverage instruction for Threads with a reply link", () => {
    const prompt = draftPrompt(candidate, "threads", "ko", [], undefined, { introduction: false });
    expect(prompt.draftPurpose).toBe("update");
    expect(prompt.user).toContain("## Coverage");
    expect(prompt.user).toContain("lead with one concrete change from the supplied highlights");
    expect(prompt.user).toContain("Keep supplied URLs out of the body");
    expect(prompt.user).not.toContain("## First introduction");
  });
  it("keeps introduction coverage and the no-body-link rule together", () => {
    const prompt = draftPrompt(candidate, "threads", "ko", [], undefined, { introduction: true });
    expect(prompt.draftPurpose).toBe("introduction");
    expect(prompt.user).toContain("## First introduction");
    expect(prompt.user).not.toContain("## Coverage");
    expect(prompt.user).toContain("Keep supplied URLs out of the body");
  });
});
