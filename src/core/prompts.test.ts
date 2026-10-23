import { channelSpec } from "./channels.js";
import { describe, expect, it } from "vitest";
import { unsupportedNumbers } from "./lint.js";
import { digestGroundingFromPrompt, digestPrompt, draftCoverageGuide, draftPrompt, draftPurposeOf, factsBlock, groundingText, instructionOf, judgePrompt, prConditionsBlock, prSourceBlock, sourceConditionParagraphs, withoutFalseFirstClaims } from "./prompts.js";

const candidate = { title: "A release", type: "release", evidence: { repo: "test/tool", repoUrl: "https://github.com/test/tool", highlights: ["CRLF positions are corrected.", "Only whole node_modules path segments are dependencies.", "Proxy matchers are pre-compiled."] } };

it("preserves whole source paragraphs and their context without the prompt excerpt budget", () => {
  const first = "Setup:\r\n- Set both values.\r\n- Fails if only one is set.";
  const last = "Minimum: at least 50% of requested items.\nRound up.";
  expect(sourceConditionParagraphs(`${first}\r\n\r\n${"Ordinary notes. ".repeat(1000)}\r\n\r\n${last}`)).toEqual([first, last]);
});

it("keeps mandatory exclusions above optional caveats and sentence budgets", () => {
  const p = draftPrompt(candidate, "threads", "ko", [], "Describe the change");
  expect(p.system).toContain("MUST stay even when the channel does not request limitations");
  expect(p.user).toContain("eligibility and exclusions are mandatory regardless of channel");
  expect(p.user).not.toContain("Do not add a limitation unless");
});

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

it("keeps verbatim source conditions before the final drafting brief without laundering them into verified facts", () => {
  const body = "A title alone says one or two questions short.\n- 마지막 시도는 50% 이상이면 짧은 퀴즈를 반환합니다. 첫 시도는 여전히 전체 수를 요구합니다.\nUnrelated internal rename.";
  const c = { ...candidate, evidence: { ...candidate.evidence, mergedPrDetails: [{ number: 111, title: "Partial result", body, url: "https://github.com/test/tool/pull/111" }] } };
  const excerpts = prConditionsBlock(c.evidence);
  expect(excerpts).toContain(body.split("\n")[1]);
  expect(excerpts).not.toContain("Unrelated internal rename");
  expect(excerpts).toContain("not an exhaustive list");
  expect(digestPrompt(c).user.endsWith(excerpts)).toBe(true);
  const draft = draftPrompt(c, "threads", "ko", []);
  expect(draft.user).toContain(excerpts);
  expect(draft.user.indexOf(excerpts)).toBeLessThan(draft.user.indexOf("## Coverage"));
  expect(draft.user.indexOf(excerpts)).toBeLessThan(draft.user.indexOf("## Final output"));
  expect(draftPrompt(c, "show_hn", "en", [], undefined, { introduction: true }).system).toContain("Omit backend LLM provider");
});

it("does not attach recent conditional change highlights to first introductions", () => {
  const intro = draftPrompt({ ...candidate, evidence: { ...candidate.evidence, description: "Formats source locations." } }, "show_hn", "en", [], undefined, { introduction: true });
  for (const highlight of candidate.evidence.highlights) expect(intro.user).not.toContain(highlight);
  expect(intro.user).toContain("Historical PR changes belong in updates and source review");
  expect(draftPrompt(candidate, "threads", "ko", [], undefined, { introduction: false }).user).toContain(candidate.evidence.highlights[0]);
});

it("leaves backend implementation out of general introductions while preserving source checks, integrations and provider topics", () => {
  const backend = "Azure OpenAI를 사용하여 코드를 분석하고 관련 질문을 생성합니다.";
  const profile = { what: "A repository quiz app", audience: "Developers", claims: ["Generates questions from repositories.", backend, "Connects Claude Code through MCP."], limitations: [], stage: "unknown", naming: "tool", avoid: [] };
  const before = structuredClone(profile);
  const intro = draftPrompt(candidate, "show_hn", "en", [], undefined, { profile, introduction: true });
  expect(intro.user).not.toContain(backend);
  expect(intro.user).toContain("Generates questions from repositories.");
  expect(intro.user).toContain("Connects Claude Code through MCP.");
  expect(groundingText(candidate, profile)).toContain(backend);
  expect(profile).toEqual(before);
  expect(draftPrompt(candidate, "show_hn", "en", [], undefined, { profile, introduction: false }).user).toContain(backend);
  expect(draftPrompt(candidate, "show_hn", "en", [], "Explain the OpenAI backend", { profile, introduction: true }).user).toContain(backend);
  expect(draftPrompt(candidate, "show_hn", "en", [], undefined, { profile, introduction: true, instruction: "Explain the OpenAI backend" }).user).toContain(backend);
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
    expect(prompt.user).toContain("No URLs in the body");
  });
});


