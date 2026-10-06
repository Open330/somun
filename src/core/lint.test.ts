import { describe, expect, it } from "vitest";
import { crossLangNumberDiff, draftLintFacts, lintDraft, lintPassed, numberTokens, unsupportedNumbers } from "./lint.js";
import { clusterKeyFor, crossedThreshold } from "./cluster.js";

describe("lintDraft", () => {
  it("passes a plain three-line X post with a number, a limit, and a link", () => {
    const body = "I kept finding my agents stuck 30 minutes after they asked.\n\nmuxa shows which one is waiting.\n\n61 releases, no Windows yet. https://github.com/Open330/muxa";
    expect(lintPassed(lintDraft("x", undefined, body))).toBe(true);
  });
  it("fails on banned phrases and exclamation", () => {
    const r = lintDraft("x", undefined, "Excited to announce muxa! 61 releases https://x.y");
    expect(r.find((x) => x.rule === "banned_phrases")?.ok).toBe(false);
    expect(r.find((x) => x.rule === "no_exclamation")?.ok).toBe(false);
  });
  it("rejects vote requests on show_hn", () => {
    const r = lintDraft("show_hn", "Show HN: Muxa – see agents", "please upvote. 3 limits. beta");
    expect(r.find((x) => x.rule === "no_vote_request")?.ok).toBe(false);
  });
});

describe("cluster", () => {
  it("maps a release to release key", () => {
    const k = clusterKeyFor({ kind: "release", repo: "o/r", ref: "v1", occurredAt: 0, payload: { tag: "v1.0.0" } }, {});
    expect(k?.key).toBe("release:o/r@v1.0.0");
  });
  it("ignores PRs covered by a recent release", () => {
    const k = clusterKeyFor({ kind: "pr_merged", repo: "o/r", ref: "1", occurredAt: 10, payload: {} }, { latestReleaseAt: 5, recentPrCount: 5 });
    expect(k).toBeNull();
  });
  it("detects crossed thresholds", () => {
    expect(crossedThreshold(20, 60, [10, 25, 50, 100])).toBe(50);
    expect(crossedThreshold(60, 70, [10, 25, 50, 100])).toBeNull();
  });
});

describe("lintDraft facts checks", () => {
  it("flags a distorted repo name", () => {
    const r = lintDraft("x", undefined, "ja/settings 엔진은 맥 전용 항목을 지정합니다. 릴리스 100회. https://github.com/jiunbae/settings", undefined, { repo: "jiunbae/settings", limitations: [] });
    expect(r.find((x) => x.rule === "repo_name")?.ok).toBe(false);
  });
  it("accepts the exact repo name and paths", () => {
    const r = lintDraft("x", undefined, "jiunbae/settings에 scripts/sync.sh를 추가했습니다. 릴리스 100회. https://github.com/jiunbae/settings", undefined, { repo: "jiunbae/settings", limitations: [] });
    expect(r.find((x) => x.rule === "repo_name")?.ok).toBe(true);
  });
  it("flags an invented limitation when facts have none", () => {
    const r = lintDraft("x", undefined, "설정 동기화를 고쳤습니다. 릴리스 100회. 아직 v2026.09.21.2, API가 바뀔 수 있습니다. https://github.com/jiunbae/settings", undefined, { repo: "jiunbae/settings", limitations: [] });
    expect(r.find((x) => x.rule === "no_invented_limit")?.ok).toBe(false);
  });
});

describe("cross-language numbers", () => {
  it("extracts version, count, percent, thousands", () => {
    expect(numberTokens("v0.8.47 · 61 releases · 40% faster · 4,102 rows · still 0.x")).toEqual(["v0.8.47", "61", "40%", "4102", "0.x"]);
  });
  it("flags a number present in one language only", () => {
    const r = crossLangNumberDiff([
      { channel: "x", lang: "en", version: 1, status: "proposed", body: "61 releases, still 0.x https://g.com/a" },
      { channel: "x", lang: "ko", version: 2, status: "proposed", body: "릴리스 61회. https://g.com/a" },
      { channel: "x", lang: "ko", version: 1, status: "dropped", body: "릴리스 100회" },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].onlyIn).toEqual([{ lang: "en", numbers: ["0.x"] }]);
  });
});

describe("placeholder diagnostics", () => {
  it("does not report missing numbers on a passing rule", () => {
    const rule = lintDraft("threads", undefined, "CRLF 위치 계산을 고쳤습니다.").find((r) => r.rule === "no_placeholder");
    expect(rule).toEqual({ rule: "no_placeholder", ok: true, detail: undefined });
  });
  it("still flags unresolved number placeholders", () => {
    expect(lintDraft("threads", undefined, "[숫자 확인]만큼 빨라졌습니다.").find((r) => r.rule === "no_placeholder")?.ok).toBe(false);
  });
});

