// @vitest-environment jsdom
import { createElement } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../app/settings";
import Candidate from "./Candidate";

const { resources, failures, reload, post } = vi.hoisted(() => ({ resources: new Map<string, unknown>(), failures: new Map<string, string>(), reload: vi.fn(), post: vi.fn() }));
vi.mock("../lib/api", async () => {
  const { useReducer } = await import("react");
  return { useResource: (path: string) => {
    const [, refresh] = useReducer((n: number) => n + 1, 0);
    return { data: resources.get(path), error: failures.get(path), reload: () => { reload(); refresh(); } };
  }, post };
});
vi.mock("../components/GenerationStatus", () => ({ GenerationStatus: () => null }));
vi.mock("./candidate/ProfileBlock", () => ({ default: () => null }));
vi.mock("./candidate/VideoBlock", () => ({ default: () => null }));
vi.mock("./candidate/LaunchCheckBlock", () => ({ default: () => null }));
vi.mock("./candidate/DraftPanel", () => ({ default: ({ channel, lang, onLang }: { channel: string; lang: string; onLang: (lang: string) => void }) => createElement("button", { onClick: () => onLang("en") }, `Selected ${channel}:${lang}`) }));
afterEach(() => { cleanup(); resources.clear(); failures.clear(); vi.clearAllMocks(); });

it("opens the latest unpublished target across channels and preserves a manual language selection on refresh", async () => {
  resources.set("/settings", { ...DEFAULT_SETTINGS, channelLangs: { x: ["en", "ko"], linkedin: ["en", "ko"] } });
  const data = {
    candidate: { id: 1, title: "Test", type: "release", status: "published", evidence: { repo: "a/b", repoUrl: "https://example.test" } },
    judgments: [], consistency: [], told: [],
    drafts: [
      { id: 1, channel: "x", lang: "en", version: 1, status: "proposed", lint: [] },
      { id: 2, channel: "x", lang: "en", version: 2, status: "proposed", lint: [] },
      { id: 3, channel: "x", lang: "ko", version: 1, status: "dropped", lint: [] },
      { id: 4, channel: "linkedin", lang: "ko", version: 1, status: "proposed", lint: [] },
    ],
    publications: [{ id: 1, draftId: 2, channel: "x", lang: "en", url: "https://example.test/post", publishedAt: 1 }],
  };
  resources.set("/candidates/1", data);
  const router = createMemoryRouter([{ path: "/c/:id", element: createElement(Candidate) }], { initialEntries: ["/c/1"] });
  const view = render(createElement(RouterProvider, { router }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Selected linkedin:ko" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Selected linkedin:ko" }));
  resources.set("/candidates/1", { ...data });
  view.rerender(createElement(RouterProvider, { router }));
  expect(screen.getByRole("button", { name: "Selected linkedin:en" })).toBeTruthy();
});

const seedDetail = () => resources.set("/candidates/1", {
  candidate: { id: 1, title: "Test", type: "release", status: "drafted", evidence: { repo: "a/b", repoUrl: "https://example.test" } },
  judgments: [], consistency: [], told: [], publications: [],
  drafts: [{ id: 1, channel: "x", lang: "ko", version: 1, status: "proposed", lint: [] }],
});
const renderDetail = () => {
  const router = createMemoryRouter([{ path: "/c/:id", element: createElement(Candidate) }], { initialEntries: ["/c/1"] });
  return { router, view: render(createElement(RouterProvider, { router })) };
};

it("keeps an existing draft visible when settings fail and lets the user reload settings", async () => {
  seedDetail(); failures.set("/settings", "offline");
  renderDetail();
  await waitFor(() => expect(screen.getByRole("button", { name: "Selected x:ko" })).toBeTruthy());
  expect(screen.getByRole("alert").textContent).toContain("설정을 불러오지 못했습니다");
  failures.clear(); resources.set("/settings", DEFAULT_SETTINGS);
  fireEvent.click(screen.getByRole("button", { name: "설정 다시 불러오기" }));
  expect(reload).toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Selected x:ko" })).toBeTruthy();
});

it.each(["missing-key", "settings-error"])("prevents reanalysis with %s", async (condition) => {
  seedDetail();
  if (condition === "missing-key") resources.set("/settings", { ...DEFAULT_SETTINGS, llm: { ...DEFAULT_SETTINGS.llm, credentialsConfigured: false } });
  else failures.set("/settings", "offline");
  renderDetail();
  fireEvent.click(screen.getByRole("button", { name: "더 보기" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "다시 분석하기" }));
  await waitFor(() => expect(screen.getAllByRole("alert").some((el) => el.textContent?.includes("모델 설정"))).toBe(true));
  expect(post).not.toHaveBeenCalled();
});