describe("project introduction writing brief", () => {
  it("uses collected README conditions even with a saved coarse profile", () => {
    const profile = { what: "web app", audience: "developers", claims: ["Learns from copies and edits"], stage: "beta", limitations: [], naming: "tool", avoid: [] };
    const readmeForChecks = "Drafts you edit before copying become voice examples. Irreversible events need consent before becoming official records.";
    const prompt = draftPrompt({ ...candidate, evidence: { ...candidate.evidence, readmeExcerpt: "A short summary", readmeForChecks } }, "threads", "ko", [], undefined, { introduction: true, profile });
    expect(prompt.user).toContain(readmeForChecks);
    expect(prompt.user).toContain("collection completeness is unknown");
    expect(prompt.user).toContain("Missing text is not evidence");
    expect(prompt.user).toContain("Maximum 6 sentences");
    expect(prompt.user).not.toContain("Maximum 2 sentences");
    expect(prompt.user).not.toContain("Rules: One or two sentences");
    expect(prompt.user).toContain("Maximum 500 characters");
    expect(prompt.user).toContain("No URLs in the body");
  });
  it("keeps X platform limits without the old 220-character introduction target", () => {
    const prompt = draftPrompt(candidate, "x", "ko", [], undefined, { introduction: true });
    expect(prompt.user).toContain("Maximum 280 characters");
    expect(prompt.user).toContain("3-4 short sentences");
    expect(prompt.user).not.toContain("220 characters");
    expect(prompt.user).toContain("Use fewer sentences when evidence is sparse");
  });
  it("preserves updates and custom channel limits", () => {
    expect(draftPrompt(candidate, "threads", "ko", []).user).toContain("Maximum 2 sentences");
    const spec = { ...channelSpec("threads"), id: "custom_brief" as const, maxSentences: 1, rules: "Exactly one sentence." };
    const prompt = draftPrompt(candidate, spec.id, "ko", [], undefined, { introduction: true, channelSpec: spec });
    expect(prompt.user).toContain("Maximum 1 sentences");
    expect(prompt.user).toContain("Rules: Exactly one sentence.");
    expect(prompt.user).not.toContain("3-5 short sentences");
  });
});


it("retains an explicitly stricter builtin sentence budget for introductions", () => {
  const prompt = draftPrompt(candidate, "threads", "ko", [], undefined, { introduction: true, channelSpec: { ...channelSpec("threads"), maxSentences: 1 } });
  expect(prompt.user).toContain("Maximum 1 sentences");
  expect(prompt.user).not.toContain("Maximum 6 sentences");
  expect(prompt.user).not.toContain("4-5 short sentences");
});


it("uses introduction space for distinctive reader value rather than a generic setup summary", () => {
  const prompt = draftPrompt(candidate, "threads", "ko", [], undefined, { introduction: true });
  expect(prompt.user).toContain("구체적인 사용 상황과 제품명·종류·주용도를 도입에서 연결해 설명");
  expect(prompt.user).toContain("서로 다른 동작과 보이는 결과");
  expect(prompt.system).toContain("connected main actions");
  expect(prompt.user).not.toContain("If only two supported sentences");
  expect(prompt.user).not.toContain("then add one concrete workflow detail");
});


it.each(["x", "threads"] as const)("keeps the core product task ahead of a narrow release fix for %s introductions", (channel) => {
  const c = { ...candidate, evidence: { ...candidate.evidence, description: "Remote desktop for Windows and Mac", readmeForChecks: "Control another device's screen. Browse files in a separate window without a screen connection. Files require SSH access.", releaseNotes: "Copied files remain available after closing the source window." } };
  const intro = draftPrompt(c, channel, "ko", [], undefined, { introduction: true });
  expect(intro.user).toContain(c.evidence.readmeForChecks);
  expect(intro.user).not.toContain(c.evidence.releaseNotes);
  expect(intro.user).toContain("제품명·종류·주용도를 도입에서 연결해 설명");
  expect(intro.user).toContain("Historical PR changes belong in updates");
  expect(intro.user).toContain("what is this product, when would the reader need it");
  expect(intro.user).toContain("각 문장은 서로 다른 정보를 보태는 완결된 문장");
  expect(intro.user).toContain("Keep each retained capability's prerequisites and exclusions");
  expect(intro.editorInstruction).toBe("");
  expect(intro.system).toContain("what kind of product this is");
  expect(intro.user).toContain(channel === "x" ? "Use a supplied link in the body" : "No URLs in the body");
  expect(intro.system).toContain("concrete reader need");
  const update = draftPrompt(c, channel, "ko", [], undefined, { introduction: false });
  expect(update.system).not.toContain("A concrete product/category description is welcome");
  expect(update.user).not.toContain("can they identify the product's main use");
  expect(update.user).not.toContain("Do not lead with maintenance, edge cases or regression fixes");
});


