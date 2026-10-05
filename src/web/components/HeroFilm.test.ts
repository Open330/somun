// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import HeroFilm from "./HeroFilm";
import { loadCatalog, setLocale } from "../i18n";

beforeEach(() => setLocale("ko", { choice: false }));
afterEach(() => {
  cleanup();
  setLocale("ko", { choice: false });
});

it("shows the complete example immediately and can be played, paused and jumped by step", () => {
  render(createElement(HeroFilm));
  expect(document.querySelector(".film-after")!.textContent).toContain("Muxa: tmux");
  fireEvent.click(screen.getByRole("button", { name: "재생" }));
  fireEvent.click(screen.getByRole("button", { name: "일시정지" }));
  expect(screen.getByRole("button", { name: "재생" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "2단계: 소문이 읽은 것" }));
  expect(screen.getByRole("button", { name: "2단계: 소문이 읽은 것" }).getAttribute("aria-current")).toBe("step");
  expect(screen.getByText("muxa attend — 가장 오래 기다린 에이전트로 이동")).toBeTruthy();
});

it("shows the channel's own before and after posts when a channel is picked", () => {
  render(createElement(HeroFilm));
  fireEvent.click(screen.getByRole("tab", { name: "LinkedIn · KO" }));
  fireEvent.click(screen.getByRole("button", { name: "4단계: 근거를 나란히" }));
  expect(screen.getByText(/Muxa는 이미 실행 중인 tmux 세션/)).toBeTruthy();
  expect(screen.getByText("접히기 전 첫 줄에 주제").closest("li")!.className).toBe("on");
});

it("supports keyboard control", () => {
  render(createElement(HeroFilm));
  const film = screen.getByRole("region");
  fireEvent.keyDown(film, { key: " " });
  expect(screen.getByRole("button", { name: "일시정지" })).toBeTruthy();
  fireEvent.keyDown(film, { key: " " });
  expect(screen.getByRole("button", { name: "재생" })).toBeTruthy();
  fireEvent.keyDown(film, { key: "3" });
  expect(screen.getByRole("button", { name: "3단계: 핵심을 남기면" }).getAttribute("aria-current")).toBe("step");
});

it("uses Korean examples in every tab and links the evidence instead of pitching manual posting", () => {
  render(createElement(HeroFilm));
  expect(screen.getByRole("tab", { name: "X · KO" }).getAttribute("aria-selected")).toBe("true");
  for (const tab of ["X · KO", "LinkedIn · KO", "Show GN"]) {
    fireEvent.click(screen.getByRole("tab", { name: tab }));
    fireEvent.click(screen.getByRole("button", { name: "4단계: 근거를 나란히" }));
    expect(document.querySelector(".film-after")!.textContent).toMatch(/Muxa.*tmux/);
    expect(document.querySelector(".film-after")!.textContent).toContain("Unix 계열 운영체제");
    expect(document.querySelector(".film-after")!.textContent).not.toContain("Requires");
  }
  expect(document.querySelector(".film-source")!.getAttribute("href")).toBe("https://github.com/Open330/muxa#readme");
  expect(screen.queryByText(/게시는 직접/)).toBeNull();
});

it("switches example text, evidence and channel labels with the page language", async () => {
  await loadCatalog("en");
  render(createElement(HeroFilm));
  fireEvent.click(screen.getByRole("tab", { name: "Show GN" }));
  fireEvent.click(screen.getByRole("button", { name: "4단계: 근거를 나란히" }));
  act(() => setLocale("en", { choice: false }));
  expect(screen.getByRole("tab", { name: "Show HN" }).getAttribute("aria-selected")).toBe("true");
  expect(document.querySelector(".film-after")!.textContent).toContain("Show HN: Muxa - see which tmux coding agent needs input");
  expect(document.querySelector(".film-evidence")!.textContent).toContain("Requires tmux and a Unix-like OS");
  expect(document.querySelector(".film-after")!.textContent).not.toMatch(/[가-힣]/);
  act(() => setLocale("ko", { choice: false }));
  expect(screen.getByRole("tab", { name: "Show GN" }).getAttribute("aria-selected")).toBe("true");
  expect(document.querySelector(".film-after")!.textContent).toContain("대기 상태 확인");
});

it("changes the actual structure to suit X, LinkedIn and Show GN", () => {
  render(createElement(HeroFilm));
  const post = () => document.querySelector(".film-after")!;
  const text = () => post().textContent!;
  expect(text().split("\n\n")).toHaveLength(3);
  expect([...text()].length).toBeLessThanOrEqual(280);
  expect(text().trim()).toMatch(/https:\/\/github\.com\/Open330\/muxa$/);
  expect(post().querySelector(".film-part-heading")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "LinkedIn · KO" }));
  expect(text().split("\n\n")).toHaveLength(5);
  expect([...text().split("\n")[0]].length).toBeLessThan(40);
  expect(text()).toContain("기존 작업 환경");
  expect(text()).toContain("여러 에이전트");
  expect(post().querySelector(".film-part-heading")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Show GN" }));
  expect([...post().querySelectorAll(".film-part-heading")].map((x) => x.textContent!.trim())).toEqual(["기능", "사용 방법", "사용 조건"]);
  expect(text()).toContain("• 기존 tmux");
  expect(post().querySelector(".film-part-command")!.textContent!.trim()).toBe("muxa attend");
  expect(text()).not.toContain("?");
  expect(screen.getByText("Show GN은 설명형 제목과 기능·사용 방법·조건을 나눠서.")).toBeTruthy();
});
