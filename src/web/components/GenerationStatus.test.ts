// @vitest-environment jsdom
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { JobProgress } from "@shared/types";
import { GenerationStatus } from "./GenerationStatus";
const { resource, post } = vi.hoisted(() => ({ resource: { data: [] as JobProgress[], error: null as string | null, reload: vi.fn() }, post: vi.fn() }));
vi.mock("../lib/api", () => ({ useResource: () => resource, post }));
afterEach(() => { cleanup(); vi.useRealTimers(); resource.data = []; resource.error = null; vi.resetAllMocks(); });
const job: JobProgress = { id: 1, kind: "draft", candidateId: 3, channel: "x", lang: "en", executor: "server", status: "claimed", createdAt: 1 };
const tree = (onChange = vi.fn()) => createElement(MemoryRouter, null, createElement(GenerationStatus, { candidateId: 3, onChange }));
it("shows persisted running state on mount and polls after an SSE gap", () => {
  vi.useFakeTimers(); resource.data = [job]; const onChange = vi.fn(); const view = render(tree(onChange));
  expect(screen.getByText("진행 중")).toBeTruthy();
  act(() => vi.advanceTimersByTime(5000)); expect(resource.reload).toHaveBeenCalledOnce();
  resource.data = [{ ...job, status: "done" }]; view.rerender(tree(onChange));
  expect(screen.getByText("생성 작업이 완료됐어요")).toBeTruthy(); expect(onChange).toHaveBeenCalledTimes(2);
});
it("retries a failed job and keeps errors visible when retry fails", async () => {
  resource.data = [{ ...job, status: "failed", error: "사용 한도" }]; post.mockRejectedValue(new Error("offline"));
  render(tree()); fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("offline"));
  expect(post).toHaveBeenCalledWith("/jobs/1/retry"); expect(screen.getByText("사용 한도")).toBeTruthy();
});
it("explains when a local worker must be started", () => {
  resource.data = [{ ...job, executor: "local", status: "pending" }]; render(tree());
  expect(screen.getByText("로컬 워커 대기")).toBeTruthy();
  expect(screen.getByRole("link", { name: "실행 방법" }).getAttribute("href")).toBe("/settings?tab=model");
});
