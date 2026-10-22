import { channelSpec } from "./channels.js";
import { describe, expect, it } from "vitest";
import { crossLangNumberDiff, draftLintFacts, lintDraft, lintPassed, numberTokens, unsupportedNumbers } from "./lint.js";
import { clusterKeyFor, crossedThreshold } from "./cluster.js";
import { prepareIntroduction } from "./introduction-edit.js";

describe("lintDraft", () => {
  it("flags the real zero-limit omission for human review, without certifying corrected prose", () => {
    const candidate = { title: "sai update", type: "in-progress", evidence: { repo: "jiunbae/sai", repoUrl: "https://github.com/jiunbae/sai", mergedPrDetails: [{ number: 42, title: "New account allowance", body: "가입 후 24시간 동안 무료 계정의 텍스트 한도를 150턴으로 올린다. 운영자가 0으로 닫은 한도는 열지 않는다.", url: "https://github.com/jiunbae/sai/pull/42" }] } };
    for (const purpose of ["introduction", "update"] as const) for (const body of ["sai에서 가입 후 24시간 동안 무료 계정의 텍스트 한도를 150턴으로 올렸어요.", "sai에서 가입 후 24시간 동안 무료 계정의 텍스트 한도를 150턴으로 올렸어요. 운영자가 0으로 닫은 한도는 제외해요."]) {
      const result = lintDraft("threads", undefined, body, [], draftLintFacts(candidate, undefined, purpose)).find((l) => l.rule === "source_conditions_need_review");
      expect(result).toMatchObject({ ok: false });
      expect(result?.detail).toContain("#42");
      expect(result?.detail).toContain("자동 판정한 결과는 아닙니다");
    }
    expect(lintDraft("threads", undefined, "Plain update", [], draftLintFacts({ ...candidate, evidence: { ...candidate.evidence, mergedPrDetails: [] } })).some(l => l.rule === "source_conditions_need_review")).toBe(false);
  });
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
    const k = clusterKeyFor({ kind: "pr_merged", repo: "o/r", ref: "1", occurredAt: 5, payload: {} }, { latestReleaseAt: 10, recentPrCount: 5 });
    expect(k).toBeNull();
  });
  it("turns PRs merged after the latest release into in-progress work instead of orphaning them", () => {
    const pr = { kind: "pr_merged" as const, repo: "o/r", ref: "1", occurredAt: 10 * 86400e3, payload: {} };
    expect(clusterKeyFor(pr, { latestReleaseAt: 86400e3, recentPrCount: 3 })?.type).toBe("in-progress");
    expect(clusterKeyFor(pr, { latestReleaseAt: 86400e3, recentPrCount: 2 })).toBeNull();
  });
  it("makes a commit batch an in-progress candidate", () => {
    expect(clusterKeyFor({ kind: "commit_batch", repo: "o/r", ref: "c", occurredAt: 10, payload: {} }, {})?.type).toBe("in-progress");
  });
  it("detects crossed thresholds", () => {
    expect(crossedThreshold(20, 60, [10, 25, 50, 100])).toBe(50);
    expect(crossedThreshold(60, 70, [10, 25, 50, 100])).toBeNull();
    // 처음 연결한 저장소는 기준선만 잡는다.
    expect(crossedThreshold(undefined, 5496, [10, 25, 50, 100, 5000])).toBeNull();
    expect(crossedThreshold(0, 12, [10, 25])).toBe(10);
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
  expect(unsupportedNumbers("Now 150ms", "Cold start 800ms → 200ms")).toEqual(["150ms"]);
  expect(unsupportedNumbers("3x faster", "3x faster builds")).toEqual([]);
});

