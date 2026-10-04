// @vitest-environment jsdom
import { MemoryRouter, Link, useLocation } from "react-router-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JobProgress, ModelAvailability } from "@shared/types";
import { openWorkspaceStatus, useWorkspaceStatus, WorkStatusButton, WorkStatusPanel } from "./WorkspaceStatus";
const { jobs, availability, post } = vi.hoisted(() => ({
  jobs: { data: [] as JobProgress[], error: null as string | null, reload: vi.fn() },
  availability: { data: undefined as ModelAvailability | undefined, error: null as string | null, reload: vi.fn() },
  post: vi.fn(),
}));
vi.mock("../lib/api", () => ({ useResource: (path: string) => (path === "/jobs/status" ? jobs : availability), post }));
beforeEach(() => {
  jobs.data = [];
  jobs.error = null;
  availability.error = null;
  availability.data = {
    mode: "shared",
    checkedAt: Date.now(),
    models: [
      { purpose: "analysis", model: "base", state: "ready" },
      { purpose: "draft", model: "draft", state: "waiting", retryAt: Date.now() + 60000 },
    ],
  };
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function () {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function () {
      this.removeAttribute("open");
    },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});
const job: JobProgress = {
  id: 1,
  kind: "draft",
  candidateId: 3,
  channel: "linkedin",
  lang: "ko",
  executor: "server",
  status: "claimed",
  createdAt: Date.now(),
};
function App() {
  const state = useWorkspaceStatus();
  const location = useLocation();
  return (
    <>
      <WorkStatusButton state={state} />
      <WorkStatusPanel state={state} candidates={[]} />
      <Link to="/settings">설정으로</Link>
      <span>{location.pathname}</span>
    </>
  );
}
const mount = () =>
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
it("keeps running work visible across navigation and remount, grouping stages while retaining failures", () => {
  jobs.data = [
    job,
    { ...job, id: 2, kind: "digest", status: "done" },
    { ...job, id: 3, channel: "x", status: "failed", error: "provider failure" },
  ];
  const view = mount();
  expect(screen.getByRole("button", { name: /작업/ }).textContent).toContain("진행 1 · 실패 1");
  fireEvent.click(screen.getByText("설정으로"));
  expect(screen.getByText("/settings")).toBeTruthy();
  expect(screen.getByRole("button", { name: /작업/ }).textContent).toContain("초안 작성 · LinkedIn KO");
  fireEvent.click(screen.getByRole("button", { name: /작업/ }));
  expect(screen.getByRole("dialog", { name: "내 계정 작업" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "결과 보기" }).getAttribute("href")).toBe("/c/3");
  expect(screen.getByText("provider failure")).toBeTruthy();
  view.unmount();
  mount();
  expect(screen.getByRole("button", { name: /작업/ }).textContent).toContain("초안 작성 · LinkedIn KO");
});
it("refreshes persisted state while work runs even with the panel closed, and rechecks expired model cooldowns", () => {
  vi.useFakeTimers();
  jobs.data = [job];
  const view = mount();
  act(() => vi.advanceTimersByTime(5000));
  expect(jobs.reload).toHaveBeenCalledOnce();
  expect(availability.reload).toHaveBeenCalledOnce();
  jobs.data = [{ ...job, status: "done", finishedAt: Date.now() }];
  availability.data!.models[1] = { purpose: "draft", model: "draft", state: "ready" };
  view.rerender(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
  act(() => vi.advanceTimersByTime(5000));
  expect(jobs.reload).toHaveBeenCalledOnce();
});
it("opens from the compact page notice, reports retry errors, and closes without hiding persisted work", async () => {
  jobs.data = [{ ...job, status: "failed", error: "quota" }];
  post.mockRejectedValue(new Error("offline"));
  mount();
  act(() => {
    openWorkspaceStatus();
  });
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("offline"));
  expect(post).toHaveBeenCalledWith("/jobs/1/retry");
  fireEvent.click(screen.getByRole("button", { name: "닫기" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: /작업/ }).textContent).toContain("실패 1");
});
it("never renders cached availability as current after a failed refresh and offers a retry", () => {
  availability.error = "offline";
  mount();
  fireEvent.click(screen.getByRole("button", { name: /작업/ }));
  expect(screen.getByText("모델 이용 상태를 확인하지 못했습니다.")).toBeTruthy();
  expect(
    screen.queryByText("공유 모델의 현재 요청 가능 여부입니다. 계정별 남은 횟수가 아니며 제공사 응답에 따라 달라질 수 있습니다."),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "상태 다시 확인" }));
  expect(availability.reload).toHaveBeenCalledOnce();
});
