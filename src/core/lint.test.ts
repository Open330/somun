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
