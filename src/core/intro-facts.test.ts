import { describe, expect, it } from "vitest";
import { framingText, missingPrerequisites, quoteInSource, unsupportedQuantities, verifyFacts } from "./intro-facts.js";

const source = "Description: Know which tmux coding agent is waiting on you.\n\nREADME:\n# Tend\nTend watches the Claude Code, Codex, and Gemini CLI sessions you already run in tmux, tells you the moment one stops for input, a choice, or an error, and takes you straight to its pane.<br />No wrapper, no new terminal.\n\nRequires tmux 3.x (or herdr) and a Unix-like OS.\n\n## Companion\nA [separate dashboard](https://x) shows stats.";

describe("quote verification", () => {
  it("accepts verbatim quotes across HTML and Markdown formatting, rejects invented ones", () => {
    expect(quoteInSource("takes you straight to its pane. No wrapper, no new terminal.", source)).toBe(true);
    expect(quoteInSource("A separate dashboard shows stats", source)).toBe(true);
    expect(quoteInSource("Tend works with every terminal", source)).toBe(false);
    expect(quoteInSource("short", source)).toBe(false);
  });

  it("keeps only fields whose quotes are in the source, and prerequisites from the product's own framing", () => {
    const facts = verifyFacts({
      audience: { text: "people running agents", quote: "Know which tmux coding agent is waiting on you" },
      prerequisites: [{ term: "tmux", quote: "sessions you already run in tmux" }, { term: "Apple Silicon", quote: "Requires tmux 3.x (or herdr) and a Unix-like OS" }, { term: "dashboard", quote: "A separate dashboard shows stats" }],
      problem: { text: "x", quote: "invented problem sentence" },
      actions: [{ text: "watches sessions", quote: "tells you the moment one stops for input, a choice, or an error" }, { text: "bad", quote: "it also bakes bread" }],
      difference: { text: "no wrapper", quote: "No wrapper, no new terminal." },
    }, source, framingText({ description: "Know which tmux coding agent is waiting on you.", readme: "# Tend\nTend watches the Claude Code sessions you already run in tmux" }));
    expect(facts.audience?.quote).toContain("tmux coding agent");
    expect(facts.prerequisites.map((p) => p.term)).toEqual(["tmux"]);
    expect(facts.problem).toBeUndefined();
    expect(facts.actions).toHaveLength(1);
    expect(facts.difference?.text).toBe("no wrapper");
  });
});

describe("deterministic candidate checks", () => {
  it("reports prerequisites missing from the post, accepting common Korean platform words", () => {
    const facts = { prerequisites: [{ term: "tmux", quote: "" }, { term: "menu bar", quote: "" }] };
    expect(missingPrerequisites("Tend tells you which agent waits.", facts, "en")).toEqual(["tmux", "menu bar"]);
    expect(missingPrerequisites("Tend는 tmux의 에이전트와 메뉴바를 봅니다.", facts, "ko")).toEqual([]);
  });

  it("flags quantities, superlatives and vague marketing phrases not in the sources", () => {
    expect(unsupportedQuantities("Tend watches dozens of agents and turns them into actionable insights.", source)).toEqual(["dozens", "actionable insights"]);
    expect(unsupportedQuantities("Tend는 가장 오래 기다린 창으로 데려다줍니다.", source)).toEqual([]);
    expect(unsupportedQuantities("가장 빠른 도구입니다.", source)).toEqual(["가장 빠른"]);
  });

});


describe("Korean subject and action", () => {
  it("flags a product doing the reader's or another agent's action, allows causative phrasing", async () => {
    const { koSubjectMismatch } = await import("./human-voice.js");
    expect(koSubjectMismatch(["Haejo는 Mac에서 Claude와 Codex가 앱을 열고 결과를 확인합니다."], "Haejo")).toHaveLength(1);
    expect(koSubjectMismatch(["aas는 여러 계정을 번갈아 가며 쓸 수 있습니다."], "aas")).toHaveLength(1);
    expect(koSubjectMismatch(["BarShelf는 정보를 아이콘 하나 뒤에 모읍니다.", "메뉴바 앱이 없던 도구도 같은 자리에서 봅니다."], "BarShelf")).toHaveLength(1);
    expect(koSubjectMismatch(["Haejo는 Claude와 Codex가 Mac 앱을 대신 쓰게 해 줍니다."], "Haejo")).toEqual([]);
    expect(koSubjectMismatch(["Tend는 기다리는 에이전트를 알려 줍니다."], "Tend")).toEqual([]);
  });
});
