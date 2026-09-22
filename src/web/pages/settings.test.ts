// @vitest-environment jsdom
import { createElement } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../app/settings";
import type { SettingsView } from "../../shared/types";
import Settings from "./Settings";

const { resource, patch, api, post } = vi.hoisted(() => ({ resource: { data: undefined as unknown, error: null as string | null, reload: vi.fn() }, patch: vi.fn(), api: vi.fn(), post: vi.fn() }));
vi.mock("../lib/api", () => ({ useResource: (path: string) => path === "/settings" ? resource : { data: [] }, patch, api, post }));
const initial = (): SettingsView => ({ ...structuredClone(DEFAULT_SETTINGS), notify: undefined, llm: { ...DEFAULT_SETTINGS.llm, apiKeySet: false } });
function setup(tab = "model") {
  const router = createMemoryRouter([{ path: "/settings", element: createElement(Settings) }], { initialEntries: [`/settings?tab=${tab}`] });
  const tree = () => createElement(RouterProvider, { router });
  render(tree());
  return { router, refresh: () => act(async () => { await router.navigate(router.state.location.pathname + router.state.location.search, { replace: true }); }) };
}
beforeEach(() => { resource.data = initial(); resource.error = null; vi.resetAllMocks(); patch.mockResolvedValue(initial()); });
afterEach(cleanup);
const value = (name: string) => (screen.getByLabelText(name) as HTMLInputElement).value;

it("preserves unsaved model and judgment inputs across background updates and tab changes", async () => {
  const { refresh } = setup();
  fireEvent.change(screen.getByLabelText("분석 모델 (다이제스트·판단)"), { target: { value: "my-model" } });
  fireEvent.click(screen.getByRole("button", { name: "판단" }));
  fireEvent.change(screen.getByLabelText("금지 표현"), { target: { value: "my phrase" } });
  resource.data = { ...initial(), bannedPhrases: ["background"], llm: { ...initial().llm, model: "remote-model" } };
  await refresh();
  expect(value("금지 표현")).toBe("my phrase");
  fireEvent.click(screen.getByRole("button", { name: "모델 · 키" }));
  expect(value("분석 모델 (다이제스트·판단)")).toBe("my-model");
});

it("keeps inputs visible when a background fetch fails", async () => {
  const { refresh } = setup();
  fireEvent.change(screen.getByLabelText("분석 모델 (다이제스트·판단)"), { target: { value: "keep-me" } });
  resource.error = "offline"; await refresh();
  expect(value("분석 모델 (다이제스트·판단)")).toBe("keep-me");
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(resource.reload).toHaveBeenCalledOnce();
});

it("prevents duplicate saves and applies the response even if SSE arrives before it", async () => {
  let resolve!: (value: SettingsView) => void;
  patch.mockImplementation(() => new Promise<SettingsView>((done) => { resolve = done; }));
  const { refresh } = setup();
  fireEvent.change(screen.getByLabelText("분석 모델 (다이제스트·판단)"), { target: { value: "new-model" } });
  fireEvent.change(screen.getByLabelText("API 키 (비우면 서버 키)"), { target: { value: "test-input" } });
  const save = screen.getByRole("button", { name: "저장" });
  fireEvent.click(save); fireEvent.click(save);
  expect(patch).toHaveBeenCalledOnce();
  resource.data = initial(); await refresh();
  await act(async () => resolve({ ...initial(), llm: { ...initial().llm, model: "new-model", apiKeySet: true, apiKeyHint: "nput" } }));
  expect(value("분석 모델 (다이제스트·판단)")).toBe("new-model");
  expect(value("API 키 (비우면 서버 키)")).toBe("");
  expect(screen.getByText("저장했습니다")).toBeTruthy();
});

it("retains model input on save failure and allows retry", async () => {
  patch.mockRejectedValueOnce(new Error("offline"));
  setup();
  fireEvent.change(screen.getByLabelText("분석 모델 (다이제스트·판단)"), { target: { value: "retry-model" } });
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("offline"));
  expect(value("분석 모델 (다이제스트·판단)")).toBe("retry-model");
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
});

it("keeps tab navigation in the URL and follows browser history", async () => {
  const { router } = setup("channels");
  fireEvent.click(screen.getByRole("button", { name: "모델 · 키" }));
  expect(router.state.location.search).toBe("?tab=model");
  await act(async () => { await router.navigate(-1); });
  expect(screen.getByRole("button", { name: "채널" }).getAttribute("aria-pressed")).toBe("true");
});

it.each(["export", "delete"])("shows recoverable account %s errors", async (action) => {
  api.mockRejectedValue(new Error("offline")); post.mockRejectedValue(new Error("offline"));
  setup("account");
  if (action === "delete") fireEvent.change(screen.getByLabelText("계정 데이터 삭제 확인"), { target: { value: "삭제" } });
  fireEvent.click(screen.getByRole("button", { name: action === "export" ? "JSON 내려받기" : "모두 삭제" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("작업을 완료하지 못했습니다"));
  if (action === "delete") expect(value("계정 데이터 삭제 확인")).toBe("삭제");
});
