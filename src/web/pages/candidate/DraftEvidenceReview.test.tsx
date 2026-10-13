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
