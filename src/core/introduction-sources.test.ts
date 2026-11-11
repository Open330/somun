import { describe, expect, it } from "vitest";
import { introductionReasons, introductionScopeExcerpts } from "./introduction-sources.js";

describe("introductionReasons", () => {
  it("returns the title with each overview section's first paragraph verbatim", () => {
    const readme = "# Tool\n\n[![ci](x)](y)\n\nTool searches saved logs.\n\n## Why Tool\n\nSearch saved logs without a live connection.\nNo server needed.\n\nSecond paragraph.\n\n## Setup\nnpm i tool";
    expect(introductionReasons(readme)).toEqual([
      "# Tool\nTool searches saved logs.",
      "# Tool\n## Why Tool\nSearch saved logs without a live connection. No server needed.",
    ]);
  });

  it("ignores setup, code and empty overview sections", () => {
    expect(introductionReasons("# T\n\n## Overview\n\n```sh\nrun\n```\n\n## Install\nrun it")).toEqual([]);
    expect(introductionReasons(undefined)).toEqual([]);
  });

  it("accepts Korean overview headings and caps the candidate count", () => {
    const readme = ["# 도구", ...["소개", "왜 필요한가", "특징", "개요", "주요 기능"].map((h, i) => `## ${h}\n\n문단 ${i}.`)].join("\n\n");
    const reasons = introductionReasons(readme);
    expect(reasons).toHaveLength(4);
    expect(reasons[0]).toBe("# 도구\n## 소개\n문단 0.");
  });

  it("drops overly long paragraphs instead of truncating them", () => {
    expect(introductionReasons(`# T\n\n## Why\n\n${"a".repeat(700)}`)).toEqual([]);
  });
});

describe("introductionScopeExcerpts", () => {
  it("keeps only lines that state scope or prerequisites", () => {
    expect(introductionScopeExcerpts("Input\nOnly saved local JSON files are supported.\nSearch by time and severity.\nRequires Node 22.\nOnly saved local JSON files are supported.")).toEqual([
      "Only saved local JSON files are supported.",
      "Requires Node 22.",
    ]);
    expect(introductionScopeExcerpts("로컬 파일만 지원해요.\n빠르게 찾으세요.")).toEqual(["로컬 파일만 지원해요."]);
    expect(introductionScopeExcerpts(undefined)).toEqual([]);
  });
});
