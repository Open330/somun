import { describe, expect, it } from "vitest";
import { lintDraft } from "./lint.js";
import { VOICE_PRESETS, voiceGuideFor } from "./voice.js";
import { channelSpec } from "./channels.js";

describe("voice presets", () => {
  it("have unique ids", () => {
    expect(new Set(VOICE_PRESETS.map((p) => p.id)).size).toBe(VOICE_PRESETS.length);
  });
  // 샘플은 "이 문체로 쓰면 이렇게 나온다"는 약속이라 린트를 통과해야 한다. 친근한 문체는 X용이므로 X 길이까지 맞춘다.
  it.each(VOICE_PRESETS.flatMap((p) => (["ko", "en"] as const).map((lang) => [p.id, lang] as const)))("%s sample (%s) passes lint", (id, lang) => {
    const body = VOICE_PRESETS.find((p) => p.id === id)!.sample[lang];
    for (const channel of id === "friendly" ? (["threads", "x"] as const) : (["threads"] as const)) {
      // Threads에서는 공통 문체 샘플의 URL을 첫 답글로 옮긴 본문을 검사한다.
      const adapted = channel === "threads" ? body.replace(/https?:\/\/\S+/g, "").trim() : body;
      // 문체 샘플은 여러 채널의 글이지 Threads용 완성 초안이 아니다. 형식·금지어는 검사하되 문장 수를 강제하지 않는다.
      const failed = lintDraft(channel, undefined, adapted, undefined, undefined, undefined, { ...channelSpec(channel), maxSentences: undefined }).filter((r) => !r.ok);
      expect(failed, `${channel}: ${JSON.stringify(failed)}`).toEqual([]);
    }
  });
  it("uses the friendly guide for the friendly preset", () => {
    expect(voiceGuideFor({ preset: "friendly" }, "ko")).toContain("해요체");
    expect(voiceGuideFor({ preset: "friendly" }, "en")).toMatch(/conversational/);
  });
});

it("applies channel-tagged guide lines only to their channel", () => {
  const voice = { preset: "plain", guide: "Lead with the change.\n[X] Two short sentences.\n[LinkedIn] Three paragraphs." };
  const x = voiceGuideFor(voice, "en", "x");
  expect(x).toContain("Lead with the change.");
  expect(x).toContain("[X] Two short sentences.");
  expect(x).not.toContain("Three paragraphs");
  // 채널이 없는 글(영상)에는 채널 전용 줄을 넣지 않는다.
  expect(voiceGuideFor(voice, "en")).not.toContain("[LinkedIn]");
  expect(voiceGuideFor(voice, "en")).toContain("Lead with the change.");
});

it("lets the channel supply tone until the author chooses a general voice, preserving scoped author guidance", () => {
  const voice = { preset: "plain", guide: "Use exact feature names.\n[Threads] Ask about the workflow.\n[X] One short announcement." };
  const threadGuide = voiceGuideFor(voice, "ko", "threads");
  expect(threadGuide).not.toContain("합니다체");
  expect(threadGuide).toContain("Use exact feature names.");
  expect(threadGuide).toContain("Ask about the workflow.");
  expect(threadGuide).not.toContain("One short announcement.");
  expect(voiceGuideFor({ ...voice, chosenAt: 1 }, "ko", "threads")).toContain("구체적인 동사");
  expect(voiceGuideFor({ ...voice, chosenAt: 1 }, "ko", "threads")).not.toContain("합니다체로 씁니다");
  expect(voiceGuideFor({ preset: "plain", guide: "" }, "ko")).toContain("합니다체");
  expect(voiceGuideFor({ preset: "question", guide: "" }, "ko", "threads")).toContain("구체적인 질문");
});

it("adapts the announcement preset to a short channel without changing explicit author guidance or unscoped writing", () => {
  const voice = { preset: "announce", chosenAt: 1, guide: "[Threads] Ask about manuscript structure.\n[X] Keep the supplied threshold." };
  const thread = voiceGuideFor(voice, "en", "threads");
  expect(thread).not.toContain("Then one sentence of 'now works'");
  expect(thread).toContain("selected channel's register and sentence budget");
  expect(thread).toContain("Ask about manuscript structure.");
  expect(thread).not.toContain("Keep the supplied threshold.");
  expect(voiceGuideFor(voice, "en", "x")).toContain("Keep the supplied threshold.");
  expect(voiceGuideFor(voice, "en")).toContain("Then one sentence of 'now works'");
  expect(voice.preset).toBe("announce");
});
