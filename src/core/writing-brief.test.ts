import { expect, it } from "vitest";
import { digestGroundingFromPrompt, digestPrompt, draftPrompt, groundingText, type EvidenceLike } from "./prompts.js";
import { currentWritingBrief, parseWritingBrief, sourceSnapshot } from "./writing-brief.js";

const highlight = "Read a repository using the App.";
const source = (number: number, body: string) => ({ number, title: `Change ${number}`, body, url: `https://github.com/a/tool/pull/${number}` });
const evidence = { repo: "a/tool", repoUrl: "https://github.com/a/tool", highlights: [highlight, "Refund quota after an undelivered run."], mergedPrDetails: [source(1, "FULL_SELECTED_BODY: Read a repository using the App."), source(2, "OTHER_BODY_NOT_FOR_WRITING\nDefault off; enable REPO_ACCESS=true to read via the App."), source(3, "UNRELATED_BODY_NOT_FOR_WRITING\nRefund cap is 3 per day.")] };
const selection = { highlight, readerAction: "Read a repository using the App.", sourcePrNumbers: [1, 2], requiredConditions: [{ sourcePrNumber: 2, quote: "Default off; enable REPO_ACCESS=true to read via the App." }] };
const candidate = (ev: EvidenceLike = evidence) => ({ title: "Tool changes", type: "in-progress", evidence: ev });

it("narrows writing bodies while retaining cross-PR conditions and full verification sources", () => {
  const brief = parseWritingBrief({ ...selection, sourcePrNumbers: [1], requiredConditions: [] }, evidence)!;
  const c = candidate({ ...evidence, writingBrief: brief });
  const prompt = draftPrompt(c, "threads", "en", []);
  const writing = prompt.user.split("## Cross-source conditions")[0];
  expect(writing).toContain(evidence.mergedPrDetails[0].body);
  expect(writing).not.toContain("OTHER_BODY_NOT_FOR_WRITING");
  expect(writing).not.toContain("UNRELATED_BODY_NOT_FOR_WRITING");
  expect(prompt.user).toContain("Default off; enable REPO_ACCESS=true");
  expect(prompt.user).toContain("Refund cap is 3 per day.");
  expect(prompt.user).toContain("Do not turn their other features, numbers or caveats into additional post topics");
  expect(prompt.user.indexOf("## Selected writing brief")).toBeGreaterThan(prompt.user.indexOf("## Cross-source conditions"));
  expect(groundingText(c)).toContain("UNRELATED_BODY_NOT_FOR_WRITING");
});

it("supports multiple full source references without mutating the original material", () => {
  const before = structuredClone(evidence);
  const brief = parseWritingBrief(selection, evidence)!;
  const prompt = draftPrompt(candidate({ ...evidence, writingBrief: brief }), "x", "en", []);
  expect(prompt.user).toContain(evidence.mergedPrDetails[1].body);
  expect(brief.sourcePrNumbers).toEqual([1, 2]);
  expect(evidence).toEqual(before);
});

it.each([
  { ...selection, highlight: "Invented summary" },
  { ...selection, readerAction: "" },
  { ...selection, readerAction: "Two\nlines" },
  { ...selection, sourcePrNumbers: [] },
  { ...selection, sourcePrNumbers: [999] },
  { ...selection, sourcePrNumbers: [1, 1] },
  { ...selection, sourcePrNumbers: [1.5] },
  { ...selection, requiredConditions: [{ sourcePrNumber: 3, quote: "Refund cap is 3 per day." }] },
  { ...selection, requiredConditions: [{ sourcePrNumber: 2, quote: "Enabled by default." }] },
  { ...selection, requiredConditions: undefined },
])("rejects an invalid selection without narrowing evidence: %j", (value) => {
  expect(parseWritingBrief(value, evidence)).toBeUndefined();
});

it("rejects incomplete, oversized and changed source snapshots", () => {
  expect(parseWritingBrief(selection, { ...evidence, mergedPrDetails: evidence.mergedPrDetails.map(p => ({ ...p, bodyTruncated: true })) })).toBeUndefined();
  expect(parseWritingBrief(selection, { ...evidence, mergedPrDetails: [source(1, "x".repeat(48001)), evidence.mergedPrDetails[1]] })).toBeUndefined();
  const writingBrief = parseWritingBrief(selection, evidence)!;
  const changed = { ...evidence, writingBrief, mergedPrDetails: evidence.mergedPrDetails.map(p => ({ ...p, body: p.body + " New condition." })) };
  expect(currentWritingBrief(changed)).toBeUndefined();
  expect(draftPrompt(candidate(changed), "x", "en", []).user).not.toContain("## Selected writing brief");
});

it("keeps legacy, introduction, custom, long-form and explicit editing contexts complete", () => {
  const c = candidate({ ...evidence, writingBrief: parseWritingBrief(selection, evidence) });
  const cases = [draftPrompt(candidate(), "threads", "en", []), draftPrompt(c, "threads", "en", [], undefined, { introduction: true }), draftPrompt(c, "x", "en", [], undefined, { instruction: "Compare all changes" }), draftPrompt(c, "x", "en", [], "Cover the refund change"), draftPrompt(c, "show_hn", "en", []), draftPrompt(c, "custom_news", "en", [])];
  for (const prompt of cases) {
    expect(prompt.user).toContain("UNRELATED_BODY_NOT_FOR_WRITING");
    expect(prompt.user).not.toContain("## Selected writing brief");
  }
});

it("does not treat the source snapshot metadata as numeric or factual grounding", () => {
  const prompt = digestPrompt(candidate());
  expect(prompt.user).toContain(sourceSnapshot(evidence));
  expect(digestGroundingFromPrompt(prompt.user)).not.toContain("PR source snapshot:");
});

it("keeps a zero-limit exclusion separate from the reader action at the end of the writing context", () => {
  const highlight = "Free accounts get 150 turns in the first 24 hours.";
  const quote = "운영자가 0으로 닫은 한도는 열지 않는다.";
  const ev = { repo: "a/tool", repoUrl: "https://github.com/a/tool", highlights: [highlight], mergedPrDetails: [source(1, `${highlight} ${quote}`)] };
  const brief = parseWritingBrief({ highlight, readerAction: "가입 후 24시간 동안 대화한다.", sourcePrNumbers: [1], requiredConditions: [{ sourcePrNumber: 1, quote }] }, ev)!;
  const prompt = draftPrompt(candidate({ ...ev, writingBrief: brief }), "threads", "ko", []);
  const anchor = prompt.user.split("## Selected writing brief")[1];
  expect(anchor).toContain(`Reader action: ${brief.readerAction}`);
  expect(anchor).toContain(`- PR #1: ${quote}`);
  expect(anchor).toContain("Keep the prerequisites and exclusions with the action");
});
