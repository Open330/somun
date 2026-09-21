import { describe, expect, it } from "vitest";
import { crossLangNumberDiff, lintDraft, lintPassed, numberTokens } from "./lint.js";
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
