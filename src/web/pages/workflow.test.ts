// @vitest-environment jsdom
import { createElement } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Draft, SettingsView } from "../../shared/types";
import { DEFAULT_SETTINGS } from "../../app/settings";
import Inbox from "./Inbox";
import DraftPanel from "./candidate/DraftPanel";
import Candidate from "./Candidate";
import Connectors from "./Connectors";
import ProfileBlock from "./candidate/ProfileBlock";

const { resources, post } = vi.hoisted(() => ({
  resources: new Map<string, { data?: unknown; error?: string; reload: () => void }>(),
  post: vi.fn(),
}));
vi.mock("../lib/api", () => ({
  useResource: (path: string) => resources.get(path) ?? { reload() {} },
  post,
  patch: vi.fn(),
  del: vi.fn(),
}));
vi.mock("../lib/auth/context", () => ({ useAuth: () => ({ user: null }) }));
const set = (path: string, data: unknown) => resources.set(path, { data, reload: vi.fn() });
const wrap = (component: ReturnType<typeof createElement>) =>
  createElement(RouterProvider, { router: createMemoryRouter([{ path: "*", element: component }]) });
beforeEach(() => {
  resources.clear();
  post.mockReset().mockResolvedValue({});
  set("/candidates", []);
  set("/sources", []);
  set("/settings", { ...DEFAULT_SETTINGS, llm: { ...DEFAULT_SETTINGS.llm, apiKeySet: false } } as SettingsView);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("shows an actionable authentication failure instead of the raw server error", () => {
  set("/connectors", { github: { installations: [] }, sessions: { sessionCount14d: 0 } });
  set("/sources", [
    {
      id: 1,
      kind: "github",
      targets: ["me/tool"],
      enabled: true,
      lastError: "No GitHub token. Install the GitHub App or set GITHUB_TOKEN.",
    },
  ]);
  set("/github/app", { configured: true, installUrl: "https://github.com/apps/test/installations/new" });
  render(wrap(createElement(Connectors)));
  expect(screen.getByText(/GitHub 인증이 필요합니다/)).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "GitHub 연결하기 →" }).length).toBeGreaterThan(0);
  expect(screen.queryByText(/No GitHub token/)).toBeNull();
});

it("explains which profile edits survive regeneration and links back to the source", () => {
  render(
    wrap(
      createElement(ProfileBlock, {
        repo: "me/tool",
        showToast: vi.fn(),
        view: {
          repo: "me/tool",
          model: "m",
          updatedAt: 1,
          editedFields: ["limitations"],
          profile: {
            what: "A tool",
            audience: "Developers",
            why: "",
            claims: [],
            limitations: ["A user-edited limitation"],
            avoid: [],
            stage: "beta",
            naming: "tool",
          },
        },
      }),
    ),
  );
  expect(screen.getByText("직접 수정한 항목: 한계")).toBeTruthy();
  expect(screen.getByText(/이 값은 다시 생성해도 유지되며/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "README 원자료 확인 ↗" }).getAttribute("href")).toBe("https://github.com/me/tool#readme");
  expect(screen.getByText(/기존 초안은 다시 검토하거나 다시 써 주세요/)).toBeTruthy();
});

