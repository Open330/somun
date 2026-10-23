import { expect, it } from "vitest";
import { channelSpec } from "./channels.js";
import { lintDraft } from "./lint.js";
import { postLength } from "./post-length.js";

it("counts X Korean, mixed text, NFC and emoji sequences with the official weights", () => {
  expect(postLength("x", "한A")).toBe(3);
  expect(postLength("x", "가".repeat(140))).toBe(280);
  expect(postLength("x", "가".repeat(141))).toBe(282);
  expect(postLength("x", "가".normalize("NFD"))).toBe(2);
  expect(postLength("x", "café".normalize("NFD"))).toBe(4);
  expect(postLength("x", "👨‍👩‍👧‍👦👩🏽‍💻")).toBe(4);
});

it("counts long, short and bare URLs as 23 without swallowing punctuation", () => {
  expect(postLength("x", "https://example.com/" + "a".repeat(300))).toBe(23);
  expect(postLength("x", "한 https://example.com")).toBe(26);
  expect(postLength("x", "example.com")).toBe(23);
  expect(postLength("x", "https://example.com.")).toBe(24);
});

it("uses the configured X limit and keeps other channels' existing code-point counts", () => {
  const body = "가".repeat(141);
  expect(lintDraft("x", undefined, body).find(r => r.rule === "length")).toMatchObject({ ok: false, detail: "282/280" });
  expect(lintDraft("x", undefined, body, [], {}, "ko", { ...channelSpec("x"), maxChars: 300 }).find(r => r.rule === "length")).toMatchObject({ ok: true, detail: "282/300" });
  expect(postLength("threads", body)).toBe(141);
  expect(postLength("custom_note", "café".normalize("NFD"))).toBe(5);
});
