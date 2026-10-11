// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ChannelPresets from "./ChannelPresets";
import { DEFAULT_SETTINGS } from "../../app/settings";
import type { SettingsView } from "../../shared/types";
const settings = { ...DEFAULT_SETTINGS, llm: { ...DEFAULT_SETTINGS.llm, apiKeySet: false } } as SettingsView;
afterEach(cleanup);
it("shows known identities and creates an editable personal channel from Threads", async () => {
  const onSave = vi.fn().mockResolvedValue(true);
  const onDirty = vi.fn();
  render(createElement(ChannelPresets, { settings, onSave, onDirty }));
  expect(screen.getByText("Threads")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "커스텀 채널 추가" }));
  expect((screen.getByLabelText("시작 프리셋") as HTMLSelectElement).value).toBe("threads");
  fireEvent.change(screen.getByLabelText("채널 이름"), { target: { value: "개발 일지" } });
  fireEvent.change(screen.getByLabelText("대상 독자"), { target: { value: "프로젝트 기여자" } });
  fireEvent.change(screen.getByLabelText("최대 문장 수"), { target: { value: "3" } });
  fireEvent.change(screen.getByLabelText("링크 위치"), { target: { value: "body" } });
  fireEvent.click(screen.getByRole("button", { name: "프리셋 저장" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  const patch = onSave.mock.calls[0][0];
  expect(patch.customChannels[0]).toMatchObject({
    label: "개발 일지",
    identity: { audience: "프로젝트 기여자" },
    linkPlacement: "body",
    maxSentences: 3,
  });
  expect(patch.customChannels[0].id).toMatch(/^custom_/);
  expect(patch.customChannels[0]).not.toHaveProperty("fixedLang");
  expect(patch.channelLangs[patch.customChannels[0].id]).toEqual(["ko"]);
  expect(patch.channelLangs.x).toEqual(["ko"]);
  await waitFor(() => expect(screen.queryByLabelText("채널 이름")).toBeNull());
});
it("retains the unsaved preset when saving fails", async () => {
  render(createElement(ChannelPresets, { settings, onSave: vi.fn().mockResolvedValue(false), onDirty: vi.fn() }));
  fireEvent.click(screen.getByRole("button", { name: "커스텀 채널 추가" }));
  fireEvent.change(screen.getByLabelText("채널 이름"), { target: { value: "My notes" } });
  fireEvent.click(screen.getByRole("button", { name: "프리셋 저장" }));
  await waitFor(() => expect((screen.getByLabelText("채널 이름") as HTMLInputElement).value).toBe("My notes"));
});