describe("first useful outcome", () => {
  it("offers a concrete first step instead of empty draft sections", () => {
    render(wrap(createElement(Inbox)));
    expect(screen.getByRole("link", { name: /첫 소스 연결하기/ }).getAttribute("href")).toBe("/connectors");
    expect(screen.queryByText("검수할 초안이 없습니다")).toBeNull();
    expect(screen.getByLabelText("초안 완성 예시")).toBeTruthy();
  });
  it("shows missing channel and model setup before the first generation", () => {
    set("/settings", { ...DEFAULT_SETTINGS, channelLangs: {}, llm: { ...DEFAULT_SETTINGS.llm, credentialsConfigured: false } });
    render(wrap(createElement(Inbox)));
    expect(screen.getByRole("link", { name: "초안을 만들 채널과 언어 선택 →" }).getAttribute("href")).toBe("/settings?tab=channels");
    expect(screen.getByRole("link", { name: "초안 생성 모델 연결 →" }).getAttribute("href")).toBe("/settings?tab=model");
  });
  it("directs draft preparation to channel setup without sending an empty request", async () => {
    set("/settings", { ...DEFAULT_SETTINGS, channelLangs: {} });
    set("/candidates", [{ id: 1, repo: "a/b", title: "A change", type: "release", status: "new", updatedAt: Date.now(), evidence: {} }]);
    render(wrap(createElement(Inbox)));
    fireEvent.click(screen.getByRole("button", { name: /^초안 준비$/ }));
    expect(screen.getByRole("alert").textContent).toContain("채널과 언어");
    expect(screen.getByRole("link", { name: "채널 선택하기" }).getAttribute("href")).toBe("/settings?tab=channels");
    expect(post).not.toHaveBeenCalled();
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
    set("/candidates", [
      {
        id: 1,
        title: "A change",
        repo: "a/x",
        type: "release",
        status: "judged",
        latestJudgmentId: 1,
        evidence: { highlightsAt: 1 },
        updatedAt: Date.now(),
        judgment: { total: 2, decision: "ask", reasoning: "More evidence needed" },
      },
    ]);
    render(wrap(createElement(Inbox)));
    expect(screen.getByText("추가 근거 필요")).toBeTruthy();
    expect(screen.queryByText("초안 작성 중")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "missing" } });
    expect(screen.getByText("검색 결과가 없어요")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "전체 글감 보기" }));
    expect(screen.getByRole("link", { name: "A change" })).toBeTruthy();
  });
});

const draft: Draft = {
  id: 1,
  candidateId: 1,
  channel: "x",
  lang: "en",
  version: 1,
  body: "Original draft",
  status: "proposed",
  lint: [],
  model: "test",
  createdAt: 1,
  updatedAt: 1,
};
const panel = (drafts = [draft]) =>
  wrap(
    createElement(DraftPanel, {
      cid: 1,
      channel: "x",
      lang: "en",
      langs: ["en"],
      onLang: vi.fn(),
      drafts,
      busy: false,
      onRedraft: async () => true,
      showToast: vi.fn(),
    }),
  );

it("shows the selected version's length and lint instead of the newest version's results", () => {
  render(
    panel([
      { ...draft, body: "a".repeat(405), lint: [{ rule: "length", ok: false, detail: "405/280" }] },
      { ...draft, id: 2, version: 2, body: "a".repeat(121), lint: [{ rule: "length", ok: true, detail: "121/280" }] },
    ]),
  );
  expect(screen.getByText("121 / 280자")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("버전"), { target: { value: "1" } });
  expect(screen.getByText("405 / 280자")).toBeTruthy();
  expect(screen.queryByText("형식 점검 통과")).toBeNull();
  expect(screen.getByText("405/280")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "현재 판으로" }));
  expect(screen.getByText("121 / 280자")).toBeTruthy();
  expect(screen.getByText("형식 점검 통과")).toBeTruthy();
});
describe("draft to publication", () => {
  it("lets users register an already-published post without copying first", async () => {
    render(panel());
    fireEvent.change(screen.getByRole("textbox", { name: /게시글 링크/ }), { target: { value: "https://example.test/post" } });
    fireEvent.click(screen.getByRole("button", { name: "게시 링크 저장" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/publications", expect.objectContaining({ url: "https://example.test/post", draftId: 1 })),
    );
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
    render(
      wrap(
        createElement(DraftPanel, {
          cid: 1,
          channel: "x",
          lang: "en",
          langs: ["en"],
          onLang: vi.fn(),
          drafts: [linked],
          busy: false,
          onRedraft: async () => true,
          showToast: vi.fn(),
          homepage: "https://somun.jiun.dev",
        }),
      ),
    );
    expect(screen.getByText(/utm_source=x/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "초안 복사" })));
    expect(writeText).toHaveBeenCalledWith("Try it: https://somun.jiun.dev/?utm_source=x&utm_medium=social&utm_campaign=somun");
    expect(post).toHaveBeenCalledWith("/drafts/1/edit", expect.objectContaining({ body: "Try it: https://somun.jiun.dev/" }));
  });
  it("does not claim copying succeeded when the clipboard is denied", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    render(panel());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "초안 복사" })));
    expect(screen.getByRole("alert").textContent).toContain("복사하지 못했습니다");
    expect(post).not.toHaveBeenCalled();
  });
});