describe("README-backed introduction facts", () => {
  it("uses collected source instead of generated category cues while respecting user edits and unknown provenance", () => {
    const profile = { what: "A generic file-management tool", audience: "Remote device managers", claims: [], stage: "stable", limitations: ["SSH required"], naming: "tool", avoid: ["internal-host"] };
    const c = { ...candidate, evidence: { ...candidate.evidence, readmeForChecks: "Open remote folders over SSH in separate windows." } };
    const original = structuredClone(profile);
    const auto = draftPrompt(c, "threads", "ko", [], undefined, { introduction: true, profile, profileEditedFields: [], profileClaimsEdited: false });
    expect(auto.user).not.toContain(profile.what);
    expect(auto.user).not.toContain(profile.audience);
    expect(auto.user).toContain("SSH required");
    expect(auto.user).toContain("internal-host");
    expect(groundingText(c, profile)).toContain(profile.what);
    for (const options of [{ introduction: true }, { introduction: true, profileEditedFields: ["what", "audience"] as (keyof typeof profile)[] }, { introduction: false, profileEditedFields: [] }]) {
      expect(draftPrompt(c, "threads", "ko", [], undefined, { ...options, profile }).user).toContain(profile.what);
    }
    expect(draftPrompt(candidate, "threads", "ko", [], undefined, { introduction: true, profile, profileEditedFields: [] }).user).toContain(profile.what);
    expect(profile).toEqual(original);
    expect(auto.schema.properties).toMatchObject({ title: { enum: [""] }, body: { type: "string" } });
  });
  it("keeps historical PR changes in updates and grounding instead of baseline introductions", () => {
    const body = "New installations default to prompting on every connection.";
    const c = { ...candidate, evidence: { ...candidate.evidence, readmeForChecks: "Browse remote files over SSH without opening a remote screen.", readmeTruncated: false, mergedPrDetails: [{ number: 5, title: "Change confirmation defaults", body, url: "https://github.com/test/tool/pull/5" }] } };
    const intro = draftPrompt(c, "x", "ko", [], undefined, { introduction: true });
    expect(intro.user).not.toContain(body);
    expect(intro.user).not.toContain("Change confirmation defaults");
    expect(intro.user).toContain(c.evidence.readmeForChecks);
    expect(intro.user).toContain("complete README snapshot");
    expect(intro.user).toContain("does not establish production activation or inclusion in a named release");
    expect(groundingText(c)).toContain(body);
    expect(draftPrompt(c, "x", "ko", [], undefined, { introduction: false }).user).toContain(body);
    expect(draftPrompt(c, "x", "ko", [], undefined, { introduction: true, instruction: "Explain the confirmation defaults" }).user).toContain(body);
    const withoutReadme = { ...c, evidence: { ...c.evidence, readmeForChecks: undefined, description: "A remote file tool" } };
    expect(draftPrompt(withoutReadme, "x", "ko", [], undefined, { introduction: true }).user).toContain(body);
    const legacy = { ...c, evidence: { ...c.evidence, readmeTruncated: undefined } };
    expect(draftPrompt(legacy, "x", "ko", [], undefined, { introduction: true }).user).toContain("collection completeness is unknown");
    expect(draftPrompt(legacy, "x", "ko", [], undefined, { introduction: true }).user).not.toContain("complete README snapshot");
  });
  it("supplies current release behavior and conditions even when the saved profile is generic", () => {
    const c = { ...candidate, evidence: { ...candidate.evidence, releaseNotes: "Copy in device A's file window, close it, then paste into device B's new file window. Drag between Itda file windows on Mac and Windows. Windows executable is unsigned." } };
    const profile = { what: "Remote desktop", audience: "Computer users", claims: ["Browse via SFTP"], stage: "stable", limitations: [], naming: "tool", avoid: [] };
    const prompt = draftPrompt(c, "x", "ko", [], undefined, { introduction: true, profile, profileClaimsEdited: false });
    expect(prompt.user).toContain("## Current release source");
    expect(prompt.user).toContain(c.evidence.releaseNotes);
    expect(prompt.user).toContain("Preserve the release's prerequisites, platform scope and limitations");
  });
  const claim = "Private sync across devices";
  const profile = { what: "A voice recorder", audience: "Meeting participants", claims: [claim], stage: "beta", limitations: ["Requires setup"], naming: "tool", avoid: ["automatic uploads"] };
  const c = { ...candidate, evidence: { ...candidate.evidence, readmeForChecks: "Captures speech and creates summaries. Cross-device sync, when enabled, uses personal iCloud." } };
  it("uses source capabilities instead of generated coarse claims while preserving profile identity and constraints", () => {
    const before = structuredClone(profile);
    const prompt = draftPrompt(c, "threads", "ko", [], undefined, { introduction: true, profile, profileClaimsEdited: false });
    expect(prompt.user).not.toContain(claim);
    expect(prompt.user).toContain("when enabled");
    expect(prompt.user).toContain(profile.what);
    expect(prompt.user).toContain(profile.limitations[0]);
    expect(prompt.user).toContain(profile.avoid[0]);
    expect(groundingText(c, profile)).toContain(claim);
    expect(profile).toEqual(before);
  });
  it("keeps updates, edited or unknown-origin claims and README-free introductions byte-identical", () => {
    for (const [source, introduction, profileClaimsEdited] of [[c, false, false], [c, true, true], [c, true, undefined], [candidate, true, false]] as const) {
      const preserved = draftPrompt(source, "threads", "ko", [], undefined, { introduction, profile, profileClaimsEdited });
      const previous = draftPrompt(source, "threads", "ko", [], undefined, { introduction, profile });
      expect(preserved).toEqual(previous);
      expect(preserved.user).toContain(claim);
    }
  });
  it("treats blank README as missing and falls back to a meaningful excerpt", () => {
    const blank = { ...candidate, evidence: { ...candidate.evidence, readmeForChecks: "  " } };
    expect(draftPrompt(blank, "threads", "ko", [], undefined, { introduction: true, profile, profileClaimsEdited: false }).user).toContain(claim);
    const withExcerpt = { ...blank, evidence: { ...blank.evidence, readmeExcerpt: "Sync only when enabled." } };
    const prompt = draftPrompt(withExcerpt, "threads", "ko", [], undefined, { introduction: true, profile, profileClaimsEdited: false });
    expect(prompt.user).toContain("Sync only when enabled.");
    expect(prompt.user).not.toContain(claim);
  });
});