it("treats a changed unit, scale word, or vague magnitude as a different claim", () => {
  // 단위가 바뀌면 다른 주장이다. 단위 없이 쓴 같은 수는 원자료와 맞는다.
  expect(unsupportedNumbers("Startup takes 2ms", "Startup takes 2s")).toEqual(["2ms"]);
  expect(unsupportedNumbers("Startup takes 2 seconds", "Startup takes 2s")).toEqual([]);
  expect(unsupportedNumbers("시작 시간이 2초로 줄었다", "Startup takes 2s")).toEqual([]);
  expect(unsupportedNumbers("Bundle is 800MB", "Bundle is 800KB")).toEqual(["800mb"]);
  expect(unsupportedNumbers("Took 2 steps", "Took 2s")).toEqual([]);
  // 크기 단어는 값으로 비교한다. 0·1 예외에 숨지 않는다.
  expect(unsupportedNumbers("1k stars", "1,024 stars")).toEqual(["1000"]);
  expect(unsupportedNumbers("used by 1 million developers", "100 stars")).toEqual(["1000000"]);
  expect(unsupportedNumbers("1만 명이 씁니다", "10k users")).toEqual([]);
  // 쉼표: 천 단위만 붙여 읽는다.
  expect(unsupportedNumbers("15 s", "1,5 s")).toEqual(["15s"]);
  expect(unsupportedNumbers("4102 stars", "4,102 stars")).toEqual([]);
  // 대문자 배수, 말로 쓴 배수·크기.
  expect(unsupportedNumbers("3X faster", "fixed 3 bugs")).toEqual(["3x"]);
  expect(unsupportedNumbers("Memory use halved", "Memory use dropped")).toEqual(["0.5x"]);
  expect(unsupportedNumbers("메모리가 절반으로 줄었다", "Memory use dropped")).toEqual(["0.5x"]);
  expect(unsupportedNumbers("ten times faster", "faster")).toEqual(["10x"]);
  expect(unsupportedNumbers("hundreds of developers", "developers")).toEqual(["hundreds"]);
  expect(unsupportedNumbers("수백 개의 저장소", "저장소")).toEqual(["수백"]);
  expect(unsupportedNumbers("수십 배 빨라졌다", "빨라졌다")).toEqual(["N배"]);
  expect(unsupportedNumbers("１０배 빠름", "빠름")).toEqual(["10x"]);
  expect(unsupportedNumbers("Memory use halved", "Memory use halved in v2")).toEqual([]);
});

