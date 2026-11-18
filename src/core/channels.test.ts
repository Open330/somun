import { describe, expect, it } from "vitest";
import { DEFAULT_CHANNEL_LANGS, composeLink, channelSpec, draftChannelSpec } from "./channels.js";
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

describe("composeLink", () => {
  it("prefills X and Threads compose screens with the post, line breaks and links included", () => {
    const body = "Tend shows which agent waits.\nhttps://open330.github.io/tend/";
    expect(composeLink(channelSpec("x"), body)).toBe(`https://x.com/intent/post?text=${encodeURIComponent(body)}`);
    expect(decodeURIComponent(new URL(composeLink(channelSpec("x"), body)).searchParams.get("text")!)).toBe(body);
    expect(composeLink(channelSpec("threads"), "한 줄 소개")).toBe("https://www.threads.net/intent/post?text=%ED%95%9C%20%EC%A4%84%20%EC%86%8C%EA%B0%9C");
  });
  it("falls back to the empty composer elsewhere or without text", () => {
    expect(composeLink(channelSpec("linkedin"), "body")).toBe(channelSpec("linkedin").composeUrl);
    expect(composeLink(channelSpec("x"), "  ")).toBe("https://x.com/compose/post");
  });
});

describe("disquiet channel", () => {
  it("is a Korean titled channel with the link in the body and an editorial identity", () => {
    const spec = channelSpec("disquiet");
    expect(spec).toMatchObject({ id: "disquiet", fixedLang: "ko", hasTitle: true, linkPlacement: "body", composeUrl: "https://disquiet.io/" });
    expect(spec.identity?.audience).toContain("메이커");
    expect(spec.runbook.join(" ")).toContain("제품에 연결");
  });

  it("is not enabled by default, so no extra drafts are generated until a user turns it on", () => {
    expect(DEFAULT_CHANNEL_LANGS).not.toHaveProperty("disquiet");
  });

  it("puts the channel rules into the draft prompt without forcing an authorship claim", () => {
    const candidate = { title: "Tool", type: "release", evidence: { repo: "owner/tool", repoUrl: "https://github.com/owner/tool" } };
    const prompt = draftPrompt(candidate, "disquiet", "ko", []);
    expect(JSON.stringify(prompt)).toContain("never claim authorship");
    expect(JSON.stringify(prompt)).not.toContain("직접 만들었다는 한 문장");
  });
});