describe("complete introduction source", () => {
  const workflow = "Preview playback works independently of exporting. Closing the preview leaves ongoing exports active. Exports require confirmation.";
  const overview = "A desktop app for previewing and exporting media files on Windows and macOS.";
  const readme = `${overview}\n\n## Preview\n\n${workflow}\n\n## Storage\n\nUnrelated storage details.`;
  const c = { ...candidate, evidence: { ...candidate.evidence, description: overview, readmeForChecks: readme, readmeTruncated: true, releaseNotes: "A separate storage feature.", limitations: ["Local files only"], experimental: ["Cloud export is experimental"] } };
  const profile = { what: overview, audience: "Media managers", claims: ["A separate broad generated claim"], stage: "beta", limitations: ["Only authorized accounts"], naming: "Studio", avoid: ["internal-node"] };
  it.each(["x", "threads"] as const)("keeps product context and conditions without forcing a small workflow for %s", channel => {
    const original = structuredClone(c);
    const prompt = draftPrompt(c, channel, "ko", [], undefined, { introduction: true, profile, profileEditedFields: [], profileClaimsEdited: false });
    expect(prompt.user).not.toContain("## Selected source paragraph");
    expect(prompt.user).toContain(workflow);
    expect(prompt.user).toContain(overview);
    expect(prompt.user).toContain(readme);
    expect(prompt.user).toContain("Unrelated storage details.");
    expect(prompt.user).not.toContain(c.evidence.releaseNotes);
    expect(prompt.user).not.toContain(profile.claims[0]);
    for (const constraint of ["Local files only", "Cloud export is experimental", "Only authorized accounts", "Studio", "internal-node", "beta"]) expect(prompt.user).toContain(constraint);
    expect(prompt.user).toContain("collected README snapshot is truncated");
    expect(prompt.user).toContain("Missing text is not evidence");
    expect(prompt.user).not.toContain("at most TWO factual sentences");
    expect(prompt.user).not.toContain("Only this paragraph supplies the introduction topic");
    expect(prompt.user).toContain("what is this product, when would the reader need it");
    expect(prompt.user).toContain("Do not combine independent capabilities into a simultaneous behavior");
    expect(groundingText(c, profile)).toContain(readme);
    expect(groundingText(c, profile)).toContain(profile.claims[0]);
    expect(c).toEqual(original);
  });
  it("preserves full sources with explicit instructions, edited profiles and legacy snapshots", () => {
    for (const options of [{ introduction: false, profileEditedFields: [] }, { introduction: true, instruction: "Use a comparison", profileEditedFields: [] }, { introduction: true, profileEditedFields: ["claims"] as (keyof typeof profile)[] }, { introduction: true, profileEditedFields: ["naming"] as (keyof typeof profile)[] }, { introduction: true }]) {
      const prompt = draftPrompt(c, "threads", "ko", [], undefined, { ...options, profile });
      expect(prompt.user).not.toContain("## Selected source paragraph");
      if (options.introduction) expect(prompt.user).toContain(readme);
    }
    for (const source of [{ ...c, evidence: { ...c.evidence, readmeTruncated: undefined } }, { ...c, evidence: { ...c.evidence, readmeForChecks: undefined, readmeExcerpt: readme } }]) {
      expect(draftPrompt(source, "x", "ko", [], undefined, { introduction: true }).user).not.toContain("## Selected source paragraph");
    }
    expect(draftPrompt(c, "linkedin", "ko", [], undefined, { introduction: true }).user).not.toContain("## Selected source paragraph");
  });
  it.each([
    "Preview works without another window.",
    "Preview is independent of exporting only after setup.",
    "Preview is independent of exporting but is unsupported.",
    "License checking works independently of exporting.",
    "Contributors test whether playback is independent of exporting.",
    "`Playback is independent of exporting.`",
    '“Playback is independent of exporting.”',
  ])("preserves documented conditions without forcing an independence phrase into the topic: %s", text => {
    const source = { ...c, evidence: { ...c.evidence, readmeForChecks: `Overview.\n\n${text}\n\nEnd.` } };
    const prompt = draftPrompt(source, "x", "ko", [], undefined, { introduction: true });
    expect(prompt.user).not.toContain("## Selected source paragraph");
    expect(prompt.user).toContain(text);
  });
  it("marks unknown source coverage instead of certifying a cut workflow", () => {
    const source = { ...c, evidence: { ...c.evidence, readmeForChecks: `Studio previews local media.\n\n## Preview\n\n${workflow}` } };
    expect(draftPrompt(source, "x", "ko", [], undefined, { introduction: true }).user).not.toContain("## Selected source paragraph");
    const complete = { ...source, evidence: { ...source.evidence, readmeTruncated: false } };
    expect(draftPrompt(complete, "x", "ko", [], undefined, { introduction: true }).user).toContain("complete README snapshot");
  });
});


