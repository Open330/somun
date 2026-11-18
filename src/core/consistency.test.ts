import { describe, expect, it } from "vitest";
import { copyIssues, properTerms, retiredNames } from "./consistency.js";

const README = `# Tend
Tend watches Claude Code, Codex and Antigravity CLI sessions in tmux.
The Google Gemini CLI is no longer supported; use its successor, the Antigravity CLI.
Press Esc to stop. 설정에서 현재 작업 중단을 고를 수 있습니다.`;

describe("retiredNames", () => {
  it("finds a name the README says is no longer supported, without the leading article or vendor", () => {
    expect(retiredNames(README)).toEqual(["Gemini CLI"]);
  });

  it("finds Korean and deprecated phrasings but not an ordinary stop action", () => {
    expect(retiredNames("Legacy Sync is deprecated.\nOld Bridge는 지원 종료되었습니다.\n작업 중단 버튼")).toEqual(["Legacy Sync", "Old Bridge"]);
  });
});

describe("retiredNames edge cases", () => {
  it("reads names wrapped in Markdown and stops at the previous sentence", () => {
    expect(retiredNames("**Gemini CLI** is no longer supported.")).toEqual(["Gemini CLI"]);
    expect(retiredNames("Use the [Old Sync](https://x.dev) app. Legacy Bridge is deprecated.")).toEqual(["Legacy Bridge"]);
  });

  it("keeps underscores inside names and ignores a mark after a finished sentence", () => {
    expect(retiredNames("`OLD_SYNC` is deprecated.")).toEqual(["OLD_SYNC"]);
    expect(retiredNames("Configure Tend. Deprecated options are listed below.")).toEqual([]);
  });

  it("keeps double underscores and does not cross a paragraph or start a new sentence", () => {
    expect(retiredNames("OLD__SYNC is deprecated.")).toEqual(["OLD__SYNC"]);
    expect(retiredNames("Works with Codex\n\nDeprecated flags are listed below.")).toEqual([]);
    expect(retiredNames("Works with Codex\nDeprecated flags are listed below.")).toEqual([]);
  });

  it("splits long punctuation runs in short copy quickly", () => {
    const start = performance.now();
    properTerms(`Filter${"=".repeat(50_000)}Results and More`);
    copyIssues({ readme: "x", readmeTruncated: false, texts: [{ source: "homepage_description", text: `A ${"=".repeat(200_000)}B` }] });
    expect(performance.now() - start).toBeLessThan(200);
  });

  it("scans long runs of whitespace quickly", () => {
    const start = performance.now();
    expect(retiredNames(`Legacy Sync${" ".repeat(30_000)}x`)).toEqual([]);
    expect(retiredNames(`Legacy Sync${" ".repeat(30_000)}is deprecated`)).toEqual([]);
    expect(performance.now() - start).toBeLessThan(200);
  });

  it("scans a long uppercase identifier quickly", () => {
    const readme = `${"A".repeat(32_000)} plain text`;
    const start = performance.now();
    expect(retiredNames(readme)).toEqual([]);
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe("properTerms", () => {
  it("keeps capitalized names but skips sentence-initial words and common terms", () => {
    expect(properTerms("Record every prompt to MinIO. Then see usage in a CLI on macOS.")).toEqual(["MinIO"]);
    expect(properTerms("Tend는 tmux에서 Claude Code·Codex 세션을 지켜봅니다.")).toEqual(["Claude", "Code", "Codex"]);
  });
});

describe("copyIssues", () => {
  const texts = (description: string) => [{ source: "description" as const, text: description }];

  it("flags a retired name left in the repository description", () => {
    expect(copyIssues({ readme: README, readmeTruncated: false, productName: "Tend", texts: texts("Works with Claude Code, Codex, Gemini CLI and Antigravity CLI.") })).toEqual([
      { kind: "retired", source: "description", term: "Gemini CLI" },
    ]);
  });

  it("flags a name that the README never mentions", () => {
    expect(copyIssues({ readme: README, readmeTruncated: false, productName: "Tend", texts: texts("Tend stores sessions in MinIO.") })).toEqual([
      { kind: "not_in_readme", source: "description", term: "MinIO" },
    ]);
  });

  it("does not report absent names when the README was cut short, but still reports retired ones", () => {
    const issues = copyIssues({ readme: README, readmeTruncated: true, productName: "Tend", texts: texts("Tend stores sessions in MinIO and supports Gemini CLI.") });
    expect(issues).toEqual([{ kind: "retired", source: "description", term: "Gemini CLI" }]);
  });

  it("passes copy that matches the README and ignores the product name", () => {
    expect(copyIssues({ readme: README, readmeTruncated: false, productName: "Tend", texts: [...texts("Know which tmux coding agent is waiting. Works with Claude Code and Codex."), { source: "oneliner_en", text: "Tend watches the Claude Code and Codex sessions you run." }] })).toEqual([]);
  });

  it("flags a name at the start of a title and does not count a substring as a mention", () => {
    expect(copyIssues({ readme: "Works with GitHub releases.", readmeTruncated: false, productName: "p", texts: [{ source: "homepage_title", text: "MinIO integration" }, { source: "description", text: "Works with Git." }] })).toEqual([
      { kind: "not_in_readme", source: "homepage_title", term: "MinIO" },
      { kind: "not_in_readme", source: "description", term: "Git" },
    ]);
  });

  it("treats underscores as part of a name when matching the README", () => {
    expect(copyIssues({ readme: "Use OLD_SYNC_NEXT.", readmeTruncated: false, productName: "p", texts: [{ source: "description", text: "Uses OLD_SYNC." }] })).toEqual([{ kind: "not_in_readme", source: "description", term: "OLD_SYNC" }]);
  });

  it("counts a name followed by a Korean particle as mentioned", () => {
    expect(copyIssues({ readme: "MinIO를 설치하면 됩니다.", readmeTruncated: false, productName: "p", texts: [{ source: "description", text: "Works with MinIO." }] })).toEqual([]);
  });

  it("returns nothing without a README", () => {
    expect(copyIssues({ readme: "", texts: texts("Uses MinIO.") })).toEqual([]);
  });
});
