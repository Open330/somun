// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import DraftEvidenceReview from "./DraftEvidenceReview";
import type { Evidence } from "@shared/types";

const evidence: Evidence = {
  repo: "me/tool",
  repoUrl: "https://github.com/me/tool",
  readmeExcerpt: "Short excerpt",
  readmeForChecks: "Filter rows and export to a separate CSV file. The input file remains unchanged.",
  releaseNotes: "Release 1: export CSV",
  windowReleaseNotes: [
    { tag: "v1", notes: "Release 1: export CSV" },
    { tag: "v0", notes: "Initial import" },
  ],
  mergedPrTitles: ["Add filtering"],
  commitSubjects: ["Preserve input"],
  highlights: ["AI-generated claim to exclude"],
};
afterEach(cleanup);
it("lets readers find activation conditions in the actual PR body", () => {
  render(
    <DraftEvidenceReview
      body="저장소 읽기를 변경했어요."
      editing={false}
      lang="ko"
      evidence={{
        ...evidence,
        mergedPrDetails: [
          {
            number: 113,
            title: "Read repositories",
            body: "Default off; activate with GITHUB_APP_REPO_ACCESS=true.",
            url: "https://github.com/me/tool/pull/113",
          },
        ],
      }}
    />,
  );
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Default off" } });
  const results = screen.getByRole("region", { name: "검색한 원자료" });
  expect(results.textContent).toContain("GITHUB_APP_REPO_ACCESS=true");
  expect(results.textContent).toContain("#113");
  expect(within(results).getByRole("link", { name: /#113/ }).getAttribute("href")).toBe("https://github.com/me/tool/pull/113");
});

it("shows the failed dogfood cases' threshold and key identity prerequisites verbatim with adjacent context", () => {
  const partial =
    "- 마지막 시도는 validation과 같은 하한(`minimumDeliverableCount`, 50%, 5문항이면 3개) 이상이면 짧은 퀴즈를 반환합니다.\n- 첫 시도는 여전히 전체 수를 요구합니다.";
  const rotation =
    "- New optional settings `PREVIOUS_PUBLIC_KEY` and `PREVIOUS_KID`.\n- Startup fails if only one of the two is set, or if the previous kid equals the current kid.";
  render(
    review("마지막 시도에 일부 문항을 반환해요.", false, {
      ...evidence,
      mergedPrDetails: [
        {
          number: 111,
          title: "Partial quiz",
          body: `## Changes\n\n${partial}\n\nUnrelated notes.`,
          url: "https://github.com/me/tool/pull/111",
        },
        { number: 9, title: "Key rotation", body: rotation, url: "https://github.com/me/api/pull/9" },
      ],
    }),
  );
  const summaries = screen.getAllByText(/조건·예외로 보이는 원문/);
  expect(summaries).toHaveLength(2);
  const excerpts = summaries.map((summary) => summary.closest("details")!);
  expect(excerpts[0].textContent).toContain(partial);
  expect(excerpts[0].textContent).not.toContain("Unrelated notes.");
  expect(excerpts[1].textContent).toContain(rotation);
  expect(excerpts[1].textContent).toContain("빠진 내용이 있을 수 있으니 전체 본문도 확인");
  expect(screen.getByRole("region", { name: "검색한 원자료" }).textContent).toContain("Unrelated notes.");
});

it("keeps incomplete and empty PR sources visible with safe original links even when search has no matches", () => {
  render(
    review("기존 토큰을 검증해요.", false, {
      ...evidence,
      mergedPrDetails: [
        { number: 9, title: "Truncated", body: "Collected beginning", bodyTruncated: true, url: "https://github.com/me/api/pull/9" },
        { number: 10, title: "Missing", body: "", url: "javascript:alert(1)" },
      ],
    }),
  );
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "no matching text" } });
  const warning = screen.getByRole("complementary", { name: "추가 원문 확인 필요" });
  expect(warning.textContent).toContain("본문 일부 수집");
  expect(warning.textContent).toContain("#10");
  expect(warning.textContent).toContain("본문 없음");
  expect(within(warning).getByRole("link", { name: /#9/ }).getAttribute("href")).toBe("https://github.com/me/api/pull/9");
  expect(within(warning).queryByRole("link", { name: /#10/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "전체 자료 보기" }));
  expect(screen.getByText("본문이 수집되지 않았습니다. 원문 링크에서 확인하세요.")).toBeTruthy();
});
const review = (body = "CSV를 별도 파일로 내보내요. 원본을 유지해요.", editing = false, source = evidence) => (
  <DraftEvidenceReview title="변경 소식" body={body} lang="ko" editing={editing} evidence={source} />
);

it("compares a selected translated sentence with searchable raw material, without presenting generated summaries as proof", () => {
  render(review());
  fireEvent.click(screen.getByRole("button", { name: /원본을 유지해요/ }));
  expect(screen.getByRole("button", { name: /원본을 유지해요/ }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "UNCHANGED" } });
  const results = screen.getByRole("region", { name: "검색한 원자료" });
  expect(results.textContent).toContain(evidence.readmeForChecks!);
  expect(results.querySelector("mark")?.textContent).toBe("unchanged");
  expect(within(results).queryByText("Short excerpt")).toBeNull();
  expect(within(results).queryByText("AI-generated claim to exclude")).toBeNull();
  expect(within(results).queryByText("Add filtering")).toBeNull();
  expect(screen.getByText(/검색 결과는 사실 확인 완료를 뜻하지 않습니다/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "전체 자료 보기" }));
  expect(within(results).getByText("Add filtering")).toBeTruthy();
  expect(within(results).getAllByText("Release 1: export CSV")).toHaveLength(1);
  expect(within(results).getByText("Initial import")).toBeTruthy();
});

it("distinguishes a missing wording match from absent source text and allows recovery", () => {
  const { rerender } = render(review());
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "편리해요" } });
  expect(screen.getByRole("status").textContent).toContain("번역·의역은 직접 대조");
  fireEvent.click(screen.getByRole("button", { name: "전체 자료 보기" }));
  expect(screen.queryByRole("status")).toBeNull();
  rerender(review("New body.", false, { repo: "me/tool", repoUrl: "javascript:alert(1)", highlights: ["Summary"] }));
  expect(screen.getByRole("status").textContent).toContain("원문이 저장돼 있지 않습니다");
  expect(screen.queryByRole("link")).toBeNull();
  rerender(
    review("New body.", false, {
      repo: "me/tool",
      repoUrl: "bad-url",
      mergedPrDetails: [{ number: 1, title: "Condition", body: "Default off", url: "javascript:alert(1)" }],
    }),
  );
  expect(screen.queryByRole("link")).toBeNull();
});

it("shows unsaved edits and clears a stale sentence selection when text changes", () => {
  const { rerender } = render(review());
  fireEvent.click(screen.getByRole("button", { name: /원본을 유지해요/ }));
  rerender(review("원본 파일은 수정하지 않아요.", true));
  expect(screen.queryByText("원본을 유지해요.")).toBeNull();
  expect(screen.getByRole("button", { name: /원본 파일은 수정하지 않아요/ }).getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByText(/수정 중인 문장을 보여줍니다/)).toBeTruthy();
  expect(screen.getByRole("link", { name: /프로젝트 원문 열기/ }).getAttribute("rel")).toBe("noopener noreferrer");
});

it("shows collected zero values without inventing missing metrics", () => {
  render(review("스타는 0개예요.", false, { repo: "me/tool", repoUrl: "bad-url", stars: 0 }));
  const results = screen.getByRole("region", { name: "검색한 원자료" });
  expect(results.textContent).toContain("스타: 0");
  expect(results.textContent).not.toContain("커밋:");
});
