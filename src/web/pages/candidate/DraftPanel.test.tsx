// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { Draft } from "@shared/types";
import { loadCatalog, setLocale } from "../../i18n";
import DraftPanel from "./DraftPanel";

vi.mock("../../lib/auth/context", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("../../lib/useDraftReview", () => ({ useDraftReview: () => async () => undefined }));

const draft = (overrides: Partial<Draft> = {}): Draft => ({
  id: 1,
  candidateId: 1,
  channel: "x",
  lang: "ko",
  purpose: "introduction",
  version: 1,
  body: "제품으로 파일을 엽니다.",
  lint: [],
  status: "proposed",
  model: "gemini-3.5-flash-lite",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});
const show = (drafts: Draft[]) =>
  render(
    <RouterProvider
      router={createMemoryRouter([
        {
          path: "/",
          element: (
            <DraftPanel
              cid={1}
              channel="x"
              lang="ko"
              langs={["ko"]}
              onLang={() => undefined}
              drafts={drafts}
              busy={false}
              onRedraft={async () => true}
              showToast={() => undefined}
            />
          ),
        },
      ])}
    />,
  );

afterEach(() => {
  cleanup();
  setLocale("ko");
});

it("shows the original generation source for edited text without claiming current verbatim identity", () => {
  setLocale("ko");
  show([
    draft({
      sourceExcerpt: { url: "https://example.com/official/" },
      body: "사용자가 이후 고친 본문입니다.",
      status: "edited",
      updatedAt: 2,
    }),
  ]);
  const link = screen.getByRole("link", { name: "공식 설명 발췌로 생성" });
  expect(link.getAttribute("href")).toBe("https://example.com/official/");
  expect(link.getAttribute("rel")).toContain("noopener");
  expect(link.getAttribute("title")).toBe("초안 생성에 사용한 공식 설명입니다. 이후 편집한 내용과 다를 수 있습니다.");
});

it("uses the shown version's source rather than assigning provenance to legacy drafts", () => {
  setLocale("ko");
  show([draft({ sourceExcerpt: { url: "https://example.com/original/" } }), draft({ id: 2, version: 2 })]);
  expect(screen.queryByRole("link", { name: "공식 설명 발췌로 생성" })).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "버전" }), { target: { value: "1" } });
  expect(screen.getByRole("link", { name: "공식 설명 발췌로 생성" }).getAttribute("href")).toBe("https://example.com/original/");
});

it("translates the source provenance and its historical meaning into English", async () => {
  await loadCatalog("en");
  setLocale("en");
  show([draft({ sourceExcerpt: { url: "https://example.com/official/" } })]);
  const link = screen.getByRole("link", { name: "Created from official copy excerpts" });
  expect(link.getAttribute("title")).toBe("Official copy used to create this draft. Later edits may differ from the source.");
});
