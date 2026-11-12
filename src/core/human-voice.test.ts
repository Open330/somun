import { describe, expect, it } from "vitest";
import { channelSpec } from "./channels.js";
import { lintDraft } from "./lint.js";
import { REPAIRABLE } from "../app/draft-repair.js";

const rule = (channel: string, body: string, name: string, facts: Parameters<typeof lintDraft>[4] = {}) =>
  lintDraft(channel as Parameters<typeof lintDraft>[0], undefined, body, [], facts).find((r) => r.rule === name);

describe("colon_opening", () => {
  it.each([
    "Tend: 에이전트 창을 한곳에서 봅니다.",
    "소개: 터미널 창을 묶어 줍니다.",
    ": 시작이 콜론입니다.",
    "repopulse 0.4.0: 터미널에서 봅니다.",
    "새 릴리스:\n본문",
  ])("flags %j", (body) => {
    expect(rule("x", `${body} https://tend.jiun.dev`, "colon_opening")?.ok).toBe(false);
  });

  it.each([
    "Tend는 에이전트 창을 한곳에서 보여 줍니다. 다음 회의는 10:30입니다.",
    "https://tend.jiun.dev 에서 받을 수 있습니다.",
    "에이전트가 기다리는 창을 놓치지 않게 Tend가 알려 줍니다. 이유는 간단합니다: 창이 많습니다.",
  ])("passes %j", (body) => {
    expect(rule("threads", body, "colon_opening")?.ok).toBe(true);
  });

  it("is a short-post rule, not a Show GN or blog rule", () => {
    expect(rule("show_gn", "무엇: Tend는 창을 묶습니다.", "colon_opening")).toBeUndefined();
    expect(rule("blog", "제목 후보: 하나", "colon_opening")).toBeUndefined();
  });
});

describe("feature_list", () => {
  it("flags two or more bullet lines in a short post", () => {
    const r = rule("threads", "Tend로 할 수 있는 것\n- 창 묶기\n- 대기 알림\n- 기록 검색", "feature_list");
    expect(r).toMatchObject({ ok: false, args: { count: "3" } });
    expect(rule("x", "• 하나\n• 둘 https://a.dev", "feature_list")?.ok).toBe(false);
  });

  it("passes prose, a single dash line and numbered steps", () => {
    expect(rule("x", "Tend는 기다리는 창을 알려 줍니다.\n- 설치는 brew 한 줄 https://a.dev", "feature_list")?.ok).toBe(true);
    expect(rule("linkedin", "1. 설치\n2. 실행\n\nhttps://a.dev", "feature_list")?.ok).toBe(true);
    expect(rule("show_gn", "## 무엇\n- 하나\n- 둘", "feature_list")).toBeUndefined();
  });
});

describe("self_promotion", () => {
  it.each(["지금 바로 써 보세요", "꼭 한번 써 보세요", "놓치지 마세요", "많은 관심 부탁드립니다", "Check it out", "give it a try", "a must-have for agents"])("flags %j", (phrase) => {
    expect(rule("show_hn", `Tend groups panes. ${phrase}.`, "self_promotion")?.ok).toBe(false);
  });

  it("passes plain statements of what the reader can do", () => {
    expect(rule("x", "Tend는 brew로 설치하고 tend start로 시작합니다. README에 설정 방법이 있습니다. https://a.dev", "self_promotion")?.ok).toBe(true);
    expect(rule("x", "Install with brew and run tend start. https://a.dev", "self_promotion")?.ok).toBe(true);
  });
});

