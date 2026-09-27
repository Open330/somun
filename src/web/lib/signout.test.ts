// @vitest-environment jsdom
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "../App";

const { endSession, auth } = vi.hoisted(() => ({ endSession: vi.fn(), auth: { enabled: false } }));
vi.mock("./api", () => ({
  api: vi.fn().mockResolvedValue({}), endSession,
  legacyToken: () => null, startSession: vi.fn(), UNAUTHORIZED_EVENT: "test-unauthorized",
  useResource: () => ({ data: undefined }),
}));
vi.mock("./auth/context", () => ({ useAuth: () => auth }));
vi.mock("../pages/Inbox", () => ({ default: () => createElement("p", null, "Signed-in workspace") }));
vi.mock("../pages/Landing", () => ({ default: () => createElement("p", null, "Signed-out landing") }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("keeps the workspace after failed logout and allows a successful retry", async () => {
  endSession.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
  render(createElement(MemoryRouter, null, createElement(App)));
  await screen.findByText("Signed-in workspace");
  fireEvent.click(screen.getAllByRole("button", { name: "나가기" })[0]);
  await screen.findByRole("alert");
  expect(screen.getByText("Signed-in workspace")).toBeTruthy();
  expect(screen.queryByText("Signed-out landing")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "로그아웃 다시 시도" }));
  await screen.findByText("Signed-out landing");
  expect(endSession).toHaveBeenCalledTimes(2);
});

it("disables desktop and mobile logout controls while the request is pending", async () => {
  let finish!: () => void;
  endSession.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  render(createElement(MemoryRouter, null, createElement(App)));
  await screen.findByText("Signed-in workspace");
  fireEvent.click(screen.getAllByRole("button", { name: "나가기" })[0]);
  const buttons = screen.getAllByRole("button", { name: "로그아웃 중…" });
  expect(buttons).toHaveLength(2);
  expect(buttons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  finish();
  await waitFor(() => expect(screen.getByText("Signed-out landing")).toBeTruthy());
  expect(endSession).toHaveBeenCalledOnce();
});
