import { useEffect } from "react";
import type { SettingsView } from "@shared/types";
import { getLocale, LOCALES, setLocale, t, useLocale, type Locale } from "../i18n";
import { patch } from "../lib/api";

/**
 * 화면 언어 선택. 로그인한 뒤에는 계정 설정(ui.locale)에도 저장한다.
 * 서버가 만드는 문장(작업 오류, 판단 이유, 주간 알림)과 모델에게 시키는 설명 언어가 이것을 따른다.
 */
export function LocaleSwitch({ settings, compact }: { settings?: SettingsView; compact?: boolean }) {
  const locale = useLocale();
  // 계정에 언어가 없으면 지금 화면 언어를 저장한다. 다른 기기에서 정한 언어가 있으면 그것을 따른다.
  useEffect(() => {
    if (!settings) return;
    const saved = settings.ui?.locale;
    if (!saved) void patch("/settings", { ui: { locale: getLocale() } }).catch(() => undefined);
    else if (saved !== getLocale()) setLocale(saved);
  }, [settings]);
  const change = (next: Locale) => {
    setLocale(next);
    if (settings) void patch("/settings", { ui: { locale: next } }).catch(() => undefined);
  };
  return (
    <label className={`locale-switch ${compact ? "compact" : ""}`}>
      <span className={compact ? "sr-only" : "small muted"}>{t("화면 언어")}</span>
      <select value={locale} onChange={(ev) => change(ev.target.value as Locale)} aria-label={t("화면 언어")}>
        {LOCALES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
      </select>
    </label>
  );
}