describe("evidence-aware review", () => {
  it.each(["x", "threads", "linkedin", "show_hn", "show_gn", "blog"] as const)("does not require fabricated numbers or limitations for %s", (channel) => {
    const results = lintDraft(channel, "Show HN: Tool", "Fixes line endings. https://github.com/test/tool", undefined, { limitations: [], sourceText: "Fixes line endings." });
    expect(results.some((r) => ["has_number", "has_limitation", "has_number_or_limit"].includes(r.rule))).toBe(false);
    expect(results.find((r) => r.rule === "numbers_need_review")?.ok).toBe(true);
  });
  it("flags unsupported measurements while ignoring link IDs and numbered lists", () => {
    const results = lintDraft("x", undefined, "2. Handles line endings 40% faster. https://github.com/test/tool/pull/999", undefined, { sourceText: "Handles line endings." });
    expect(results.find((r) => r.rule === "numbers_need_review")).toMatchObject({ ok: false, detail: expect.stringContaining("40%") });
    expect(results.find((r) => r.rule === "numbers_need_review")?.detail).not.toContain("999");
  });
  it("accepts supplied versions and counts but does not treat counts as percentages", () => {
    const facts = { sourceText: "version: v2.3.0; downloads: 4,102; stars: 40" };
    expect(lintDraft("threads", undefined, "2.3.0 has 4102 downloads", undefined, facts).find((r) => r.rule === "numbers_need_review")?.ok).toBe(true);
    expect(lintDraft("threads", undefined, "40% faster", undefined, facts).find((r) => r.rule === "numbers_need_review")?.ok).toBe(false);
  });
});

it("uses project profile evidence during numeric and limitation review", () => {
  const facts = draftLintFacts({ title: "Tool", type: "release", evidence: { repo: "test/tool", repoUrl: "https://github.com/test/tool", stars: 8 } }, { what: "Tool", audience: "developers", claims: ["Handles 64 tasks"], stage: "beta", limitations: ["API may change"], naming: "Tool", avoid: [] });
  expect(facts.sourceText).not.toContain("forks: 0");
  const checks = lintDraft("threads", undefined, "Handles 64 tasks; API may change", undefined, facts);
  expect(checks.find((r) => r.rule === "numbers_need_review")?.ok).toBe(true);
  expect(checks.find((r) => r.rule === "no_invented_limit")?.ok).not.toBe(false);
});

describe("grounded numbers", () => {
  it("treats multipliers as claims that need the same multiplier in the source", () => {
    expect(numberTokens("3x faster, 세 배 빨라짐, twice as small")).toEqual(expect.arrayContaining(["3x", "2x"]));
    expect(numberTokens("3x faster")).not.toContain("3");
    expect(unsupportedNumbers("now 3x faster", "cold start went from 900ms to 300ms")).toEqual(["3x"]);
    expect(unsupportedNumbers("두 배 빨라졌습니다", "Build is 2x faster than 1.4")).toEqual([]);
  });

  it("matches percent spelled out in the source", () => {
    expect(unsupportedNumbers("40% smaller", "bundle is 40 percent smaller")).toEqual([]);
  });

  it("checks drafts against the raw material, not the model-written digest", () => {
    const evidence = { repo: "a/b", repoUrl: "https://github.com/a/b", releaseNotes: "Cold start is now 120ms.", highlights: ["Cold start dropped by 75%."] };
    const facts = draftLintFacts({ title: "b", type: "release", evidence });
    expect(facts.sourceText).not.toContain("75%");
    expect(lintDraft("threads", undefined, "Cold start is 120ms, 75% faster", undefined, facts).find((r) => r.rule === "numbers_need_review")?.detail).toContain("75%");
  });
});

describe("multiplier false positives", () => {
  it.each([
    ["1.4 배포했습니다", ["1.4"]],
    ["v1.2 배포", ["v1.2"]],
    ["Supports 3 X-ray formats", ["3"]],
    ["twice-weekly releases", []],
    ["1920x1080 screenshots", []],
    ["0x1F flag", []],
    ["스물두 배포", []],
    ["배치 크기 32", ["32"]],
  ])("%s", (text, expected) => {
    expect(numberTokens(text).filter((t) => t.endsWith("x"))).toEqual([]);
    for (const e of expected) expect(numberTokens(text)).toContain(e);
  });

  it("still catches real multipliers", () => {
    expect(numberTokens("3배 빨라졌고 3x smaller, 2× less memory")).toEqual(expect.arrayContaining(["3x", "2x"]));
    expect(numberTokens("3배 빨라졌고")).not.toContain("3");
    expect(numberTokens("속도가 두 배가 됐다")).toContain("2x");
  });
});

