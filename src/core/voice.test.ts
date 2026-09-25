import { describe, expect, it } from "vitest";
import { lintDraft } from "./lint.js";
import { VOICE_PRESETS, voiceGuideFor } from "./voice.js";

describe("voice presets", () => {
  it("have unique ids", () => {
    expect(new Set(VOICE_PRESETS.map((p) => p.id)).size).toBe(VOICE_PRESETS.length);
  });
  // 샘플은 "이 문체로 쓰면 이렇게 나온다"는 약속이라 린트를 통과해야 한다. 친근한 문체는 X용이므로 X 길이까지 맞춘다.
  it.each(VOICE_PRESETS.flatMap((p) => (["ko", "en"] as const).map((lang) => [p.id, lang] as const)))("%s sample (%s) passes lint", (id, lang) => {
    const body = VOICE_PRESETS.find((p) => p.id === id)!.sample[lang];
    for (const channel of id === "friendly" ? (["threads", "x"] as const) : (["threads"] as const)) {
      const failed = lintDraft(channel, undefined, body).filter((r) => !r.ok);
      expect(failed, `${channel}: ${JSON.stringify(failed)}`).toEqual([]);
    }
  });
  it("uses the friendly guide for the friendly preset", () => {
    expect(voiceGuideFor({ preset: "friendly" }, "ko")).toContain("해요체");
    expect(voiceGuideFor({ preset: "friendly" }, "en")).toMatch(/conversational/);
  });
});
