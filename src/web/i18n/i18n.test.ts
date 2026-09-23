import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHANNELS } from "../../core/channels";
import { SAMPLE_WORK, VOICE_PRESETS } from "../../core/voice";
import { en } from "./en";
import { setLocale, t } from "./index";

const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) && !/\.test\./.test(f) && !p.includes("i18n") ? [p] : []; });
const WEB = files("src/web");
const unescape = (s: string) => JSON.parse(`"${s}"`) as string;
const HANGUL = /[가-힣]/;
/** 화면 언어와 무관하게 그대로여야 하는 것: 한국어 채널 예시 글, 언어 이름, 서버와 맞춘 삭제 확인 단어. */
const ALLOW = [/post: "/, /label: "한국어"/, /const deleteWord = /];

afterEach(() => setLocale("ko"));

describe("English catalog", () => {
  it("has an entry for every t()/tr() key used in the web", () => {
    const keys = WEB.flatMap((f) => [...readFileSync(f, "utf8").matchAll(/(?<![.\w])tr?\("((?:[^"\\]|\\.)*)"/g)].map((m) => unescape(m[1]))).filter((k) => HANGUL.test(k));
    expect(keys.filter((k) => !(k in en))).toEqual([]);
  });

  it("covers channel guides and voice presets shown in the web", () => {
    const shown = [...Object.values(CHANNELS).flatMap((c) => [c.label, c.mediaHint, ...c.runbook]), ...VOICE_PRESETS.flatMap((p) => [p.name, p.description]), SAMPLE_WORK.what, ...SAMPLE_WORK.facts];
    expect(shown.filter((k) => k && HANGUL.test(k) && !(k in en))).toEqual([]);
  });

  it("keeps the same placeholders in every translation", () => {
    const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    expect(Object.entries(en).filter(([k, v]) => names(k).join() !== names(v).join())).toEqual([]);
  });
});

it("leaves no Korean outside t()/tr() in web code (comments and allowed content aside)", () => {
  const leaks: string[] = [];
  for (const f of WEB) readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    const s = line.trim();
    if (s.startsWith("*") || s.startsWith("/*") || s.startsWith("//") || ALLOW.some((re) => re.test(line))) return;
    const code = line.replace(/\/\*.*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/, "$1").replace(/(?<![.\w])tr?\("(?:[^"\\]|\\.)*"/g, "");
    // 모듈 수준 라벨 표는 번역 키다(쓰는 곳에서 t()를 거친다).
    if (/^(export )?const [A-Z_]+|^\s*\["\w+", "/.test(line)) return;
    if (/^const labels:/.test(s)) return;
    if (HANGUL.test(code)) leaks.push(`${f}:${i + 1}: ${s.slice(0, 120)}`);
  });
  expect(leaks).toEqual([]);
});

it("translates with variables and falls back to Korean for unknown keys", () => {
  setLocale("en");
  expect(t("{n}분 전", { n: 5 })).toBe(en["{n}분 전"].replace("{n}", "5"));
  expect(t("사전에 없는 문장")).toBe("사전에 없는 문장");
  setLocale("ko");
  expect(t("{n}분 전", { n: 5 })).toBe("5분 전");
});