it("blocks browser back navigation until unsaved edits are explicitly discarded", async () => {
  const router = createMemoryRouter(
    [
      { path: "/before", element: createElement("p", null, "Previous page") },
      {
        path: "/edit",
        element: createElement(DraftPanel, {
          cid: 1,
          channel: "x",
          lang: "en",
          langs: ["en"],
          onLang: vi.fn(),
          drafts: [draft],
          busy: false,
          onRedraft: async () => true,
          showToast: vi.fn(),
        }),
      },
    ],
    { initialEntries: ["/before", "/edit"], initialIndex: 1 },
  );
  render(createElement(RouterProvider, { router }));
  fireEvent.click(screen.getByRole("button", { name: "수정" }));
  fireEvent.change(screen.getByRole("textbox", { name: "초안 본문" }), { target: { value: "Keep this edit" } });
  await act(async () => {
    await router.navigate(-1);
  });
  fireEvent.click(screen.getByRole("button", { name: "계속 수정" }));
  expect((screen.getByRole("textbox", { name: "초안 본문" }) as HTMLTextAreaElement).value).toBe("Keep this edit");
  expect(router.state.location.pathname).toBe("/edit");
  await act(async () => {
    await router.navigate(-1);
  });
  fireEvent.click(screen.getByRole("button", { name: "수정 내용 버리고 이동" }));
  await waitFor(() => expect(screen.getByText("Previous page")).toBeTruthy());
});

it("shows actionable evidence warnings without requiring hover", () => {
  render(
    panel([
      {
        ...draft,
        lint: [{ rule: "numbers_need_review", ok: false, detail: "제공된 근거에서 찾지 못한 수치: 99%. 원문과 단위를 확인해 주세요." }],
      },
    ]),
  );
  fireEvent.click(screen.getByText("초안에서 확인할 부분"));
  expect(screen.getByText(/제공된 근거에서 찾지 못한 수치: 99%/)).toBeTruthy();
  expect(screen.getByText(/수정 후 저장하면 다시 점검/)).toBeTruthy();
});