it("compares numbers with attached units the same as spaced ones", () => {
  expect(unsupportedNumbers("Cold start went from 800 ms to 200 ms.", "Cold start 800ms → 200ms")).toEqual([]);
  expect(unsupportedNumbers("Now 150ms", "Cold start 800ms → 200ms")).toEqual(["150"]);
  expect(unsupportedNumbers("3x faster", "3x faster builds")).toEqual([]);
});

it("asks LinkedIn posts to come in paragraphs", () => {
  const wall = lintDraft("linkedin", undefined, "One long block https://somun.jiun.dev");
  expect(wall.find((r) => r.rule === "paragraphs")?.ok).toBe(false);
  const split = lintDraft("linkedin", undefined, "Hook.\n\nWhat it is.\n\nHow it works.\n\nhttps://somun.jiun.dev");
  expect(split.find((r) => r.rule === "paragraphs")?.ok).toBe(true);
});

describe("dogfooding guardrails", () => {
  const rule = (r: ReturnType<typeof lintDraft>, name: string) => r.find((x) => x.rule === name);

  it("flags words the profile says to avoid", () => {
    const r = lintDraft("x", undefined, "somun is marketing automation for developers. https://somun.jiun.dev", [], { avoid: ["Marketing automation", "SQLite"] });
    expect(rule(r, "avoid_terms")).toMatchObject({ ok: false, detail: expect.stringContaining("Marketing automation") });
    expect(rule(lintDraft("x", undefined, "somun drafts posts. https://somun.jiun.dev", [], { avoid: ["SQLite"] }), "avoid_terms")?.ok).toBe(true);
  });

  it("flags product and channel names transliterated into Hangul, with particles, but not longer words", () => {
    const body = "엑스와 스레드, 링크드인, 쇼 핸과 긱뉴스 같은 채널에 씁니다. 제미나이 에이피아이 키가 필요합니다. 깃허브에서 읽습니다.";
    const r = rule(lintDraft("linkedin", undefined, body), "no_transliterated_names");
    expect(r?.ok).toBe(false);
    for (const name of ["X", "LinkedIn", "Show HN", "GeekNews", "Gemini", "API", "GitHub"]) expect(r?.detail).toContain(`→ ${name}`);
    expect(rule(lintDraft("linkedin", undefined, "엑스포에 다녀왔습니다. X와 LinkedIn, GitHub에 씁니다."), "no_transliterated_names")?.ok).toBe(true);
    expect(rule(lintDraft("x", undefined, "English only post https://a.b"), "no_transliterated_names")).toBeUndefined();
  });

  it("requires the Show GN what section, and limitations only when the evidence has some", () => {
    const flat = "somun을 소개합니다. 릴리스와 커밋을 읽어 초안을 씁니다.";
    expect(rule(lintDraft("show_gn", "Show GN: somun", flat, [], { limitations: [] }), "sections")).toMatchObject({ ok: false, detail: expect.stringContaining("무엇") });
    const what = "somun은 초안을 씁니다.\n\n무엇인가\n- 릴리스·PR·커밋을 읽어 채널마다 초안을 씁니다.";
    expect(rule(lintDraft("show_gn", "Show GN: somun", what, [], { limitations: [] }), "sections")?.ok).toBe(true);
    expect(rule(lintDraft("show_gn", "Show GN: somun", what, [], { limitations: ["GitHub만 지원"] }), "sections")).toMatchObject({ ok: false, detail: expect.stringContaining("한계") });
    expect(rule(lintDraft("show_gn", "Show GN: somun", `${what}\n\n한계\n- GitHub만 지원`, [], { limitations: ["GitHub만 지원"] }), "sections")?.ok).toBe(true);
  });

  it("asks the Show HN author comment to end with an open question", () => {
    expect(rule(lintDraft("show_hn", "Show HN: somun – drafts", "I built somun. It drafts posts."), "open_question")?.ok).toBe(false);
    expect(rule(lintDraft("show_hn", "Show HN: somun – drafts", "I built somun. How do you write updates?"), "open_question")?.ok).toBe(true);
  });
});

it("asks introductions to link the homepage when the project has one", () => {
  const candidate = { title: "somun", type: "new-repo", evidence: { repo: "Open330/somun", repoUrl: "https://github.com/Open330/somun", homepage: "https://somun.jiun.dev/" } };
  const intro = draftLintFacts(candidate, undefined, "introduction");
  const rule = (body: string, facts = intro) => lintDraft("x", undefined, body, [], facts).find((r) => r.rule === "preferred_link");
  expect(rule("somun drafts posts. https://github.com/Open330/somun")).toMatchObject({ ok: false, detail: expect.stringContaining("https://somun.jiun.dev") });
  expect(rule("somun drafts posts. https://somun.jiun.dev")?.ok).toBe(true);
  expect(rule("somun drafts posts. https://github.com/Open330/somun", draftLintFacts(candidate, undefined, "update"))).toBeUndefined();
});

