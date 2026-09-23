// @vitest-environment jsdom
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import NotFound from "./NotFound";

afterEach(cleanup);
it.each([["글감", "글감을 찾을 수 없습니다"], ["페이지", "페이지를 찾을 수 없습니다"]])("uses the right particle for %s", (what, text) => {
  render(createElement(MemoryRouter, null, createElement(NotFound, { what })));
  expect(screen.getByText(text)).toBeTruthy();
});
