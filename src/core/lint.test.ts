import { describe, expect, it } from "vitest";
import { lintDraft, lintPassed } from "./lint.js";
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