describe("service introduction", () => {
  it.each([true, false])("requests an introduction with an existing draft: %s", async (existing) => {
    const onRedraft = vi.fn().mockResolvedValue(true);
    render(
      wrap(
        createElement(DraftPanel, {
          cid: 1,
          channel: "x",
          lang: "en",
          langs: ["en"],
          onLang: vi.fn(),
          drafts: existing ? [draft] : [],
          busy: false,
          onRedraft,
          showToast: vi.fn(),
        }),
      ),
    );
    // 초안이 있으면 드물게 쓰는 동작이라 초안 메뉴에 둔다. 초안이 없으면 바로 보이는 버튼이다.
    if (existing) fireEvent.click(screen.getByRole("button", { name: "더 보기" }));
    fireEvent.click(screen.getByRole(existing ? "menuitem" : "button", { name: "서비스 처음 소개하기" }));
    await waitFor(() => expect(onRedraft).toHaveBeenCalledWith(undefined, true));
    if (existing) expect(screen.getByRole("button", { name: "다시 쓰기" })).toBeTruthy();
  });
  it("disables introduction while a request is in progress", () => {
    render(
      wrap(
        createElement(DraftPanel, {
          cid: 1,
          channel: "x",
          lang: "en",
          langs: ["en"],
          onLang: vi.fn(),
          drafts: [draft],
          busy: true,
          onRedraft: vi.fn(),
          showToast: vi.fn(),
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "더 보기" }));
    expect((screen.getByRole("menuitem", { name: "서비스 처음 소개하기" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

it("shows the saved purpose on an introduction draft", () => {
  render(panel([{ ...draft, purpose: "introduction" }]));
  expect(screen.getByText("서비스 소개")).toBeTruthy();
});

it("keeps language switching available on the published screen", () => {
  const onLang = vi.fn();
  render(
    wrap(
      createElement(DraftPanel, {
        cid: 1,
        channel: "x",
        lang: "en",
        langs: ["en", "ko"],
        onLang,
        drafts: [draft],
        publications: [{ id: 7, draftId: draft.id, url: "https://example.test/old" }],
        busy: false,
        onRedraft: vi.fn(),
        showToast: vi.fn(),
      }),
    ),
  );
  expect(screen.getByText("게시 기록을 남겼어요")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "KO" }));
  expect(onLang).toHaveBeenCalledWith("ko");
});

it("lets a new version be published while preserving the old version's publication", async () => {
  const publications = [{ id: 7, draftId: draft.id, url: "https://example.test/old" }];
  const newer = { ...draft, id: 2, version: 2, body: "New unpublished draft" };
  const props = {
    cid: 1,
    channel: "x" as const,
    lang: "en",
    langs: ["en"],
    onLang: vi.fn(),
    publications,
    busy: false,
    onRedraft: vi.fn(),
    showToast: vi.fn(),
  };
  const view = render(wrap(createElement(DraftPanel, { ...props, drafts: [draft] })));
  expect(screen.getByText("게시 기록을 남겼어요")).toBeTruthy();
  view.rerender(wrap(createElement(DraftPanel, { ...props, drafts: [draft, newer] })));
  expect(screen.getByText("New unpublished draft")).toBeTruthy();
  expect(screen.queryByText("이미 게시한 초안입니다.")).toBeNull();
  post.mockResolvedValue({ id: 8 });
  fireEvent.change(screen.getByRole("textbox", { name: /게시글 링크/ }), { target: { value: "https://example.test/new" } });
  fireEvent.click(screen.getByRole("button", { name: "게시 링크 저장" }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith("/publications", expect.objectContaining({ draftId: 2, url: "https://example.test/new" })),
  );
  expect(screen.getByRole("link", { name: "https://example.test/new" })).toBeTruthy();
  // A reload with both records must still match the latest draft, regardless of record order.
  view.rerender(
    wrap(
      createElement(DraftPanel, {
        ...props,
        drafts: [draft, newer],
        publications: [...publications, { id: 8, draftId: 2, url: "https://example.test/new" }],
      }),
    ),
  );
  expect(screen.getByRole("link", { name: "https://example.test/new" })).toBeTruthy();
});

it("does not apply an unlinked legacy publication to a new draft", () => {
  render(
    wrap(
      createElement(DraftPanel, {
        cid: 1,
        channel: "x",
        lang: "en",
        langs: ["en"],
        onLang: vi.fn(),
        drafts: [draft],
        publications: [{ id: 7, url: "https://example.test/legacy" }],
        busy: false,
        onRedraft: vi.fn(),
        showToast: vi.fn(),
      }),
    ),
  );
  expect(screen.getByRole("button", { name: "게시 링크 저장" })).toBeTruthy();
});

it("keeps partially published candidates in the review list", () => {
  set("/candidates", [
    {
      id: 1,
      title: "Other channel ready",
      repo: "a/b",
      type: "release",
      status: "published",
      unpublishedDraftCount: 1,
      evidence: {},
      updatedAt: Date.now(),
      judgment: null,
    },
  ]);
  render(wrap(createElement(Inbox)));
  expect(screen.getByRole("link", { name: "Other channel ready" })).toBeTruthy();
  expect(screen.getByText("검수 대기")).toBeTruthy();
  expect(screen.getByRole("link", { name: "초안 검토" })).toBeTruthy();
});

describe("inbox model setup preflight", () => {
  it.each(["missing-key", "settings-error"])("blocks generation and offers the correct recovery for %s", async (condition) => {
    set("/candidates", [{ id: 1, title: "A change", repo: "a/x", type: "release", status: "new", evidence: {}, updatedAt: Date.now() }]);
    if (condition === "missing-key")
      set("/settings", { ...DEFAULT_SETTINGS, llm: { ...DEFAULT_SETTINGS.llm, credentialsConfigured: false } });
    else resources.set("/settings", { error: "offline", reload: vi.fn() });
    render(wrap(createElement(Inbox)));
    fireEvent.click(screen.getByRole("button", { name: "초안 준비" }));
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "모델 설정" }).getAttribute("href")).toBe("/settings?tab=model");
    expect(screen.queryByRole("link", { name: "연결 확인" })).toBeNull();
    if (condition === "settings-error") {
      fireEvent.click(screen.getByRole("button", { name: "설정 다시 불러오기" }));
      expect(resources.get("/settings")!.reload).toHaveBeenCalledOnce();
    }
  });
});

describe("draft version and publication consistency", () => {
  it("saves to the version being edited when a generated version arrives", async () => {
    const view = render(panel());
    fireEvent.click(screen.getByRole("button", { name: "수정" }));
    fireEvent.change(screen.getByRole("textbox", { name: "초안 본문" }), { target: { value: "Edit of version one" } });
    view.rerender(panel([{ ...draft, id: 2, version: 2, body: "New generated version", updatedAt: 2 }, draft]));
    expect(screen.getByText("새 버전이 도착했습니다. 수정 내용은 편집을 시작한 v1에 저장됩니다.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "변경 저장" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/drafts/1/edit", expect.objectContaining({ body: "Edit of version one" })));
    expect(post).not.toHaveBeenCalledWith("/drafts/2/edit", expect.anything());
  });

  it("moves to a newly generated version after an earlier edit was saved", async () => {
    post.mockResolvedValue({ ...draft, body: "Saved edit", updatedAt: 2, status: "edited" });
    const view = render(panel());
    fireEvent.click(screen.getByRole("button", { name: "수정" }));
    fireEvent.change(screen.getByRole("textbox", { name: "초안 본문" }), { target: { value: "Saved edit" } });
    fireEvent.click(screen.getByRole("button", { name: "변경 저장" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "초안 본문" })).toBeNull());
    view.rerender(
      panel([
        { ...draft, id: 2, version: 2, body: "Rewritten version", updatedAt: 3 },
        { ...draft, body: "Saved edit", updatedAt: 2, status: "edited" },
      ]),
    );
    expect((screen.getByTitle("버전") as HTMLSelectElement).value).toBe("2");
    expect(screen.getByText("Rewritten version")).toBeTruthy();
  });

  it("records the publication against the older version that was edited and copied", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    post.mockImplementation(async (path: string) =>
      path === "/drafts/1/edit" ? { ...draft, body: "Edited v1", updatedAt: 2, status: "copied" } : { id: 9 },
    );
    const view = render(panel());
    fireEvent.click(screen.getByRole("button", { name: "수정" }));
    fireEvent.change(screen.getByRole("textbox", { name: "초안 본문" }), { target: { value: "Edited v1" } });
    view.rerender(panel([{ ...draft, id: 2, version: 2, body: "New generated version", updatedAt: 3 }, draft]));
    fireEvent.click(screen.getByRole("button", { name: "저장하고 복사" }));
    await waitFor(() => expect((screen.getByTitle("버전") as HTMLSelectElement).value).toBe("1"));
    fireEvent.change(screen.getByRole("textbox", { name: /게시글 링크/ }), { target: { value: "https://example.test/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "게시 링크 저장" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/publications", expect.objectContaining({ draftId: 1, url: "https://example.test/v1" })),
    );
  });

  it("keeps the edit and asks before overwriting a draft another tab saved first", async () => {
    post
      .mockRejectedValueOnce(Object.assign(new Error("conflict"), { status: 409 }))
      .mockResolvedValue({ ...draft, body: "My tab text", updatedAt: 3, status: "edited" });
    render(panel());
    fireEvent.click(screen.getByRole("button", { name: "수정" }));
    fireEvent.change(screen.getByRole("textbox", { name: "초안 본문" }), { target: { value: "My tab text" } });
    fireEvent.click(screen.getByRole("button", { name: "변경 저장" }));
    await screen.findByText("편집하는 사이 다른 곳에서 이 초안이 먼저 저장되었습니다. 입력한 내용은 그대로 있습니다.");
    expect(post).toHaveBeenLastCalledWith(
      "/drafts/1/edit",
      expect.objectContaining({ body: "My tab text", base: { title: undefined, body: "Original draft" } }),
    );
    expect((screen.getByRole("textbox", { name: "초안 본문" }) as HTMLTextAreaElement).value).toBe("My tab text");
    fireEvent.click(screen.getByRole("button", { name: "내 내용으로 덮어쓰기" }));
    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith("/drafts/1/edit", expect.objectContaining({ body: "My tab text", base: undefined })),
    );
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "초안 본문" })).toBeNull());
  });

  it("shows a corrected publication URL immediately after recording a publication", async () => {
    post.mockResolvedValue({ id: 7 });
    render(panel());
    fireEvent.change(screen.getByRole("textbox", { name: /게시글 링크/ }), { target: { value: "https://example.test/original" } });
    fireEvent.click(screen.getByRole("button", { name: "게시 링크 저장" }));
    await screen.findByRole("heading", { name: "게시 기록을 남겼어요" });
    fireEvent.click(screen.getByRole("button", { name: "링크 고치기" }));
    fireEvent.change(screen.getByRole("textbox", { name: "게시글 링크" }), { target: { value: "https://example.test/corrected" } });
    fireEvent.click(screen.getByRole("button", { name: "링크 저장" }));
    await screen.findByRole("link", { name: "https://example.test/corrected" });
    expect(screen.queryByRole("link", { name: "https://example.test/original" })).toBeNull();
  });

  it("opens the requested published version even when a newer unpublished version exists", async () => {
    render(
      wrap(
        createElement(DraftPanel, {
          cid: 1,
          channel: "x",
          lang: "en",
          langs: ["en"],
          onLang: vi.fn(),
          drafts: [{ ...draft, id: 2, version: 2, body: "New version" }, draft],
          publications: [{ id: 7, draftId: 1, url: "https://example.test/published" }],
          initialDraftId: 1,
          busy: false,
          onRedraft: async () => true,
          showToast: vi.fn(),
        }),
      ),
    );
    expect(screen.getByRole("heading", { name: "게시 기록을 남겼어요" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "초안 다시 보기" }));
    expect((screen.getByTitle("버전") as HTMLSelectElement).value).toBe("1");
    expect(screen.getByText("Original draft")).toBeTruthy();
  });
});