describe("register_mixed", () => {
  it("flags formal and polite declaratives in one Korean post", () => {
    expect(rule("x", "Tend는 창을 묶습니다. 기다리는 창은 알려 줘요. https://a.dev", "register_mixed")).toMatchObject({ ok: false, args: { sample: expect.stringContaining("습니다") } });
    // 문장 부호 없는 줄 끝도 종결로 본다.
    expect(rule("x", "창을 묶습니다\n알림도 와요", "register_mixed")?.ok).toBe(false);
  });

  it("passes one register, questions, -세요 requests, quotes and noun endings", () => {
    expect(rule("x", "Tend는 창을 묶습니다. 기다리는 창을 알려 줍니다. https://a.dev", "register_mixed")?.ok).toBe(true);
    expect(rule("x", "Tend는 창을 묶어요. 알림도 와요. https://a.dev", "register_mixed")?.ok).toBe(true);
    expect(rule("threads", "Tend는 창을 묶습니다. 창이 몇 개쯤 되면 묶고 싶으신가요?", "register_mixed")?.ok).toBe(true);
    expect(rule("x", "README를 열어 보세요. 설치는 한 줄입니다. https://a.dev", "register_mixed")?.ok).toBe(true);
    expect(rule("x", "README에는 “바로 써요”라고 적혀 있습니다. https://a.dev", "register_mixed")?.ok).toBe(true);
    expect(rule("x", "설정이 필요. 기능은 중요합니다. https://a.dev", "register_mixed")?.ok).toBe(true);
  });

  it("leaves 해요체 channels to register_mismatch and respects an explicit register instruction", () => {
    const body = "Tend는 창을 묶습니다. 알림도 와요.";
    const spec = { ...channelSpec("threads"), identity: { tone: "해요체" } } as ReturnType<typeof channelSpec>;
    const results = lintDraft("threads", undefined, body, [], { language: "ko" }, "ko", spec);
    expect(results.find((r) => r.rule === "register_mismatch")?.ok).toBe(false);
    expect(results.find((r) => r.rule === "register_mixed")).toBeUndefined();
    expect(rule("threads", body, "register_mixed", { editorInstruction: "합니다체로 바꿔 줘" })).toBeUndefined();
  });

  it("skips English posts", () => {
    expect(rule("x", "Tend groups panes. It works. https://a.dev", "register_mixed")).toBeUndefined();
  });
});

describe("first_person_need_review", () => {
  it.each(["직접 써 보니 창을 덜 놓칩니다.", "물건을 팔다 보니 기록이 필요했습니다.", "써봤더니 편했습니다.", "I've been using Tend for a month.", "In my experience it saves time."])("flags %j", (sentence) => {
    const r = rule("x", `${sentence} https://a.dev`, "first_person_need_review", { sourceText: "Tend groups agent panes." });
    expect(r?.ok).toBe(false);
    expect(r?.detail).toContain("“");
  });

  it("passes experience stated in the sources or the author's why, and when the editor asks for it", () => {
    const sentence = "에이전트 창을 여러 개 띄우다 보니 기다리는 창을 놓쳤습니다.";
    expect(rule("x", `${sentence} https://a.dev`, "first_person_need_review", { sourceText: `README\n${sentence}` })?.ok).toBe(true);
    expect(rule("x", `${sentence} https://a.dev`, "first_person_need_review", { why: sentence })?.ok).toBe(true);
    expect(rule("x", `${sentence} https://a.dev`, "first_person_need_review", { editorInstruction: "내가 겪은 경험으로 시작해 줘" })).toBeUndefined();
  });

  it("passes neutral descriptions", () => {
    expect(rule("x", "Tend는 기다리는 에이전트 창을 알려 줍니다. https://a.dev", "first_person_need_review", { sourceText: "" })?.ok).toBe(true);
  });
});

it("catches all five issues of the hand-edited 2026-11-12 Threads launch post and passes its rewrite", () => {
  const before = "Tend: 에이전트 작업 공간을 한곳에\n\n직접 써 보니 창을 놓치는 일이 줄었습니다. 지금 바로 써 보세요.\n- 창 묶기\n- 대기 알림\n- 기록 검색\n\n설치도 쉬워요.";
  const after = "에이전트를 여러 창에 띄워 두면 어느 창이 내 답을 기다리는지 놓치기 쉽습니다. Tend는 tmux 창을 작업 단위로 묶고, 답을 기다리는 창을 알려 줍니다.\n\n설치는 brew 한 줄입니다.";
  // 기본 Threads는 해요체 채널이라 문체는 register_mismatch가 맡는다. 문체를 정하지 않은 X로 다섯 규칙을 함께 본다.
  const failing = (body: string) => lintDraft("x", undefined, body, [], { language: "ko", sourceText: "Tend groups tmux panes into work and shows which agent is waiting." }).filter((r) => !r.ok).map((r) => r.rule);
  expect(failing(before)).toEqual(expect.arrayContaining(["colon_opening", "feature_list", "self_promotion", "register_mixed", "first_person_need_review"]));
  for (const name of ["colon_opening", "feature_list", "self_promotion", "register_mixed", "first_person_need_review"]) expect(failing(after)).not.toContain(name);
});

it("lets automatic repair fix every human-voice rule", () => {
  for (const name of ["colon_opening", "feature_list", "self_promotion", "register_mixed", "first_person_need_review", "unreleased_feature"]) expect(REPAIRABLE.has(name)).toBe(true);
});
