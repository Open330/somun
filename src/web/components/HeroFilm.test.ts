// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import HeroFilm from "./HeroFilm";

afterEach(cleanup);

it("plays as a video that can be paused and jumped by chapter", () => {
  render(createElement(HeroFilm));
  fireEvent.click(screen.getByRole("button", { name: "일시정지" }));
  expect(screen.getByRole("button", { name: "재생" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "3장: 판단" }));
  expect(screen.getByText("다섯 기준으로 점수를 매기고 이유를 남깁니다")).toBeTruthy();
  expect(screen.getByRole("slider", { name: "재생 위치" }).getAttribute("aria-valuetext")).toBe("0:07 · 판단");
});

it("shows the whole post of a channel the viewer picks and pauses there", () => {
  render(createElement(HeroFilm));
  fireEvent.click(screen.getByRole("button", { name: "4장: 초안" }));
  fireEvent.click(screen.getByRole("tab", { name: "LinkedIn · KO" }));
  expect(screen.getByText(/그래서 muxa를 만들었습니다/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "재생" })).toBeTruthy();
});

it("supports keyboard control", () => {
  render(createElement(HeroFilm));
  const film = screen.getByRole("region");
  fireEvent.keyDown(film, { key: " " });
  expect(screen.getByRole("button", { name: "재생" })).toBeTruthy();
  fireEvent.keyDown(film, { key: "2" });
  expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("0:03 · 추리기");
});