it.each([
  ["done", "X, 자동 점검에서 확인할 부분이 있습니다"],
  ["claimed", "X, 쓰는 중"],
  ["failed", "X, 생성 상태를 확인해 주세요"],
])("keeps channel status icons accessible when the job is %s", async (status, label) => {
  set("/jobs/status?candidateId=1", [{ id: 9, candidateId: 1, kind: "draft", channel: "x", lang: "en", executor: "server", status }]);
  set("/settings", { ...DEFAULT_SETTINGS, channelLangs: { x: ["en"], linkedin: ["ko"], show_hn: ["en"] } } as SettingsView);
  set("/keys", []);
  set("/candidates/1", {
    candidate: {
      id: 1,
      title: "A change",
      repo: "a/b",
      type: "release",
      status: "drafted",
      evidence: { repo: "a/b", repoUrl: "https://example.test/a/b" },
      latestJudgmentId: null,
      createdAt: 1,
      updatedAt: 1,
    },
    judgments: [],
    drafts: [
      { ...draft, lint: [{ rule: "no_exclamation", ok: false, detail: "Remove !" }] },
      { ...draft, id: 2, channel: "linkedin", lang: "ko", lint: [{ rule: "has_link", ok: true }] },
    ],
    publications: [],
    signals: [],
    told: [],
    consistency: [],
  });
  render(
    createElement(RouterProvider, {
      router: createMemoryRouter([{ path: "/c/:id", element: createElement(Candidate) }], { initialEntries: ["/c/1"] }),
    }),
  );
  await waitFor(() => expect(screen.getByRole("button", { name: label })).toBeTruthy());
  expect(screen.getByRole("button", { name: /LinkedIn, 초안 준비됨/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Show HN, 초안 없음" })).toBeTruthy();
  expect(screen.getByRole("button", { name: label }).getAttribute("title")).toBe(label.slice(3));
  expect(screen.queryByText("생성 작업이 완료됐어요")).toBeNull();
});