it("asks LinkedIn posts to come in paragraphs", () => {
  const wall = lintDraft("linkedin", undefined, "One long block https://somun.jiun.dev");
  expect(wall.find((r) => r.rule === "paragraphs")?.ok).toBe(false);
  const split = lintDraft("linkedin", undefined, "Hook.\n\nWhat it is.\n\nHow it works.\n\nhttps://somun.jiun.dev");
  expect(split.find((r) => r.rule === "paragraphs")?.ok).toBe(true);
  const focused = lintDraft("linkedin", undefined, "CSV 내보내기를 지원합니다.\n\nhttps://somun.jiun.dev");
  expect(focused.find((r) => r.rule === "paragraphs")?.ok).toBe(true);
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

describe("claims and evasions", () => {
  const facts = { repo: "open330/somun", sourceText: "somun drafts posts. The fastest path is the CLI.", limitations: [] };
  const rule = (r: ReturnType<typeof lintDraft>, name: string) => r.find((x) => x.rule === name);
  it("flags superlative and 'first' claims the evidence does not make", () => {
    expect(rule(lintDraft("x", undefined, "The only tool you need. 세계 최초. https://x.y", [], facts), "claims_need_review")?.args?.phrases).toBe("the only, 세계 최초");
    expect(rule(lintDraft("x", undefined, "The fastest path is the CLI. https://x.y", [], facts), "claims_need_review")?.ok).toBe(true);
  });
  it("normalizes banned phrases against spacing, invisible characters, and compatibility forms", () => {
    expect(rule(lintDraft("x", undefined, "We are excited  to\nannounce it https://x.y"), "banned_phrases")?.ok).toBe(false);
    expect(rule(lintDraft("x", undefined, "excited to an​nounce https://x.y"), "banned_phrases")?.ok).toBe(false);
    expect(rule(lintDraft("x", undefined, "game‑changer https://x.y"), "banned_phrases")?.ok).toBe(false);
  });
  it("finds a wrong owner at a sentence end and inside a GitHub URL, but not similar repository names", () => {
    expect(rule(lintDraft("x", undefined, "See evil/somun.", [], facts), "repo_name")?.ok).toBe(false);
    expect(rule(lintDraft("x", undefined, "https://github.com/evil/somun", [], facts), "repo_name")?.ok).toBe(false);
    expect(rule(lintDraft("x", undefined, "https://github.com/Open330/somun and evil/somun-cli", [], facts), "repo_name")?.ok).toBe(true);
  });
  it("catches fullwidth and title exclamation marks, real vote asks, and invented beta notes", () => {
    expect(rule(lintDraft("x", undefined, "Done！ https://x.y"), "no_exclamation")?.ok).toBe(false);
    expect(rule(lintDraft("show_hn", "Show HN: somun!", "Body?"), "no_exclamation")?.ok).toBe(false);
    expect(rule(lintDraft("show_hn", "Show HN: somun", "We devote time to a vote counter feature. Thoughts?"), "no_vote_request")?.ok).toBe(true);
    expect(rule(lintDraft("show_hn", "Show HN: somun", "Please give it a star. Thoughts?"), "no_vote_request")?.ok).toBe(false);
    expect(rule(lintDraft("show_gn", "소문", "추천 눌러 주세요"), "no_vote_request")?.ok).toBe(false);
    expect(rule(lintDraft("x", undefined, "It is still experimental. https://x.y", [], facts), "no_invented_limit")?.ok).toBe(false);
    expect(rule(lintDraft("x", undefined, "It is still experimental. https://x.y", [], { ...facts, sourceText: "This is still experimental." }), "no_invented_limit")?.ok).toBe(true);
  });
});

it("reads spaced multipliers, rank claims, and word-sized quantities as claims to ground", () => {
  expect(unsupportedNumbers("3 times faster", "fixed 3 bugs")).toEqual(["3x"]);
  expect(unsupportedNumbers("2 배 빨라짐", "2개 수정")).toEqual(["2x"]);
  expect(unsupportedNumbers("#1 on HN", "a tool")).toEqual(["#1"]);
  expect(unsupportedNumbers("0 dependencies", "a tool")).toEqual(["0"]);
  expect(unsupportedNumbers("a million downloads", "a tool")).toEqual(["a million+"]);
  expect(unsupportedNumbers("천 명 이상이 사용", "a tool")).toEqual(["1000"]);
});

it("reads numbers at the end of a sentence", () => {
  expect(unsupportedNumbers("We fixed 40 bugs.", "Fixed 12 bugs.")).toEqual(["40"]);
  expect(unsupportedNumbers("1.0 버전 전까지 API가 바뀔 수 있습니다", "APIs may still change before 1.0.")).toEqual([]);
  expect(unsupportedNumbers("Released in 2026.", "a tool")).toEqual(["2026"]);
});

it("flags an untranslated English sentence in a Korean post but not names or commands", () => {
  const rule = (body: string) => lintDraft("x", undefined, body).find((r) => r.rule === "mixed_language");
  expect(rule("muxa는 tmux 안의 에이전트를 지켜봅니다. APIs may still change before 1.0. https://github.com/Open330/muxa")?.ok).toBe(false);
  expect(rule("Claude Code, Codex, Gemini CLI, Aider 세션을 봅니다. https://x.y")?.ok).toBe(true);
  expect(rule("설치는 다음과 같습니다.\n`npm install -g muxa and run it in the terminal`")?.ok).toBe(true);
  expect(rule("Claude Code, Codex, Gemini CLI, OpenCode, Aider\n위 도구를 지원합니다.")?.ok).toBe(true);
});


it("counts the closing question in a channel sentence limit, excluding URLs and decimal/version boundaries", () => {
  const spec = { id: "custom_short" as const, label: "Short", defaultLangs: ["ko"], maxChars: null, maxSentences: 3, hasTitle: false, rules: "Facts only.", mediaHint: "", composeUrl: "", runbook: [] };
  const check = (body: string, limit = 3) => lintDraft(spec.id, undefined, body, [], {}, "ko", { ...spec, maxSentences: limit }).find((r) => r.rule === "sentence_count");
  expect(check("초안을 작성해요. 문체 예시를 학습해요. 어디에 올리시나요?")?.ok).toBe(true);
  expect(check("초안을 작성해요. 문체 예시를 학습해요. 검증이 필요해요. 어디에 올리시나요?")?.ok).toBe(false);
  expect(check("v1.2 supports 0.5 seconds. Where do you use it? https://example.com/v1.2", 2)?.ok).toBe(true);
  expect(check("도구예요。 어디에 올리나요？", 2)?.ok).toBe(true);
  expect(lintDraft(spec.id, undefined, "One. Two. Three. Four.", [], {}, "en", { ...spec, maxSentences: undefined }).some((r) => r.rule === "sentence_count")).toBe(false);
  expect(lintDraft("threads", undefined, "One. Two. Three.").find((r) => r.rule === "sentence_count")?.ok).toBe(false);
});


describe("unsupported generated endorsements", () => {
  const facts = { sourceText: "somun reads releases, PRs and commits and prepares channel drafts." };
  const check = (body: string, sourceText = facts.sourceText) => lintDraft("threads", undefined, body, [], { sourceText }).find((r) => r.rule === "endorsement_need_review");
  it.each([
    "somun은 초안을 작성해 주는데, 홍보가 서툰 개발자에게 정말 편할 것 같아요.",
    "이 도구는 개발자에게 유용할 것 같아요.",
    "이 도구가 정말 유용해요.",
    "이 도구를 꼭 추천합니다.",
    "It would be really useful for developers.",
    "I recommend this tool for developers.",
  ])("flags an endorsement not established by evidence: %s", (body) => {
    expect(check(body)).toMatchObject({ ok: false, args: { phrases: body } });
  });
  it.each([
    "somun은 릴리스와 PR을 읽어 초안을 작성해요. 어느 채널에 올리시나요?",
    "여러분의 작업에서 이 기능이 유용할 것 같나요?",
    "Do you find this really useful?",
    "I do not recommend this tool.",
    "This is not really useful.",
    "이 도구는 정말 유용하지 않아요.",
  ])("does not treat tasks, questions or negative statements as positive endorsements: %s", (body) => {
    expect(check(body)?.ok).toBe(true);
  });
  it("requires the full statement in evidence rather than an adjective appearing under a different meaning", () => {
    const body = "It would be useful for developers.";
    expect(check(body, body)?.ok).toBe(true);
    expect(check(body, "It would not be useful for developers.")?.ok).toBe(false);
    expect(check("somun은 정말 유용해요.", "유용한 기능을 목표로 하는 도구입니다.")?.ok).toBe(false);
  });
  it("applies to owned personal channels and leaves inputs without grounding data unchanged", () => {
    const spec = { ...channelSpec("threads"), id: "custom_updates" as const };
    expect(lintDraft(spec.id, undefined, "I recommend this tool.", [], facts, "en", spec).find((r) => r.rule === "endorsement_need_review")?.ok).toBe(false);
    expect(lintDraft("threads", undefined, "I recommend this tool.", []).some((r) => r.rule === "endorsement_need_review")).toBe(false);
  });
});


it("suggests a concrete Threads workflow question without rejecting a position or scoped question", () => {
  const check = (body: string) => lintDraft("threads", undefined, body, []).find((r) => r.rule === "question_specificity")?.ok;
  for (const body of ["somun을 써보셨나요?", "somun을 사용해보신 적이 있나요?", "Have you tried this tool?", "What do you think?", "어떻게 생각하시나요?"]) expect(check(body)).toBe(false);
  for (const body of ["어떤 채널에 올리시나요?", "어떤 환경에서 이 옵션을 써보셨나요?", "Which inputs have you used?", "이 작업에는 명시적인 경로가 필요해요."]) expect(check(body)).toBe(true);
  const custom = { ...channelSpec("threads"), id: "custom_survey" as const };
  expect(lintDraft(custom.id, undefined, "Have you tried this tool?", [], {}, "en", custom).some((r) => r.rule === "question_specificity")).toBe(false);
});


describe("profile avoid terms in source links", () => {
  it("keeps a required repository URL without warning about its owner or path", () => {
    const result = lintDraft("x", undefined, "munjit은 생각을 글로 다듬습니다. https://github.com/jiunbae/munjit", [], { avoid: ["jiunbae"] });
    expect(result.find((item) => item.rule === "avoid_terms")?.ok).toBe(true);
    expect(result.find((item) => item.rule === "has_link")?.ok).toBe(true);
  });
  it("still flags forbidden wording in the title, body, and a Markdown label", () => {
    for (const [title, body] of [["jiunbae 소개", "https://github.com/jiunbae/munjit"], [undefined, "JIUNBAE가 만든 글 https://github.com/jiunbae/munjit"], [undefined, "[jiunbae](https://github.com/jiunbae/munjit)"], [undefined, "(https://github.com/jiunbae/munjit)jiunbae"]]) {
      expect(lintDraft("x", title, body!, [], { avoid: ["jiunbae"] }).find((item) => item.rule === "avoid_terms")?.ok).toBe(false);
    }
  });
});


describe("explicit Korean channel register", () => {
  const result = (body: string, facts: import("./lint.js").LintFacts = { language: "ko" }, tone?: string) => lintDraft("threads", undefined, body, [], facts, "ko", tone === undefined ? undefined : { ...channelSpec("threads"), identity: { ...channelSpec("threads").identity!, tone } }).find(l => l.rule === "register_mismatch");
  it.each(["수정합니다.", "사용할 수 있습니다.", "이 기능입니까?", "고쳤어요. 사용할 수 있습니다."])("flags formal endings: %s", body => expect(result(body)?.ok).toBe(false));
  it.each(["수정해요. 사용할 수 있어요.", "‘수정합니다.’라는 문구를 보여줘요.", '> 수정합니다.\n고쳐요.', '```text\n수정합니다.\n```\n고쳐요.', '`수정합니다.`를 표시해요.', '"수정합니다."라고 보여줘요.'])("ignores valid prose or quoted formal endings: %s", body => expect(result(body)?.ok).toBe(true));
  it("leaves language, custom tone and explicit editor overrides alone", () => {
    expect(result("수정합니다.", { language: "en" })).toBeUndefined();
    expect(result("수정합니다.", { language: "ko" }, "차분한 설명")).toBeUndefined();
    expect(result("수정합니다.", { language: "ko" }, "해요체 대신 합니다체")).toBeUndefined();
    expect(result("수정합니다.", { language: "ko", editorInstruction: "합니다체로 써주세요." })).toBeUndefined();
  });
});


it("checks introduction composition without changing update, legacy or custom limits", () => {
  const body = "코드를 읽어요. 퀴즈를 만들어요. 답을 골라요. 내용을 확인해요.";
  const check = (purpose?: "introduction" | "update") => lintDraft("threads", "", body, [], { purpose }).find((r) => r.rule === "sentence_count");
  expect(check("introduction")?.ok).toBe(true);
  expect(check("update")?.ok).toBe(false);
  expect(check()?.ok).toBe(false);
  const custom = { id: "custom_brief" as const, label: "Brief", defaultLangs: ["ko"], maxChars: 30, maxSentences: 1, hasTitle: false, rules: "One sentence", mediaHint: "", composeUrl: "", runbook: [] };
  expect(lintDraft(custom.id, "", body, [], { purpose: "introduction" }, "ko", custom).find((r) => r.rule === "sentence_count")?.ok).toBe(false);
  expect(lintDraft("threads", "", "가".repeat(501), [], { purpose: "introduction" }).find((r) => r.rule === "length")?.ok).toBe(false);
});

it.each([
  "코드를 퀴즈로 만들어요. 평소 새로운 저장소는 어떤 방식으로 살펴보시나요?",
  "음성을 요약해요. 보통 기록은 어떻게 하시나요?",
  "Tracks agents. How do you usually check their status?",
])("flags an introduction habit question without imposing it on updates or explicit requests: %s", (body) => {
  const check = (facts: Parameters<typeof lintDraft>[4]) => lintDraft("threads", "", body, [], facts).find((r) => r.rule === "introduction_habit_question");
  expect(check({ purpose: "introduction" })?.ok).toBe(false);
  expect(check({ purpose: "update" })).toBeUndefined();
  expect(check({ purpose: "introduction", editorInstruction: "질문으로 끝내세요" })).toBeUndefined();
});


it.each(["질문 없이 소개하세요", "질문으로 끝내지 말아주세요", "Do not add a question", "Without questions"])("keeps the introduction habit check for a negative question instruction: %s", (editorInstruction) => {
  expect(lintDraft("threads", "", "코드를 읽어요. 평소 어떤 방식으로 읽으시나요?", [], { purpose: "introduction", editorInstruction }).find((r) => r.rule === "introduction_habit_question")?.ok).toBe(false);
});

describe("conservative introduction editing signals", () => {
  const check = (body: string, facts: import("./lint.js").LintFacts = { purpose: "introduction" }, channel: Parameters<typeof lintDraft>[0] = "x") => lintDraft(channel, "", body, [], facts);
  it.each(["Windows에서 원격 파일을 관리하려면 Acme를 사용합니다.", "Mac 파일을 복사하려는 사용자는 Acme를 사용할 수 있어요.", "화면과 파일을 연결하려는 사용자는 Acme를 사용하여 기기를 관리할 수 있습니다."])("flags an intention/use preface while leaving explicit edits and updates alone: %s", (body) => {
    expect(check(body).find(r => r.rule === "introduction_intent_preface")?.ok).toBe(false);
    expect(check(body, { purpose: "update" }).some(r => r.rule === "introduction_intent_preface")).toBe(false);
    expect(check(body, { purpose: "introduction", editorInstruction: "이 서두는 유지하세요" }).some(r => r.rule === "introduction_intent_preface")).toBe(false);
    expect(check("Mac 화면을 Windows에서 열어 조작해요.").find(r => r.rule === "introduction_intent_preface")?.ok).toBe(true);
  });
  it.each(["Acme는 원격 기기의 화면과 파일을 연결하는 소프트웨어입니다.", "Acme는 파일을 검색하는 도구예요.", "Acme is a tool for searching local files."])("marks a category-definition opening as an editorial pattern: %s", (body) => {
    expect(check(body).find(r => r.rule === "introduction_definition_opening")?.ok).toBe(false);
  });
  it.each(["Windows에서 Mac 화면을 열어 조작해요.", "Acme에서 SSH 연결을 열어요.", "Acme는 파일 이름으로 검색해요."])("does not ban connection verbs or ordinary action sentences: %s", (body) => {
    expect(check(body).find(r => r.rule === "introduction_definition_opening")?.ok).toBe(true);
  });
  it("finds only complete repeated sentences after case, spacing and punctuation normalization", () => {
    expect(check("파일을 복사해요.\n\n파일을  복사해요!").find(r => r.rule === "introduction_repeated_sentence")?.ok).toBe(false);
    expect(check("파일을 복사해요. 파일을 이동해요.").find(r => r.rule === "introduction_repeated_sentence")?.ok).toBe(true);
    expect(check("Open a file. OPEN A FILE!").find(r => r.rule === "introduction_repeated_sentence")?.ok).toBe(false);
  });
  it("leaves updates, legacy drafts, custom channels and explicit editor requests alone", () => {
    const body = "Acme는 파일 도구입니다. Acme는 파일 도구입니다.";
    for (const facts of [{}, { purpose: "update" as const }, { purpose: "introduction" as const, editorInstruction: "정의로 시작하고 반복해주세요" }]) {
      expect(check(body, facts).some(r => r.rule.startsWith("introduction_definition") || r.rule === "introduction_repeated_sentence")).toBe(false);
    }
    expect(check(body, { purpose: "introduction" }, "linkedin").some(r => r.rule === "introduction_definition_opening")).toBe(false);
    const custom = { ...channelSpec("x"), id: "custom_intro" as const };
    expect(lintDraft(custom.id, "", body, [], { purpose: "introduction" }, "ko", custom).some(r => r.rule === "introduction_definition_opening" || r.rule === "introduction_repeated_sentence")).toBe(false);
    expect(check(body, { purpose: "introduction" }, "threads").find(r => r.rule === "introduction_definition_opening")?.ok).toBe(false);
  });
});

describe("source review for effect wording", () => {
  it("does not let register normalization hide introduction filler or a convenience claim", () => {
    const body = prepareIntroduction("Acme를 간편하게 소개합니다.", { channel: "threads", language: "ko", purpose: "introduction", tone: "해요체", bannedPhrases: ["소개합니다"] });
    const results = lintDraft("threads", "", body, ["소개합니다"], { purpose: "introduction", language: "ko", sourceText: "Copies files over SSH." });
    expect(results.find(r => r.rule === "banned_phrases")?.ok).toBe(false);
    expect(results.find(r => r.rule === "endorsement_need_review")?.ok).toBe(false);
  });
  const check = (body: string, sourceText = "Files can be copied.") => lintDraft("x", "", body, [], { sourceText }).find(r => r.rule === "endorsement_need_review");
  it.each(["파일을 안전하게 옮겨요.", "작업을 효율적으로 처리해요.", "파일을 편리하게 관리해요.", "간편하게 파일을 열어요.", "대용량 파일을 끊김 없이 옮겨요.", "쉽고 빠르게 열어요.", "언제 어디서나 접속해요.", "Transfer files safely.", "Work efficiently."])("requests review rather than certifying an unsupported effect: %s", (body) => {
    expect(check(body)?.ok).toBe(false);
    expect(check(body, body)?.ok).toBe(true);
  });
  it("may flag a legitimate English-to-Korean translation because evidence matching is lexical", () => {
    expect(check("파일을 안전하게 옮겨요.", "Transfer files safely.")?.ok).toBe(false);
  });
  it("keeps actions and security nouns without effect promises", () => {
    expect(check("SSH로 파일을 복사해요. 보안 설정을 열어요.")?.ok).toBe(true);
    expect(check("This does not safely transfer files.")?.ok).toBe(true);
  });
});
