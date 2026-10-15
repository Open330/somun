import { describe, expect, it } from "vitest";
import { briefSources, briefSourceHash, resolveBrief as resolve, sourceBriefPrompt } from "./source-brief.js";

const candidate = { title: "update", type: "in-progress", evidence: { repo: "a/b", repoUrl: "https://example.com", releaseNotes: "Non-PR release evidence", highlights: ["generated claim"], mergedPrDetails: [{ number: 9, title: "original", url: "https://example.com/9", body: "Threshold **50%** of requested items.\n\nLast attempt only; first requires all." }] } };
const resolveBrief = (sources: ReturnType<typeof briefSources>, input: unknown) => resolve(sources, input, briefSourceHash(sources));
const select = { uncertain: false, reason: "related source", selected: [{ source: "pr-9", paragraphs: [1, 2] }] };
describe("extractive source brief", () => {
  it("resolves exact original paragraphs without generated summaries or quote reconstruction", () => {
    const sources = briefSources(candidate);
    expect(resolveBrief(sources, select).excerpts).toContain("Threshold **50%** of requested items.");
    expect(resolveBrief(sources, select).excerpts).toContain("Last attempt only; first requires all.");
    const prompt = sourceBriefPrompt(candidate, sources);
    expect(prompt.user).not.toContain("generated claim");
    expect(prompt.user).toContain("Non-PR release evidence");
  });
  it.each([0, -1, 1.5, 3])("rejects nonexistent or non-integral reference %s", (n) => {
    expect(() => resolveBrief(briefSources(candidate), { ...select, selected: [{ source: "pr-9", paragraphs: [n] }] })).toThrow();
  });
  it("holds uncertain, missing, truncated and duplicate references", () => {
    const sources = briefSources(candidate);
    expect(() => resolveBrief(sources, { ...select, uncertain: true })).toThrow("uncertain");
    expect(() => resolveBrief(sources, { ...select, selected: [{ source: "missing", paragraphs: [1] }] })).toThrow("missing");
    expect(() => resolveBrief(sources.map((s) => ({ ...s, truncated: true })), select)).toThrow("truncated");
    expect(() => resolveBrief(sources, { ...select, selected: [select.selected[0], select.selected[0]] })).toThrow("invalid paragraph");
  });
});

it("rejects source snapshot changes and never certifies semantic correctness", () => {
  const sources = briefSources(candidate);
  expect(resolveBrief(sources, select).semanticReviewRequired).toBe(true);
  expect(() => resolve(sources, select, briefSourceHash([]))).toThrow("snapshot changed");
  expect(() => resolveBrief(sources, { ...select, selected: [] })).toThrow("uncertain");
});

it("rejects ambiguous source IDs even when the frozen snapshot hash matches", () => {
  const sources = briefSources(candidate);
  const ambiguous = [...sources, { ...sources[0], paragraphs: ["different original"] }];
  expect(() => resolveBrief(ambiguous, select)).toThrow("duplicate source ID");
});
