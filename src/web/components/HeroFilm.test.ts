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
  expect(document.querySelector(".film-after")!.textContent).toContain("Muxa는 tmux");
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
  expect(screen.getByText(/Muxa는 tmux의 코딩 에이전트가 입력을 기다리는지 보여줍니다/)).toBeTruthy();
  expect(screen.getByText("첫 문장에서 하는 일을").closest("li")!.className).toBe("on");
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
  expect(document.querySelector(".film-after")!.textContent).toContain("Show HN: Muxa — see which tmux coding agent needs input");
  expect(document.querySelector(".film-evidence")!.textContent).toContain("Requires tmux and a Unix-like OS");
  expect(document.querySelector(".film-after")!.textContent).not.toMatch(/[가-힣]/);
  act(() => setLocale("ko", { choice: false }));
  expect(screen.getByRole("tab", { name: "Show GN" }).getAttribute("aria-selected")).toBe("true");
  expect(document.querySelector(".film-after")!.textContent).toContain("입력을 기다리는");
});
