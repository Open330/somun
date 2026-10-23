import { describe, expect, it } from "vitest";
import { channelSpec, draftChannelSpec } from "./channels.js";
import { lintDraft } from "./lint.js";
import { draftPrompt } from "./prompts.js";

describe("introduction sentence budgets", () => {
  const candidate = { title: "Tool", type: "release", evidence: { repo: "owner/tool", repoUrl: "https://github.com/owner/tool" } };

  it("keeps the default X introduction bounded by weighted length without an added sentence cap", () => {
    const spec = draftChannelSpec(channelSpec("x"), "introduction");
    expect(spec.maxSentences).toBeUndefined();
    const checks = lintDraft("x", "", "One. Two. Three. Four. Five. Six.", [], { purpose: "introduction" });
    expect(checks.some(check => check.rule === "sentence_count")).toBe(false);
    expect(checks.find(check => check.rule === "length")?.ok).toBe(true);
    expect(lintDraft("x", "", "가".repeat(141), [], { purpose: "introduction" }).find(check => check.rule === "length")?.ok).toBe(false);
    const prompt = draftPrompt(candidate, "x", "ko", [], undefined, { introduction: true });
    expect(prompt.user).not.toContain("Maximum 4 sentences");
    expect(prompt.user).toContain("280 X weighted characters");
  });

  it.each([1, 2, 4, 8])("preserves an explicitly configured X limit of %s", maxSentences => {
    const configured = { ...channelSpec("x"), maxSentences };
    expect(draftChannelSpec(configured, "introduction").maxSentences).toBe(maxSentences);
    const prompt = draftPrompt(candidate, "x", "en", [], undefined, { introduction: true, channelSpec: configured });
    expect(prompt.user).toContain(`Maximum ${maxSentences} sentences`);
    const tooMany = Array.from({ length: maxSentences + 1 }, (_, i) => `Item ${i}.`).join(" ");
    expect(lintDraft("x", "", tooMany, [], { purpose: "introduction" }, "en", configured).find(check => check.rule === "sentence_count")?.ok).toBe(false);
  });

  it("preserves Threads introduction and update limits and all other channels", () => {
    expect(draftChannelSpec(channelSpec("threads"), "introduction").maxSentences).toBe(6);
    expect(draftChannelSpec(channelSpec("threads"), "update").maxSentences).toBe(2);
    expect(draftChannelSpec({ ...channelSpec("threads"), maxSentences: 1 }, "introduction").maxSentences).toBe(1);
    const update = channelSpec("x");
    expect(draftChannelSpec(update, "update")).toBe(update);
    const custom = { ...channelSpec("x"), id: "custom_test" as const, maxSentences: 2 };
    expect(draftChannelSpec(custom, "introduction")).toBe(custom);
  });
});