it("asks for a Show GN why section only when the profile states why the project exists", () => {
  const body = "somun은 초안을 씁니다.\n\n무엇인가\n- 릴리스·PR·커밋을 읽어 채널마다 초안을 씁니다.";
  const sections = (facts: Parameters<typeof lintDraft>[4]) => lintDraft("show_gn", "Show GN: somun", body, [], facts).find((r) => r.rule === "sections");
  expect(sections({ limitations: [] })?.ok).toBe(true);
  expect(sections({ limitations: [], why: "만든 건 많은데, 설명하기가 어렵습니다." })).toMatchObject({ ok: false, detail: expect.stringContaining("왜") });
  expect(lintDraft("show_gn", "Show GN: somun", `${body}\n\n왜 만들었나\n- 만든 건 많은데 설명하기가 어려웠습니다.`, [], { limitations: [], why: "x" }).find((r) => r.rule === "sections")?.ok).toBe(true);
});

it.each(['### ', '**', ''])('accepts Show GN section headings with %s formatting', (prefix) => {
  const suffix = prefix === '**' ? '**' : '';
  const body = `${prefix}무엇인가${suffix}\n소문은 게시글 초안을 작성합니다.\n\n${prefix}왜 만들었나${suffix}\n변경을 설명하기 어려웠습니다.\n\n${prefix}한계${suffix}\n직접 게시해야 합니다.`;
  expect(lintDraft('show_gn', 'Show GN: somun', body, [], { why:'변경을 설명하기 어려웠습니다.', limitations:['직접 게시해야 합니다.'] }).find(x=>x.rule==='sections')?.ok).toBe(true);
});

it('flags mixed Korean prose without rejecting English posts or technical identifiers', () => {
  const mixed=lintDraft('x', undefined, '소셜 media 게시글과 마케팅 copy를 작성합니다. https://example.test');
  expect(mixed.find(x=>x.rule==='mixed_korean_terms')).toMatchObject({ok:false,detail:expect.stringContaining('소셜 media')});
  expect(lintDraft('x', undefined, '소셜 미디어 게시글과 홍보 문구를 작성합니다. PR과 media_type 값은 그대로입니다. https://example.test').find(x=>x.rule==='mixed_korean_terms')?.ok).toBe(true);
  expect(lintDraft('x', undefined, 'Draft social media posts and marketing copy. https://example.test').find(x=>x.rule==='mixed_korean_terms')).toBeUndefined();
});

it("ignores numbered outline labels while still checking numeric claims on those lines", () => {
  const outline = "somun 제목 후보 1: 줄바꿈 처리\nTitle candidate 2: CRLF handling\nSection 3: processes 40 files\n섹션 4: 99% faster";
  expect(unsupportedNumbers(outline, "CRLF handling")).toEqual(["40", "99%"]);
  expect(unsupportedNumbers("Section 3 improved 40 files", "")).toEqual(expect.arrayContaining(["3", "40"]));
});

it("flags selected author-role claims for review without treating neutral release attribution as authorship", () => {
  const facts = { sourceText: "Vite v8.3.0 fixes CRLF positions." };
  for (const body of ["I built Vite.", "We released Vite.", "Vite v8.3.0을 출시했습니다.", "개발했습니다."]) {
    expect(lintDraft("threads", undefined, body, [], facts).find((r) => r.rule === "author_role_need_review")?.ok).toBe(false);
  }
  for (const body of ["Vite v8.3.0 변경 사항입니다.", "Vite v8.3.0이 출시되었습니다.", "Vite handles CRLF positions."]) {
    expect(lintDraft("threads", undefined, body, [], facts).find((r) => r.rule === "author_role_need_review")?.ok).toBe(true);
  }
});

it("flags an article or a placeholder question when the Blog channel promises an outline", () => {
  const facts = { sourceText: "A tool that handles CRLF positions." };
  const article = "A tool handles CRLF positions. It reads releases and writes posts. What would you write?";
  expect(lintDraft("blog", "CRLF handling", article, [], facts).find((r) => r.rule === "outline_structure")?.ok).toBe(false);
  const outline = "CRLF handling\nLine ending positions\nHandling line endings\n\nIntroduction: handles CRLF positions\nInput: line endings\nOperation: handles positions\nWrap-up: CRLF handling\nWhat part of CRLF handling matters to you?";
  expect(lintDraft("blog", "CRLF handling", outline, [], facts).find((r) => r.rule === "outline_structure")?.ok).toBe(true);
  expect(lintDraft("blog", "CRLF handling", outline.replace("What part of CRLF handling matters to you?", "what to ask the reader"), [], facts).find((r) => r.rule === "outline_structure")?.ok).toBe(false);
});