it("retains separate task and global conditions as source constraints", () => {
  const readme = "Studio previews and exports local media files.\n\n## Requirements\n\nA paid account and macOS 14 are required.\n\n## Preview\n\nPreview works independently of exporting.\n\nPreview requires approval.\n\n### Access\n\nGuests cannot preview private documents.\n\n## License\n\nMIT.";
  const source = { ...candidate, evidence: { ...candidate.evidence, readmeForChecks: readme, readmeTruncated: false } };
  const prompt = draftPrompt(source, "x", "ko", [], undefined, { introduction: true });
  expect(prompt.user).not.toContain("## Selected source paragraph");
  expect(prompt.user).toContain("A paid account and macOS 14 are required.");
  expect(prompt.user).toContain("Preview requires approval.");
  expect(prompt.user).toContain("Guests cannot preview private documents.");
  expect(prompt.user).toContain(readme);
  expect(prompt.user).toContain("MIT.");
});

it.each([
  "<h2>License</h2>\n\nPreview works independently of exporting.\n\n## End\n\nDone.",
  "License\n-------\n\nPreview works independently of exporting.\n\n## End\n\nDone.",
  "## Example\n\n```text\n\nPreview works independently of exporting.\n\n```\n\n## End\n\nDone.",
  "## Example\n\n~~~text\n\nPreview works independently of exporting.\n\n~~~\n\n## End\n\nDone.",
  "## License\n\nPreview works independently of exporting.\n\n## End\n\nDone.",
  "## Contributing\n\n### Example\n\nPreview works independently of exporting.\n\n## End\n\nDone.",
  "## Preview\n\nPreview works independently of exporting.\n\nPartial condition",
  "## Preview\n\nPreview works independently of exporting.\n\n## Requirements\n\nPartial global requirement",
])("keeps source evidence intact across code, licensing and cut conditions: %s", readme => {
  const source = { ...candidate, evidence: { ...candidate.evidence, readmeForChecks: `Studio previews and exports local media files.\n\n${readme}`, readmeTruncated: true } };
  const prompt = draftPrompt(source, "x", "ko", [], undefined, { introduction: true });
  expect(prompt.user).not.toContain("## Selected source paragraph");
  expect(prompt.user).toContain(readme);
});

