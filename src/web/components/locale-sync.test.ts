// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SettingsView } from "@shared/types";
import { DEFAULT_SETTINGS } from "../../app/settings";
import { clearPendingChoice, getLocale, hasPendingChoice, setLocale } from "../i18n";
import { setUnsaved } from "../lib/unsaved";
import { resetLocaleSync, useAccountLocaleSync } from "./LocaleSwitch";

const { patch } = vi.hoisted(() => ({ patch: vi.fn() }));
vi.mock("../lib/api", () => ({ patch }));
const view = (locale?: "ko" | "en") => ({ ...DEFAULT_SETTINGS, ui: locale ? { locale } : undefined, llm: { ...DEFAULT_SETTINGS.llm, apiKeySet: false } }) as SettingsView;

beforeEach(() => { patch.mockReset().mockResolvedValue({}); resetLocaleSync(); setLocale("ko", { choice: false }); clearPendingChoice(); setUnsaved(false); });
afterEach(() => { setLocale("ko", { choice: false }); clearPendingChoice(); });

it("saves a language the user picked, even if the account still says otherwise", async () => {
  setLocale("en"); // 랜딩이나 상단바에서 고름
  renderHook(() => useAccountLocaleSync(view("ko")));
  expect(getLocale()).toBe("en");
  expect(patch).toHaveBeenCalledWith("/settings", { ui: { locale: "en" } });
  await waitFor(() => expect(hasPendingChoice()).toBe(false));
});

it("keeps the pick pending when saving fails, so the next load retries", async () => {
  patch.mockRejectedValue(new Error("offline"));
  setLocale("en");
  renderHook(() => useAccountLocaleSync(view("ko")));
  await Promise.resolve(); await Promise.resolve();
  expect(getLocale()).toBe("en");
  expect(hasPendingChoice()).toBe(true);
});

it("follows the account language once per page load, and not later", () => {
  const { rerender } = renderHook(({ s }) => useAccountLocaleSync(s), { initialProps: { s: view("en") } });
  expect(getLocale()).toBe("en");
  setLocale("ko", { choice: false });
  rerender({ s: { ...view("en") } }); // 나중에 온 설정 이벤트
  expect(getLocale()).toBe("ko");
});

it("does not switch language under unsaved edits", () => {
  setUnsaved(true);
  renderHook(() => useAccountLocaleSync(view("en")));
  expect(getLocale()).toBe("ko");
});

it("stores the current language when the account has none", () => {
  renderHook(() => useAccountLocaleSync(view()));
  expect(patch).toHaveBeenCalledWith("/settings", { ui: { locale: "ko" } });
});
