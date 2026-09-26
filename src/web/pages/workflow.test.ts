// @vitest-environment jsdom
import { createElement } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Draft, SettingsView } from "../../shared/types";
import { DEFAULT_SETTINGS } from "../../app/settings";
import Inbox from "./Inbox";
import DraftPanel from "./candidate/DraftPanel";

const { resources, post } = vi.hoisted(() => ({ resources: new Map<string, { data?: unknown; error?: string; reload: () => void }>(), post: vi.fn() }));
vi.mock("../lib/api", () => ({ useResource: (path: string) => resources.get(path) ?? { reload() {} }, post, patch: vi.fn(), del: vi.fn() }));
vi.mock("../lib/auth/context", () => ({ useAuth: () => ({ user: null }) }));
const set = (path: string, data: unknown) => resources.set(path, { data, reload: vi.fn() });
const wrap = (component: ReturnType<typeof createElement>) => createElement(RouterProvider, { router: createMemoryRouter([{ path: "*", element: component }]) });
beforeEach(() => {
  resources.clear(); post.mockReset().mockResolvedValue({});
  set("/candidates", []); set("/sources", []); set("/settings", { ...DEFAULT_SETTINGS, llm: { ...DEFAULT_SETTINGS.llm, apiKeySet: false } } as SettingsView);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("first useful outcome", () => {
  it("offers a concrete first step instead of empty draft sections", () => {
    render(wrap(createElement(Inbox)));
    expect(screen.getByRole("link", { name: /첫 소스 연결하기/ }).getAttribute("href")).toBe("/connectors");
    expect(screen.queryByText("검수할 초안이 없습니다")).toBeNull();
    expect(screen.getByLabelText("초안 완성 예시")).toBeTruthy();
  });
  it("allows collection with a blog-only source and reports partial failure", async () => {
    set("/sources", [{ id: 1, kind: "blog", targets: ["https://blog.test/rss"], enabled: true }]);
    post.mockResolvedValue({ 1: { error: "offline" } });
    render(wrap(createElement(Inbox)));
    fireEvent.click(screen.getByRole("button", { name: /첫 글감 가져오기/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("일부 소스를 확인하지 못했습니다"));
    expect(post).toHaveBeenCalledWith("/collect");
    expect(screen.getByRole("link", { name: "연결 확인" })).toBeTruthy();
  });
  it("offers recovery when loading fails instead of an endless skeleton", () => {
    resources.set("/candidates", { error: "offline", reload: vi.fn() });
    render(wrap(createElement(Inbox)));
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(resources.get("/candidates")!.reload).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toBeTruthy();
  });
  it("puts low-evidence candidates under attention, not processing", () => {
    set("/candidates", [{ id: 1, title: "A change", repo: "a/x", type: "release", status: "judged", latestJudgmentId: 1, evidence: { highlightsAt: 1 }, updatedAt: Date.now(), judgment: { total: 2, decision: "ask", reasoning: "More evidence needed" } }]);
    render(wrap(createElement(Inbox)));
    expect(screen.getByText("추가 근거 필요")).toBeTruthy();
    expect(screen.queryByText("초안 작성 중")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "missing" } });
    expect(screen.getByText("검색 결과가 없어요")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "전체 글감 보기" }));
    expect(screen.getByRole("link", { name: "A change" })).toBeTruthy();
  });
});