it("keeps the product capability overview with its identity instead of reducing the introduction to a supporting feature", () => {
  const readme = "Studio previews and exports media files on desktop computers.\n\n## Features\n\nOpen local media in a preview and export selected items. Exporting requires approval.\n\n## Preview workflow\n\nPreview works independently of exporting.\n\n## License\n\nMIT.";
  const source = { ...candidate, evidence: { ...candidate.evidence, readmeForChecks: readme, readmeTruncated: false } };
  const prompt = draftPrompt(source, "x", "ko", [], undefined, { introduction: true });
  const identity = prompt.user;
  expect(identity).toContain("Studio previews and exports media files on desktop computers.");
  expect(identity).toContain("Open local media in a preview and export selected items. Exporting requires approval.");
  expect(prompt.user).not.toContain("Only this paragraph supplies the introduction topic");
  expect(prompt.user).not.toContain("at most TWO factual sentences");
});

it("keeps the full source when the README has no opening product description", () => {
  const readme = "## Preview\n\nPreview works independently of exporting.\n\n## License\n\nMIT.";
  const source = { ...candidate, evidence: { ...candidate.evidence, readmeForChecks: readme, readmeTruncated: false } };
  const prompt = draftPrompt(source, "x", "ko", [], undefined, { introduction: true });
  expect(prompt.user).toContain(readme);
  expect(prompt.user).not.toContain("## Product identity and scope");
});


it.each(["x", "threads"] as const)("keeps release truncation and channel audience visible in %s introduction requests", channel => {
  const releaseNotes = "Source sentence. ".repeat(500) + "Late prerequisite: authorized accounts only.";
  const source = { ...candidate, evidence: { ...candidate.evidence, releaseNotes, readmeForChecks: "A runnable product." } };
  const base = channelSpec(channel);
  const prompt = draftPrompt(source, channel, "ko", [], undefined, {
    introduction: true,
    instruction: "Explain the current release",
    channelSpec: { ...base, identity: { ...base.identity!, audience: "Researchers working with remote devices" } },
  });
  expect(prompt.user).toContain("[Release source truncated: check the original for missing prerequisites and exclusions.]");
  expect(prompt.user).not.toContain("Late prerequisite: authorized accounts only.");
  expect(source.evidence.releaseNotes).toBe(releaseNotes);
  expect(prompt.user).toContain("Audience: Researchers working with remote devices");
  expect(prompt.user).toContain("Purpose: ");
  expect(instructionOf(prompt.user)).toBe("Explain the current release");
});

 it("grounds introduction reader tasks in the collected homepage without losing README prerequisites", () => {
  const homepage = "https://tool.example/";
  const text = "Outside the local network, install the connector on every device and sign into the same account.";
  const c = { ...candidate, evidence: { ...candidate.evidence, homepage, homepageSource: { url: homepage, collectedAt: 1, status: "ok" as const, text, truncated: true }, readmeForChecks: "The viewer must be enabled. File access requires SSH.", readmeTruncated: false } };
  const prompt = draftPrompt(c, "x", "ko", [], undefined, { introduction: true });
  expect(prompt.user).toContain(text);
  expect(prompt.user).toContain("Homepage source truncated");
  expect(prompt.user).toContain(c.evidence.readmeForChecks);
  expect(groundingText(c)).toContain(text);
  for (const changed of [{ ...c.evidence, homepage: "https://other.example/" }, { ...c.evidence, homepageSource: { ...c.evidence.homepageSource, status: "failed" as const } }]) {
    expect(draftPrompt({ ...c, evidence: changed }, "x", "ko", [], undefined, { introduction: true }).user).not.toContain(text);
    expect(groundingText({ ...c, evidence: changed })).not.toContain(text);
  }
});
