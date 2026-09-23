import { useSyncExternalStore } from "react";
import { en } from "./en";

/**
 * 화면 언어. 한국어 원문이 키다(gettext 방식): 코드는 t("글감")처럼 원문을 그대로 읽히게 두고,
 * 영어는 en.ts에서 찾는다. 사전에 없으면 원문(한국어)을 보여준다. 누락은 i18n.test.ts가 잡는다.
 *
 * 변수는 {이름}으로 끼운다: t("내 예시 {n}개", { n: 3 }).
 */
export type Locale = "ko" | "en";
export const LOCALES: { id: Locale; label: string }[] = [{ id: "ko", label: "한국어" }, { id: "en", label: "English" }];
const KEY = "somun.locale";

function detect(): Locale {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "ko" || saved === "en") return saved;
  } catch { /* 저장소를 못 쓰는 환경 */ }
  const langs = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  return langs.some((l) => l?.toLowerCase().startsWith("ko")) ? "ko" : "en";
}

let current: Locale = detect();
const listeners = new Set<() => void>();
if (typeof document !== "undefined") document.documentElement.lang = current;

export const getLocale = (): Locale => current;

/** 언어를 바꾼다. 화면은 useLocale을 쓰는 뿌리에서 다시 그린다. */
export function setLocale(next: Locale): void {
  if (next === current) return;
  current = next;
  try { localStorage.setItem(KEY, next); } catch { /* 저장소를 못 쓰는 환경 */ }
  if (typeof document !== "undefined") document.documentElement.lang = next;
  for (const l of listeners) l();
}

export function useLocale(): Locale {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, getLocale, getLocale);
}

export type Vars = Record<string, string | number | undefined | null>;

export function t(ko: string, vars?: Vars): string {
  const template = current === "en" ? en[ko] ?? ko : ko;
  return vars ? template.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k]))) : template;
}

/** 날짜·시간 표기의 언어 태그. */
export const dateLocale = (): string => (current === "en" ? "en-US" : "ko-KR");