const draft: Draft = { id: 1, candidateId: 1, channel: "x", lang: "en", version: 1, body: "Original draft", status: "proposed", lint: [], model: "test", createdAt: 1, updatedAt: 1 };
const panel = (drafts = [draft]) => wrap(createElement(DraftPanel, { cid: 1, channel: "x", lang: "en", langs: ["en"], onLang: vi.fn(), drafts, busy: false, onRedraft: async () => true, showToast: vi.fn() }));
describe("draft to publication", () => {
  it("lets users register an already-published post without copying first", async () => {
    render(panel());
    fireEvent.change(screen.getByRole("textbox", { name: /게시글 링크/ }), { target: { value: "https://example.test/post" } });
    fireEvent.click(screen.getByRole("button", { name: "게시 링크 저장" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/publications", expect.objectContaining({ url: "https://example.test/post", draftId: 1 })));
    expect(screen.getByRole("heading", { name: "게시 기록을 남겼어요" })).toBeTruthy();
  });
  it("keeps local edits when server data refreshes", () => {
    const view = render(panel());
    fireEvent.click(screen.getByRole("button", { name: "수정" }));
    fireEvent.change(screen.getByRole("textbox", { name: "초안 본문" }), { target: { value: "My unsaved edit" } });
    view.rerender(panel([{ ...draft, body: "Background refresh" }]));
    expect((screen.getByRole("textbox", { name: "초안 본문" }) as HTMLTextAreaElement).value).toBe("My unsaved edit");
  });
  it("retains text and exposes a recoverable error when saving fails", async () => {
    post.mockRejectedValue(new Error("offline"));
    render(panel());
    fireEvent.click(screen.getByRole("button", { name: "수정" }));
    fireEvent.change(screen.getByRole("textbox", { name: "초안 본문" }), { target: { value: "Keep my words" } });
    fireEvent.click(screen.getByRole("button", { name: "변경 저장" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("저장하지 못했습니다"));
    expect((screen.getByRole("textbox", { name: "초안 본문" }) as HTMLTextAreaElement).value).toBe("Keep my words");
  });
  it("shows the saved response immediately without waiting for SSE", async () => {
    post.mockResolvedValue({ ...draft, body: "Saved words", updatedAt: 2, status: "edited" });
    render(panel());
    fireEvent.click(screen.getByRole("button", { name: "수정" }));
    fireEvent.change(screen.getByRole("textbox", { name: "초안 본문" }), { target: { value: "Saved words" } });
    fireEvent.click(screen.getByRole("button", { name: "변경 저장" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "초안 본문" })).toBeNull());
    expect(screen.getByText("Saved words")).toBeTruthy();
    expect(screen.queryByText("Original draft")).toBeNull();
  });
  it("copies homepage links with the channel tag but keeps the saved draft untouched", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const linked = { ...draft, body: "Try it: https://somun.jiun.dev/" };
    render(wrap(createElement(DraftPanel, { cid: 1, channel: "x", lang: "en", langs: ["en"], onLang: vi.fn(), drafts: [linked], busy: false, onRedraft: async () => true, showToast: vi.fn(), homepage: "https://somun.jiun.dev" })));
    expect(screen.getByText(/utm_source=x/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "초안 복사" })));
    expect(writeText).toHaveBeenCalledWith("Try it: https://somun.jiun.dev/?utm_source=x&utm_medium=social&utm_campaign=somun");
    expect(post).toHaveBeenCalledWith("/drafts/1/edit", expect.objectContaining({ body: "Try it: https://somun.jiun.dev/" }));
  });
  it("does not claim copying succeeded when the clipboard is denied", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    render(panel());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "초안 복사" })));
    expect(screen.getByRole("alert").textContent).toContain("복사하지 못했습니다");
    expect(post).not.toHaveBeenCalled();
  });
});

it("blocks browser back navigation until unsaved edits are explicitly discarded", async () => {
  const router = createMemoryRouter([{ path: "/before", element: createElement("p", null, "Previous page") }, { path: "/edit", element: createElement(DraftPanel, { cid: 1, channel: "x", lang: "en", langs: ["en"], onLang: vi.fn(), drafts: [draft], busy: false, onRedraft: async () => true, showToast: vi.fn() }) }], { initialEntries: ["/before", "/edit"], initialIndex: 1 });
  render(createElement(RouterProvider, { router }));
  fireEvent.click(screen.getByRole("button", { name: "수정" }));
  fireEvent.change(screen.getByRole("textbox", { name: "초안 본문" }), { target: { value: "Keep this edit" } });
  await act(async () => { await router.navigate(-1); });
  fireEvent.click(screen.getByRole("button", { name: "계속 수정" }));
  expect((screen.getByRole("textbox", { name: "초안 본문" }) as HTMLTextAreaElement).value).toBe("Keep this edit");
  expect(router.state.location.pathname).toBe("/edit");
  await act(async () => { await router.navigate(-1); });
  fireEvent.click(screen.getByRole("button", { name: "수정 내용 버리고 이동" }));
  await waitFor(() => expect(screen.getByText("Previous page")).toBeTruthy());
});

it("shows actionable evidence warnings without requiring hover", () => {
  render(panel([{ ...draft, lint: [{ rule: "numbers_need_review", ok: false, detail: "제공된 근거에서 찾지 못한 수치: 99%. 원문과 단위를 확인해 주세요." }] }]));
  fireEvent.click(screen.getByText("초안에서 확인할 부분"));
  expect(screen.getByText(/제공된 근거에서 찾지 못한 수치: 99%/)).toBeTruthy();
  expect(screen.getByText(/수정 후 저장하면 다시 점검/)).toBeTruthy();
});


describe("service introduction", () => {
  it.each([true, false])("requests an introduction with an existing draft: %s", async (existing) => {
    const onRedraft = vi.fn().mockResolvedValue(true);
    render(wrap(createElement(DraftPanel, { cid: 1, channel: "x", lang: "en", langs: ["en"], onLang: vi.fn(), drafts: existing ? [draft] : [], busy: false, onRedraft, showToast: vi.fn() })));
    fireEvent.click(screen.getByRole("button", { name: "서비스 처음 소개하기" }));
    await waitFor(() => expect(onRedraft).toHaveBeenCalledWith(undefined, true));
    if (existing) expect(screen.getByRole("button", { name: "다시 쓰기" })).toBeTruthy();
  });
  it("disables introduction while a request is in progress", () => {
    render(wrap(createElement(DraftPanel, { cid: 1, channel: "x", lang: "en", langs: ["en"], onLang: vi.fn(), drafts: [draft], busy: true, onRedraft: vi.fn(), showToast: vi.fn() })));
    expect((screen.getByRole("button", { name: "서비스 처음 소개하기" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

it("shows the saved purpose on an introduction draft", () => {
  render(panel([{ ...draft, purpose: "introduction" }]));
  expect(screen.getByText("서비스 소개")).toBeTruthy();
});
