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

describe("review regressions (Codex on #93)", () => {
  const failing = (body: string, facts: Parameters<typeof lintDraft>[4] = {}) => lintDraft("x", undefined, body, [], { sourceText: "", ...facts }).filter((r) => !r.ok).map((r) => r.rule);
  it("does not treat a reader capability as the author's experience", () => {
    expect(failing("Tend에서 사용자가 직접 사용할 도구를 고릅니다. https://a.dev")).not.toContain("first_person_need_review");
    expect(failing("서버를 직접 운영할 수 있습니다. https://a.dev")).not.toContain("first_person_need_review");
  });
  it("keeps checking experience when the editor forbids it", () => {
    expect(failing("I have been using Tend for a year. https://a.dev", { editorInstruction: "Do not invent personal experience." })).toContain("first_person_need_review");
    expect(failing("직접 써 보니 편했습니다. https://a.dev", { editorInstruction: "개인 경험은 넣지 마세요" })).toContain("first_person_need_review");
  });
  it("ignores ASCII single-quoted Korean quotations, but not English contractions", () => {
    expect(failing("확인했습니다. README에는 '바로 써요.'라고 적혀 있습니다. https://a.dev")).not.toContain("register_mixed");
  });
  it("does not read past a finished sentence for a colon heading", () => {
    expect(failing("It works. Example: open a file. https://a.dev")).not.toContain("colon_opening");
    expect(failing("v1.2.3: Fixes offline mode. https://a.dev")).toContain("colon_opening");
  });
  it("does not count common nouns ending in 요 as polite endings", () => {
    expect(failing("설정 파일을 읽습니다. 지원 장르: 가요. https://a.dev")).not.toContain("register_mixed");
  });
});

describe("wrong_language", () => {
  const rule = (body: string, language: string) => lintDraft("x", undefined, body, [], { language }).find((r) => r.rule === "wrong_language");
  it("flags Korean sentences in an English draft (the 2026-11-12 Tend run)", () => {
    const r = rule("tmux에서 Claude Code나 Codex 같은 코딩 에이전트를 실행할 때 상태를 한눈에 파악할 수 있습니다. https://open330.github.io/tend/", "en");
    expect(r).toMatchObject({ ok: false, args: { language: "en" } });
    expect(REPAIRABLE.has("wrong_language")).toBe(true);
  });
  it("passes English, quoted or code Korean, and Korean drafts", () => {
    expect(rule("Tend shows which agent waits. Run `tend --lang ko` for the Korean UI (`한국어 화면`). https://a.dev", "en")?.ok).toBe(true);
    expect(rule("The Korean UI says “에이전트가 기다립니다”. https://a.dev", "en")?.ok).toBe(true);
    expect(rule("Tend는 기다리는 창을 알려 줍니다. https://a.dev", "ko")).toBeUndefined();
  });
});

describe("review regressions (Codex on #94)", () => {
  it("does not flag single-quoted Korean UI text in an English draft", () => {
    for (const body of ["The Korean UI says ‘에이전트가 기다립니다’. https://a.dev", "The Korean UI says '에이전트가 기다립니다'. https://a.dev"]) {
      expect(lintDraft("x", undefined, body, [], { language: "en" }).find((r) => r.rule === "wrong_language")?.ok).toBe(true);
    }
  });
});

