// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { AccountWorkspace, WorkspacePicker } from "./AccountWorkspace";
const { api, rememberWorkspace } = vi.hoisted(() => ({ api: vi.fn(), rememberWorkspace: vi.fn() }));
vi.mock("../lib/api", () => ({
  api,
  ApiError: class extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
}));
vi.mock("../lib/workspaces", () => ({ rememberWorkspace }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("pins the resolved workspace before mounting content and ignores a response after account unmount", async () => {
  let resolve!: (value: unknown) => void;
  api.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const child = vi.fn(() => <div>Content</div>);
  const view = render(<AccountWorkspace>{child}</AccountWorkspace>);
  expect(child).not.toHaveBeenCalled();
  const account = {
    accountId: "issuer|root",
    ownerId: "issuer|old",
    workspaces: [{ ownerId: "issuer|old", primary: false, hasData: true }],
  };
  await act(async () => resolve(account));
  await waitFor(() => expect(screen.getByText("Content")).toBeTruthy());
  expect(rememberWorkspace).toHaveBeenCalledWith(account.accountId, account.ownerId);
  view.unmount();
  rememberWorkspace.mockClear();
  const other = render(<AccountWorkspace>{child}</AccountWorkspace>);
  other.unmount();
  await act(async () => resolve(account));
  expect(rememberWorkspace).not.toHaveBeenCalled();
});
it("shows both spaces and their data state with an accessible selector", () => {
  render(
    <WorkspacePicker
      account={{
        accountId: "issuer|root",
        ownerId: "issuer|old",
        workspaces: [
          { ownerId: "issuer|root", primary: true, hasData: false },
          { ownerId: "issuer|old", primary: false, hasData: true },
        ],
      }}
    />,
  );
  expect(screen.getByRole("combobox")).toBeTruthy();
  expect(screen.getAllByRole("option")).toHaveLength(2);
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("issuer|old");
});

it("validates a navigation choice before pinning it, and recovers a revoked selection", async () => {
  window.history.replaceState(null, "", "/?workspace=issuer%7Cold");
  const account = {
    accountId: "issuer|root",
    ownerId: "issuer|root",
    workspaces: [{ ownerId: "issuer|root", primary: true, hasData: true }],
  };
  api.mockRejectedValueOnce(new ApiError("revoked", 403)).mockResolvedValueOnce(account);
  render(<AccountWorkspace>{() => <div>Recovered</div>}</AccountWorkspace>);
  await screen.findByText("Recovered");
  expect(api).toHaveBeenNthCalledWith(1, "/me", { headers: { "X-Somun-Workspace": "issuer|old" } });
  expect(api).toHaveBeenNthCalledWith(2, "/me", { headers: { "X-Somun-Workspace": "" } });
  expect(rememberWorkspace).toHaveBeenCalledWith("issuer|root", "issuer|root");
  expect(window.location.search).toBe("");
});
