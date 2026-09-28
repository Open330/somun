// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import HeroFilm from "./HeroFilm";

afterEach(cleanup);

it("plays like a video that can be paused and jumped by step", () => {
  render(createElement(HeroFilm));
  fireEvent.click(screen.getByRole("button", { name: "일시정지" }));
  expect(screen.getByRole("button", { name: "재생" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "2단계: 소문이 읽은 것" }));
  expect(screen.getByRole("button", { name: "2단계: 소문이 읽은 것" }).getAttribute("aria-current")).toBe("step");
  expect(screen.getByText("Jump to the pane that waited longest")).toBeTruthy();
});

it("shows the channel's own before and after posts when a channel is picked", () => {
  render(createElement(HeroFilm));
  fireEvent.click(screen.getByRole("button", { name: "일시정지" }));
  fireEvent.click(screen.getByRole("tab", { name: "LinkedIn · KO" }));
  fireEvent.click(screen.getByRole("button", { name: "4단계: 올리는 건 직접" }));
  expect(screen.getByText(/에이전트가 멈춘 걸 30분 뒤에 알았습니다/)).toBeTruthy();
  expect(screen.getByText("접힘선 위에서 멈추게 하는 첫 문장").closest("li")!.className).toBe("on");
});

it("supports keyboard control", () => {
  render(createElement(HeroFilm));
  const film = screen.getByRole("region");
  fireEvent.keyDown(film, { key: " " });
  expect(screen.getByRole("button", { name: "재생" })).toBeTruthy();
  fireEvent.keyDown(film, { key: "3" });
  expect(screen.getByRole("button", { name: "3단계: 소문이 쓰면" }).getAttribute("aria-current")).toBe("step");
});