describe("publishable first introductions (2026-11-12 five-project baseline)", () => {
  const fails = (body: string, lang: string, name: string, repo: string) =>
    lintDraft("x", undefined, body, [], { language: lang, purpose: "introduction", publicName: name, repo }).filter((r) => !r.ok).map((r) => r.rule);
  it("flags each pattern a person removed from the generated drafts", () => {
    expect(fails("여러 코딩 에이전트 계정을 전환하는 CLI 도구 aas를 사용해 보세요. aas switch로 계정을 바꾸거나 aas usage로 사용량을 확인할 수 있습니다. https://github.com/Open330/aas", "ko", "aas", "Open330/aas"))
      .toEqual(expect.arrayContaining(["introduction_invitation", "name_predicate", "command_list"]));
    expect(fails("macOS 14 이상과 Apple Silicon 환경에서 무료로 사용할 수 있습니다. https://barshelf.jiun.dev", "ko", "BarShelf", "Open330/barshelf")).toContain("introduction_requirements");
    expect(fails("반복되는 앱 작업을 자동화하려는 분을 위해, Haejo가 화면을 읽고 클릭합니다. https://open330.github.io/haejo/", "ko", "Haejo", "Open330/haejo")).toContain("dangling_opener");
    expect(fails("대기 중인 세션을 파악하는 tend입니다. https://open330.github.io/tend", "ko", "tend", "Open330/tend")).toContain("name_predicate");
    expect(fails("When managing multiple coding agent sessions in tmux, use tend to see which agent is waiting. Requires tmux 3.x or herdr and a Unix-like OS. https://github.com/Open330/tend", "en", "tend", "Open330/tend"))
      .toEqual(expect.arrayContaining(["dangling_opener", "introduction_invitation", "introduction_requirements"]));
  });
  it("passes the human-edited Tend introductions and plain statements (false-positive guards)", () => {
    expect(fails("tmux에 Claude Code, Codex, Gemini CLI를 여러 개 띄워 두면 어느 창이 내 답을 기다리는지 놓치기 쉽습니다. Tend는 이미 쓰고 있는 세션을 그대로 지켜보다가 입력·선택·오류로 멈춘 창을 알려 주고, tend attend로 가장 오래 기다린 창에 바로 데려다줍니다.\nhttps://open330.github.io/tend/", "ko", "Tend", "Open330/tend")).toEqual([]);
    expect(fails("Running several Claude Code, Codex or Gemini CLI sessions in tmux? Tend watches the ones you already have, tells you when one stops for input, a choice or an error, and `tend attend` jumps to the pane that has waited longest. No wrapper, no new terminal.\nhttps://open330.github.io/tend/", "en", "Tend", "Open330/tend")).toEqual([]);
    // 제품 이름이 문장 주어인 "Tend watches"는 명령이 아니다. 대문자 제품명과 소문자 CLI가 같아도 마찬가지다.
    expect(fails("Tend watches agents and Tend attends to nothing. https://a.dev", "en", "Tend", "Open330/tend")).not.toContain("command_list");
    // 사용하는 사람이 주어인 서술은 권유가 아니다. 질문으로 여는 것은 허용한다.
    expect(fails("Haejo는 앱을 열고 클릭한 뒤 결과를 확인합니다. https://a.dev", "ko", "Haejo", "Open330/haejo")).toEqual([]);
    expect(fails("Need Claude to use your Mac apps? Haejo opens apps, clicks and checks results. https://a.dev", "en", "Haejo", "Open330/haejo")).toEqual([]);
    // 업데이트 글에는 소개 전용 규칙(요구 사항·권유)을 걸지 않는다.
    expect(lintDraft("x", undefined, "v2 requires Node 22. https://a.dev", [], { language: "en", purpose: "update", publicName: "Tool", repo: "o/tool" }).find((r) => r.rule === "introduction_requirements")).toBeUndefined();
  });
});

it("flags Korean sentence fragments and transliterated Claude (round 3)", () => {
  const rules = (body: string) => lintDraft("x", undefined, body, [], { language: "ko", purpose: "introduction", publicName: "Oh My Prompt", repo: "jiunbae/oh-my-prompt" }).filter((r) => !r.ok).map((r) => r.rule);
  expect(rules("AI 코딩 에이전트와 상호작용할 때. Oh My Prompt는 대화를 기록합니다. https://a.dev")).toContain("sentence_fragment");
  expect(rules("클로드가 앱을 조작합니다. https://a.dev")).toContain("no_transliterated_names");
  expect(rules("Oh My Prompt는 에이전트와 나눈 대화를 기록하고 통계를 보여 줍니다. https://a.dev")).toEqual([]);
});
