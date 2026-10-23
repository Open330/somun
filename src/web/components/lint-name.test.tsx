// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadCatalog, setLocale } from "../i18n";
import { LintBadges, lintDetail } from "./ui";

const warning = { rule: "introduction_name_missing", ok: false, detail: "서버에 저장된 한국어 설명", args: { name: "Itda" } };
afterEach(() => {
  cleanup();
  setLocale("ko");
});

it("renders the missing product name and its repair guidance in the current UI language", async () => {
  setLocale("ko");
  const view = render(<LintBadges lint={[warning]} />);
  expect(screen.getByText("제품명 없음")).toBeTruthy();
  expect(lintDetail(warning)).toContain("제품명 Itda");
  await loadCatalog("en");
  setLocale("en");
  view.rerender(<LintBadges lint={[warning]} />);
  expect(screen.getByText("Missing product name")).toBeTruthy();
  expect(lintDetail(warning)).toBe(
    "Include the product name Itda in the introduction body. A link or title alone does not identify the product.",
  );
});