describe("disquiet lint", () => {
  const facts = { purpose: "introduction" as const, language: "ko", publicName: "Tool", repo: "o/tool", preferLink: "https://tool.example/" };
  const failed = (title: string, body: string) => lintDraft("disquiet", title, body, [], facts).filter((r) => !r.ok).map((r) => r.rule);

  it("rejects exclamation marks and vote requests", () => {
    const rules = failed("Tool에서 기록을 CSV로 저장하기", "Tool은 기록을 CSV로 저장합니다!\n\n추천 눌러 주세요.\n\nhttps://tool.example/");
    expect(rules).toEqual(expect.arrayContaining(["no_exclamation", "no_vote_request"]));
    expect(failed("Tool로 기록 저장하기", "Tool은 기록을 CSV로 저장합니다. 추천 버튼을 눌러 주세요.\n\nhttps://tool.example/")).toContain("no_vote_request");
    expect(failed("Tool로 기록 저장하기", "Tool은 기록을 CSV로 저장합니다. 추천 좀 눌러 주세요.\n\nhttps://tool.example/")).toContain("no_vote_request");
    // 제품 기능 이름인 '추천'을 누르라는 안내는 추천 요청이 아니다.
    expect(failed("Tool로 기록 저장하기", "Tool은 추천 탭을 눌러 비슷한 기록을 보여 줍니다.\n\nhttps://tool.example/")).not.toContain("no_vote_request");
    expect(failed("Tool로 기록 저장하기", "Tool의 추천 버튼을 눌러 비슷한 기록을 확인할 수 있습니다.\n\nhttps://tool.example/")).not.toContain("no_vote_request");
    for (const ask of ["추천 부탁드려요.", "추천 눌러 주세요.", "좋아요 부탁해요.", "투표 해 주세요.", "추천해 주세요."]) expect(failed("Tool로 기록 저장하기", `Tool은 기록을 저장합니다. ${ask}\n\nhttps://tool.example/`)).toContain("no_vote_request");
  });

  it("accepts the registered product page or the homepage as the link, and requires a link", () => {
    expect(failed("Tool로 기록 저장하기", "Tool은 기록을 CSV로 저장합니다.\n\nhttps://disquiet.io/@maker/products/tool")).not.toContain("preferred_link");
    expect(failed("Tool로 기록 저장하기", "Tool은 기록을 CSV로 저장합니다.\n\nhttps://tool.example/")).not.toContain("preferred_link");
    expect(failed("Tool로 기록 저장하기", "Tool은 기록을 CSV로 저장합니다.")).toContain("has_link");
    expect(failed("Tool로 기록 저장하기", "Tool은 기록을 CSV로 저장합니다.\n\nhttps://unrelated.example/?next=https://disquiet.io/@maker/products/tool")).toContain("preferred_link");
    expect(failed("Tool로 기록 저장하기", "Tool은 기록을 CSV로 저장합니다.\n\nhttps://disquiet.io/announcement")).toContain("preferred_link");
    expect(failed("Tool로 기록 저장하기", "Tool은 기록을 CSV로 저장합니다.\n\nhttps://disquiet.io/product/tool")).not.toContain("preferred_link");
    for (const other of ["https://disquiet.io/products/tool", "https://disquiet.io/@maker/product/tool", "https://disquiet.io/product/tool/comments"]) expect(failed("Tool로 기록 저장하기", `Tool은 기록을 CSV로 저장합니다.\n\n${other}`)).toContain("preferred_link");
    expect(failed("Tool로 기록 저장하기", "Tool은 기록을 CSV로 저장합니다.\n\nhttps://disquiet.io/@maker/products/tool/")).not.toContain("preferred_link");
    expect(failed("Tool로 기록 저장하기", "Tool은 기록을 CSV로 저장합니다.\n\nhttps://disquiet.io/product/unrelated")).toContain("preferred_link");
    // 홈페이지가 없어도 다른 제품 페이지 링크는 걸린다. 하이픈은 이름의 일부다.
    const bare = { purpose: "introduction" as const, language: "ko", publicName: "My-Tool", repo: "o/my-tool" };
    const bareFailed = (body: string) => lintDraft("disquiet", "제목", body, [], bare).filter((r) => !r.ok).map((r) => r.rule);
    expect(bareFailed("My-Tool은 기록을 저장합니다.\n\nhttps://disquiet.io/product/unrelated")).toContain("preferred_link");
    expect(bareFailed("My-Tool은 기록을 저장합니다.\n\nhttps://disquiet.io/product/mytool")).toContain("preferred_link");
    expect(bareFailed("My-Tool은 기록을 저장합니다.\n\nhttps://disquiet.io/product/my-tool")).not.toContain("preferred_link");
    expect(failed("Tool로 기록 저장하기", "Tool은 기록을 CSV로 저장합니다.\n\nhttps://tool.example/\nHTTPS://disquiet.io/product/unrelated")).toContain("preferred_link");
    expect(failed("Tool로 기록 저장하기", "Tool은 기록을 CSV로 저장합니다.\n\nHTTPS://disquiet.io/product/tool")).not.toEqual(expect.arrayContaining(["has_link"]));
    expect(failed("Tool로 기록 저장하기", "Tool은 기록을 CSV로 저장합니다.\n\nHTTPS://tool.example/")).not.toContain("preferred_link");
    expect(failed("Tool로 기록 저장하기", "Tool은 기록을 CSV로 저장합니다.\n\nhttps://tool.example/\nhttps://disquiet.io./product/unrelated")).toContain("preferred_link");
    expect(lintDraft("disquiet", "제목", "Tool은 기록을 저장합니다.\n\nhttps://?", [], { language: "ko", publicName: "Tool" }).find((r) => r.rule === "has_link")?.ok).toBe(false);
    expect(lintDraft("x", undefined, "Release notes [https://example.com]", [], {}).find((r) => r.rule === "has_link")?.ok).toBe(true);
    // 이름의 %가 다른 채널의 lint를 깨지 않는다.
    expect(() => lintDraft("x", undefined, "100% Tool은 기록을 저장합니다. https://tool.example/", [], { purpose: "introduction", publicName: "100% Tool", preferLink: "https://tool.example/" })).not.toThrow();
  });

  it("only claims authorship when the facts establish it", () => {
    expect(channelSpec("disquiet").rules).toContain("never claim authorship");
  });
});
