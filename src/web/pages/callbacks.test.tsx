// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AuthCallback from "./AuthCallback";
import GithubSetup from "./GithubSetup";

const mocks = vi.hoisted(() => ({ exchange: vi.fn(), api: vi.fn() }));
vi.mock("../lib/auth/manager", () => ({ getAuthManager: () => ({ exchangeCode: mocks.exchange }) }));
vi.mock("../lib/api", () => ({ api: mocks.api }));
function mount(element: React.ReactNode) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[window.location.pathname]}>
        <Routes>
          <Route path="/auth/callback" element={element} />
          <Route path="/github/setup" element={element} />
          <Route path="/" element={<p>sign-in home</p>} />
          <Route path="/connectors" element={<p>connections home</p>} />
          <Route path="/github/pick" element={<p>repository picker</p>} />
        </Routes>
      </MemoryRouter>
    </StrictMode>,
  );
}
beforeEach(() => {
  mocks.exchange.mockReset();
  mocks.api.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("exchanges a single-use OAuth code once under StrictMode and removes it from the address", async () => {
  let done!: () => void;
  mocks.exchange.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        done = resolve;
      }),
  );
  window.history.replaceState(null, "", "/auth/callback?code=single-use-code");
  mount(<AuthCallback />);
  expect(mocks.exchange).toHaveBeenCalledExactlyOnceWith("single-use-code");
  expect(window.location.search).not.toContain("code");
  await act(async () => done());
  expect(await screen.findByText("sign-in home")).toBeTruthy();
});
it("offers a fresh sign-in after failed code exchange", async () => {
  mocks.exchange.mockRejectedValue(new Error("consumed code"));
  window.history.replaceState(null, "", "/auth/callback?code=single-use-code");
  mount(<AuthCallback />);
  fireEvent.click(await screen.findByRole("link", { name: "로그인 화면으로" }));
  expect(screen.getByText("sign-in home")).toBeTruthy();
  expect(mocks.exchange).toHaveBeenCalledTimes(1);
});
it("submits GitHub installation proof once and waits for the repository picker", async () => {
  vi.useFakeTimers();
  mocks.api.mockResolvedValue({ account: "fixture", repos: ["fixture/repo"] });
  window.history.replaceState(null, "", "/github/setup?installation_id=123&code=once&state=bound");
  mount(<GithubSetup />);
  await act(async () => {});
  expect(mocks.api).toHaveBeenCalledExactlyOnceWith("/github/setup?installation_id=123&code=once&state=bound");
  expect(window.location.search).toBe("?installation_id=123");
  await act(async () => vi.advanceTimersByTime(700));
  expect(screen.getByText("repository picker")).toBeTruthy();
});
it("keeps a clear recovery route after installation proof is rejected", async () => {
  mocks.api.mockRejectedValue(new Error("proof rejected"));
  window.history.replaceState(null, "", "/github/setup?installation_id=123&code=once&state=bound");
  mount(<GithubSetup />);
  await waitFor(() => expect(screen.getByText("연결 실패: proof rejected")).toBeTruthy());
  fireEvent.click(screen.getByRole("link", { name: "연결 관리로 돌아가기" }));
  expect(screen.getByText("connections home")).toBeTruthy();
});
